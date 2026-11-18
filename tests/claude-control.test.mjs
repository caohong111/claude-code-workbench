import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { runClaudeControl } from '../electron/claude-control.mjs';
import { TEST_ROOT } from './test-paths.mjs';

const { locateClaude } = createRequire(import.meta.url)('../electron/runtime-paths.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, 'claude-control-'));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-private-control-token' } }));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return { cwd: directory, executablePath: path.join(directory, 'not-launched.exe'), configDirectory: directory, tempDirectory: directory, cacheDirectory: directory };
}

test('reload uses real SDK control without yielding a model prompt or keeping a session', async t => {
  const options = await fixture(t);
  let iterator;
  let closed = false;
  let reloads = 0;
  const result = await runClaudeControl({ ...options, id: 'reload-skills', queryFactory: ({ prompt, options: queryOptions }) => {
    iterator = prompt[Symbol.asyncIterator]();
    assert.equal(queryOptions.persistSession, false);
    assert.deepEqual(queryOptions.settings, { disableAllHooks: true });
    assert.equal(queryOptions.strictMcpConfig, true);
    return { reloadSkills: async () => { reloads++; return { skills: [{ name: 'fixture-skill' }] }; }, close: () => { closed = true; } };
  } });
  assert.equal(reloads, 1);
  assert.match(result.content, /fixture-skill/);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(closed, true);
});

test('MCP reconnect returns observed state and tool counts while excluding config secrets', async t => {
  const options = await fixture(t);
  const calls = [];
  const result = await runClaudeControl({ ...options, id: 'mcp', action: 'reconnect', name: 'fixture', queryFactory: () => ({
    reconnectMcpServer: async name => calls.push(name),
    mcpServerStatus: async () => [{ name: 'fixture', status: 'connected', tools: [{ name: 'fixture-tool' }], config: { headers: { Authorization: 'fixture-private-control-token' } } }, { name: 'failed', status: 'failed', error: 'fixture-private-control-token' }],
    close: () => {},
  }) });
  assert.deepEqual(calls, ['fixture']);
  assert.equal(result.statuses[0].toolCount, 1);
  assert.equal(Object.hasOwn(result.statuses[0], 'config'), false);
  assert.equal(JSON.stringify(result).includes('fixture-private-control-token'), false);
});

test('plugin validation uses the public cache-impact option and reports held reloads', async t => {
  const options = await fixture(t);
  let request;
  const result = await runClaudeControl({ ...options, id: 'reload-plugins', queryFactory: () => ({
    reloadPlugins: async values => { request = values; return { held: true, plugins: [], commands: [], agents: [], mcpServers: [], error_count: 0 }; },
    close() {},
  }) });
  assert.deepEqual(request, { holdOnCacheImpact: true });
  assert.match(result.content, /未应用重新加载/);
  assert.match(result.content, /临时会话检查/);
});

test('Chrome rejects setup-token authentication before starting its SDK transport', async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.configDirectory, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-private-setup-token' } }));
  let started = false;
  const result = await runClaudeControl({ ...options, id: 'chrome', queryFactory: () => { started = true; throw new Error('must not start'); } });
  assert.equal(started, false);
  assert.deepEqual(result.statuses, []);
  assert.match(result.message, /长期令牌/);
  assert.equal(JSON.stringify(result).includes('fixture-private-setup-token'), false);
});

test('a stalled control is cancelled and closes the SDK transport', async t => {
  const options = await fixture(t);
  let closed = false;
  await assert.rejects(runClaudeControl({ ...options, id: 'reload-plugins', timeoutMs: 15, queryFactory: () => ({ reloadPlugins: () => new Promise(() => {}), close: () => { closed = true; } }) }), /取消或超时/);
  assert.equal(closed, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runClaudeControl({ ...options, id: 'mcp', signal: controller.signal }), /已取消/);
});

test('installed Claude reloads skills and plugins using controls without a generation request', async t => {
  const { executablePath } = locateClaude();
  if (process.platform !== 'win32' || !executablePath) return t.skip('Native Windows Claude CLI or SDK binary unavailable');
  const options = await fixture(t);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [], has_more: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await fs.writeFile(path.join(options.configDirectory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-private-control-token', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` } }));
  await fs.access(executablePath);
  const skillDirectory = path.join(options.configDirectory, 'skills', 'control-fixture');
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), '---\nname: control-fixture\ndescription: isolated reload fixture\n---\n\nReturn local fixture details.\n');
  const skills = await runClaudeControl({ ...options, executablePath, id: 'reload-skills' });
  assert.match(skills.content, /control-fixture/);
  const plugins = await runClaudeControl({ ...options, executablePath, id: 'reload-plugins' });
  assert.match(plugins.content, /已检查插件加载/);
  assert.equal(requests.some(request => request.method === 'POST'), false, JSON.stringify(requests));
});
