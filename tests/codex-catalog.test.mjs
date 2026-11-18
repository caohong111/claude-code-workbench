import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readCodexCatalog } from '../electron/codex-catalog.mjs';

async function fixture(t, handle) {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, 'codex-catalog-tests-'));
  const executablePath = path.join(directory, 'codex.exe');
  await fs.writeFile(executablePath, 'fixture');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const messages = [];
  const children = [];
  const spawnImpl = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(data, _encoding, done) {
      const message = JSON.parse(data.toString());
      messages.push(message);
      queueMicrotask(() => {
        if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        else if (message.id) handle(child, message);
      });
      done();
    } });
    child.kill = () => {
      if (child.exitCode !== null) return false;
      queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); });
      return true;
    };
    children.push(child);
    return child;
  };
  const read = options => readCodexCatalog({ baseUrl: 'https://fixture.invalid', directory, executablePath, spawnImpl, ...options });
  return { directory, executablePath, calls, messages, children, read };
}

const respond = (child, message, result) => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);

test('reads picker IDs through only allowed RPCs without sharing user credentials or configuration', async t => {
  const f = await fixture(t, (child, message) => respond(child, message, { data: [{ model: 'provider-model', displayName: 'Provider Model' }, { id: 'other-model' }, { model: 'provider-model' }, null], nextCursor: null }));
  const models = await f.read();
  assert.deepEqual(models, [{ id: 'provider-model', displayName: 'Provider Model' }, { id: 'other-model', displayName: 'other-model' }]);
  assert.deepEqual(f.messages.map(message => message.method), ['initialize', 'initialized', 'model/list']);
  const { executable, args, options } = f.calls[0];
  assert.equal(executable, f.executablePath);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, f.directory);
  assert.equal(path.dirname(options.env.CODEX_HOME), f.directory);
  assert.equal(options.env.USERPROFILE, options.env.CODEX_HOME);
  assert.ok(args.includes('cli_auth_credentials_store="file"'));
  assert.ok(args.includes('model_providers.custom.base_url="https://fixture.invalid"'));
  assert.equal(Object.keys(options.env).some(name => /token|api.?key|auth/i.test(name)), false);
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(await fs.access(options.env.CODEX_HOME).then(() => true, () => false), false);
});

test('paginates, keeps display names and rejects a repeated cursor instead of truncating', async t => {
  const f = await fixture(t, (child, message) => respond(child, message, message.params.cursor
    ? { data: [{ model: 'second' }], nextCursor: null }
    : { data: [{ model: 'first' }], nextCursor: 'page-two' }));
  assert.deepEqual((await f.read()).map(model => model.id), ['first', 'second']);
  assert.equal(f.messages.at(-1).params.cursor, 'page-two');
  const loop = await fixture(t, (child, message) => respond(child, message, { data: [{ model: 'repeated' }], nextCursor: 'same-cursor' }));
  assert.deepEqual(await loop.read(), []);
  assert.equal(loop.messages.filter(message => message.method === 'model/list').length, 2);
});

test('decodes model names across UTF-8 chunks and bounds pagination', async t => {
  const f = await fixture(t, (child, message) => {
    const bytes = Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [{ model: 'fixture-model', displayName: '模型' }], nextCursor: null } })}\n`);
    const split = bytes.indexOf(Buffer.from('模型')) + 1;
    child.stdout.write(bytes.subarray(0, split));
    child.stdout.write(bytes.subarray(split));
  });
  assert.equal((await f.read())[0].displayName, '模型');
  let pages = 0;
  const excessive = await fixture(t, (child, message) => respond(child, message, { data: [{ model: `fixture-${++pages}` }], nextCursor: `page-${pages}` }));
  assert.deepEqual(await excessive.read(), []);
  assert.equal(pages, 20);
});

test('does not echo CLI errors or malformed output into the renderer', async t => {
  for (const handle of [
    (child, message) => child.stdout.write(`${JSON.stringify({ id: message.id, error: { message: 'fixture-private-secret' } })}\n`),
    child => child.stdout.write('fixture-private-secret\n'),
    (child, message) => respond(child, message, { data: 'fixture-private-secret' }),
    child => child.stderr.write('fixture-private-secret'.repeat(250000)),
  ]) {
    const f = await fixture(t, handle);
    assert.deepEqual(await f.read(), []);
    assert.equal(f.children[0].exitCode, 0);
  }
});

test('cancellation closes the process and discards partial models', async t => {
  const controller = new AbortController();
  const f = await fixture(t, () => controller.abort());
  assert.deepEqual(await f.read({ signal: controller.signal }), []);
  assert.equal(f.children[0].exitCode, 0);
  const before = f.calls.length;
  assert.deepEqual(await f.read({ signal: controller.signal }), []);
  assert.equal(f.calls.length, before);
});

test('ends a stalled reader after eight seconds and waits for process exit', async t => {
  let listed;
  const started = new Promise(resolve => { listed = resolve; });
  const f = await fixture(t, listed);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = f.read();
  await started;
  t.mock.timers.tick(8000);
  assert.deepEqual(await reading, []);
  assert.equal(f.children[0].exitCode, 0);
});

test('validates endpoints and requires an installed absolute executable', async t => {
  const f = await fixture(t, () => assert.fail('No process should start'));
  for (const baseUrl of ['invalid', 'https://user:secret@fixture.invalid', 'https://fixture.invalid?secret=value']) {
    assert.deepEqual(await f.read({ baseUrl }), []);
  }
  assert.deepEqual(await f.read({ executablePath: 'codex.exe' }), []);
  assert.deepEqual(await f.read({ executablePath: path.join(f.directory, 'missing', 'codex.exe') }), []);
  assert.equal(f.calls.length, 0);
});
