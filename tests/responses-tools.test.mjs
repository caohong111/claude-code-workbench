import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { createWorkspaceTools } from '../electron/responses-tools.mjs';

async function fixture(t, options = {}) {
  const parent = TEST_ROOT;
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'responses-tools-'));
  const cwd = path.join(directory, 'workspace');
  await fs.mkdir(cwd);
  const events = [];
  const permissions = [];
  const tools = createWorkspaceTools({ cwd, onEvent: event => { events.push(structuredClone(event)); },
    requestPermission: async value => { permissions.push(value); return { behavior: 'allow' }; }, ...options });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, cwd, tools, events, permissions };
}

test('reads lines, searches text and globs paths within the chosen workspace', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.cwd, 'src'));
  await fs.writeFile(path.join(f.cwd, 'src', 'hello.js'), 'first\nTarget line\nthird\n');
  const read = await f.tools.execute('Read', { file_path: 'src/hello.js', offset: 2, limit: 1 });
  assert.equal(read.isError, false); assert.match(read.output, /^2: Target line/);
  const found = await f.tools.execute('Grep', { pattern: 'TARGET' });
  assert.match(found.output, /src\/hello.js:2: Target line/);
  const matches = await f.tools.execute('Glob', { pattern: '**/*.js' });
  assert.equal(matches.output, 'src/hello.js');
  assert.equal(f.permissions.length, 0);
  assert.deepEqual(f.events.filter(event => event.type === 'tool').map(event => event.tool.status), ['running', 'done', 'running', 'done', 'running', 'done']);
});

test('rejects paths, patterns and junctions escaping the opened workspace', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'MUST_NOT_READ');
  await fs.symlink(outside, path.join(f.cwd, 'external'), 'junction');
  for (const [name, args] of [
    ['Read', { file_path: '../outside/secret.txt' }], ['Read', { file_path: 'external/secret.txt' }],
    ['Write', { file_path: 'external/new.txt', content: 'NO' }], ['Glob', { pattern: '../outside/*' }],
    ['Grep', { pattern: 'MUST_NOT_READ', path: 'external' }],
  ]) assert.equal((await f.tools.execute(name, args)).isError, true);
  assert.equal((await f.tools.execute('Glob', {})).output.includes('secret.txt'), false);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'MUST_NOT_READ');
  assert.equal(f.permissions.length, 0);
});

test('manual file changes require confirmation and emit a baseline before writing', async t => {
  let contentsAtBaseline;
  const f = await fixture(t, { onEvent: async event => {
    if (event.type === 'beforeTool') contentsAtBaseline = await fs.readFile(event.input.file_path, 'utf8').catch(() => null);
  } });
  await fs.writeFile(path.join(f.cwd, 'note.txt'), 'Original');
  const written = await f.tools.execute('Write', { file_path: 'note.txt', content: 'New text' });
  assert.equal(written.isError, false); assert.equal(contentsAtBaseline, 'Original');
  assert.equal(await fs.readFile(path.join(f.cwd, 'note.txt'), 'utf8'), 'New text');
  assert.equal(f.permissions[0].toolName, 'Write');
  const edited = await f.tools.execute('Edit', { file_path: 'note.txt', old_string: 'New', new_string: 'Edited' });
  assert.equal(edited.isError, false); assert.equal(contentsAtBaseline, 'New text');
  assert.equal(await fs.readFile(path.join(f.cwd, 'note.txt'), 'utf8'), 'Edited text');
});

test('rejected, ambiguous or invalid edits preserve original data and temporary files', async t => {
  const f = await fixture(t, { requestPermission: async () => ({ behavior: 'deny' }) });
  await fs.writeFile(path.join(f.cwd, 'repeat.txt'), 'same same');
  assert.equal((await f.tools.execute('Write', { file_path: 'repeat.txt', content: 'replacement' })).isError, true);
  assert.equal((await f.tools.execute('Edit', { file_path: 'repeat.txt', old_string: 'same', new_string: 'changed' })).isError, true);
  assert.equal((await f.tools.execute('Edit', { file_path: 'repeat.txt', old_string: 'absent', new_string: 'changed' })).isError, true);
  assert.equal(await fs.readFile(path.join(f.cwd, 'repeat.txt'), 'utf8'), 'same same');
  assert.deepEqual(await fs.readdir(f.cwd), ['repeat.txt']);
});

test('changes made while approval is pending are preserved', async t => {
  let file;
  const f = await fixture(t, { requestPermission: async () => {
    await fs.writeFile(file, 'Changed independently while waiting');
    return { behavior: 'allow' };
  } });
  file = path.join(f.cwd, 'note.txt');
  await fs.writeFile(file, 'Original');
  const result = await f.tools.execute('Edit', { file_path: 'note.txt', old_string: 'Original', new_string: 'Overwrite' });
  assert.equal(result.isError, true); assert.match(result.output, /发生变化/);
  assert.equal(await fs.readFile(file, 'utf8'), 'Changed independently while waiting');
  assert.deepEqual(await fs.readdir(f.cwd), ['note.txt']);
});

test('plan mode exposes only read tools and questions, and cannot mutate through hidden tools', async t => {
  const f = await fixture(t, { permissionMode: 'plan' });
  assert.deepEqual(f.tools.definitions.map(tool => tool.name), ['Read', 'Glob', 'Grep', 'AskUserQuestion']);
  assert.equal((await f.tools.execute('Write', { file_path: 'new.txt', content: 'NO' })).isError, true);
  assert.equal((await f.tools.execute('Bash', { command: 'Write-Output NO' })).isError, true);
  assert.equal(f.permissions.length, 0); assert.deepEqual(await fs.readdir(f.cwd), []);
});

test('accepted workspace edits skip confirmation, require exact text and redact tool results', async t => {
  const f = await fixture(t, { permissionMode: 'acceptEdits', redact: value => value.replaceAll('PRIVATE', '[hidden]') });
  await f.tools.execute('Write', { file_path: 'sample.txt', content: 'PRIVATE same same' });
  const changed = await f.tools.execute('Edit', { file_path: 'sample.txt', old_string: 'same', new_string: 'changed', replace_all: true });
  assert.equal(changed.isError, false);
  assert.equal(await fs.readFile(path.join(f.cwd, 'sample.txt'), 'utf8'), 'PRIVATE changed changed');
  const read = await f.tools.execute('Read', { file_path: 'sample.txt' });
  assert.match(read.output, /\[hidden\] changed changed/);
  assert.equal(JSON.stringify(f.events).includes('PRIVATE'), false); assert.equal(f.permissions.length, 0);
});

test('question answers return through the workbench approval dialog', async t => {
  const questions = [{ question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Green' }] }];
  const f = await fixture(t, { requestPermission: async value => {
    assert.equal(value.toolName, 'AskUserQuestion'); assert.deepEqual(value.input.questions, questions);
    return { behavior: 'allow', updatedInput: { answers: { 'Which color?': 'Green' } } };
  } });
  const answer = await f.tools.execute('AskUserQuestion', { questions });
  assert.equal(answer.isError, false); assert.deepEqual(JSON.parse(answer.output), { 'Which color?': 'Green' });
});

test('PowerShell commands always require approval and stop on cancellation', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { permissionMode: 'auto', signal: controller.signal });
  const output = await f.tools.execute('Bash', { command: 'Write-Output "WORKBENCH_LOCAL_OK 中文"', timeout_ms: 10000 });
  assert.equal(output.isError, false); assert.match(output.output, /WORKBENCH_LOCAL_OK 中文/);
  assert.equal(f.permissions[0].toolName, 'Bash'); assert.equal(f.permissions[0].input.cwd, f.cwd);
  const started = Date.now();
  const pending = f.tools.execute('Bash', { command: 'Start-Sleep -Seconds 30', timeout_ms: 120000 });
  setTimeout(() => controller.abort(), 500);
  const stopped = await pending;
  assert.equal(stopped.isError, true); assert.match(stopped.output, /已停止/);
  assert.ok(Date.now() - started < 10000, 'Cancelled command must finish promptly');
});

test('bounds text reads and refuses binary input without altering it', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'large.txt'), 'A'.repeat(1100000));
  await fs.writeFile(path.join(f.cwd, 'binary.bin'), Buffer.from([1, 0, 2]));
  const large = await f.tools.execute('Read', { file_path: 'large.txt' });
  assert.ok(large.output.length <= 160000);
  assert.match(large.output, /输出已截断/);
  assert.equal((await f.tools.execute('Read', { file_path: 'binary.bin' })).isError, true);
  assert.equal((await f.tools.execute('Edit', { file_path: 'large.txt', old_string: 'A', new_string: 'B', replace_all: true })).isError, true);
  assert.equal((await fs.stat(path.join(f.cwd, 'large.txt'))).size, 1100000);
});
