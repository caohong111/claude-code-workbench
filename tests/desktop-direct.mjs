import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const isolated = path.join(TEST_ROOT, `desktop-direct-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const stateDirectory = path.join(isolated, 'state');
const credential = 'fixture-direct-private-token';
const requests = [];
const serverErrors = [];
let heldStream;
let heldStreamClosed = false;
const textItem = text => ({ type: 'message', id: randomUUID(), role: 'assistant', content: [{ type: 'output_text', text }] });
const functionItem = (name, args, callId) => ({ type: 'function_call', id: randomUUID(), call_id: callId, name, arguments: JSON.stringify(args) });
function event(response, value) { response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`); }
function complete(response, output, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  if (text) event(response, { type: 'response.output_text.delta', item_id: output[0].id, delta: text });
  event(response, { type: 'response.completed', response: { id: randomUUID(), status: 'completed', output, usage: { input_tokens: 50, output_tokens: 12 } } });
  response.end();
}
const modelServer = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && pathname.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-fixture-code', display_name: 'GPT Direct Fixture' }], has_more: false }));
      return;
    }
    assert.equal(request.method, 'POST');
    assert.ok(['/responses', '/v1/responses'].includes(pathname), `Unexpected path: ${pathname}`);
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    assert.equal(body.model, 'gpt-fixture-code');
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.previous_response_id, undefined, 'History must not depend on provider-side storage');
    assert.equal(JSON.stringify(body).includes(credential), false, 'Credentials belong in headers only');
    const input = body.input || [];
    const lastUserIndex = input.findLastIndex(item => item.role === 'user');
    const current = JSON.stringify(input[lastUserIndex]);
    const turnInput = input.slice(lastUserIndex + 1);
    if (current.includes('DIRECT_LIST')) {
      const output = turnInput.find(item => item.type === 'function_call_output' && item.call_id === 'fixture-glob');
      if (!output) complete(response, [functionItem('Glob', { pattern: '*' }, 'fixture-glob')]);
      else {
        assert.match(output.output, /README\.md/);
        assert.match(output.output, /notes\.txt/);
        complete(response, [textItem('DIRECT_LIST_OK: README.md, notes.txt')], 'DIRECT_LIST_OK: README.md, notes.txt');
      }
    } else if (current.includes('DIRECT_FOLLOWUP')) {
      assert.match(JSON.stringify(input.slice(0, lastUserIndex)), /DIRECT_LIST_OK/);
      assert.ok(input.some(item => item.type === 'function_call_output' && item.call_id === 'fixture-glob'));
      complete(response, [textItem('DIRECT_FOLLOWUP_OK')], 'DIRECT_FOLLOWUP_OK');
    } else if (current.includes('DIRECT_WRITE')) {
      const output = turnInput.find(item => item.type === 'function_call_output' && item.call_id === 'fixture-write');
      if (!output) complete(response, [functionItem('Write', { file_path: 'approved.txt', content: 'APPROVED_DIRECT_WRITE' }, 'fixture-write')]);
      else {
        assert.equal(await fs.readFile(path.join(workspace, 'approved.txt'), 'utf8'), 'APPROVED_DIRECT_WRITE');
        complete(response, [textItem('DIRECT_WRITE_OK')], 'DIRECT_WRITE_OK');
      }
    } else if (current.includes('DIRECT_FAIL')) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Fixture upstream failed: ${credential}` } }));
    } else if (current.includes('DIRECT_STOP')) {
      heldStream = response;
      response.on('close', () => { heldStreamClosed = true; });
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      event(response, { type: 'response.created', response: { id: 'fixture-held-stream', status: 'in_progress', output: [] } });
    } else throw new Error(`Unexpected fixture task: ${current}`);
  } catch (error) {
    serverErrors.push(error.message);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fixture request validation failed' } }));
  }
});

await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(configDirectory, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# Direct panel fixture\n');
await fs.writeFile(path.join(workspace, 'notes.txt'), 'Known fixture entry\n');
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelServer.address().port}`, ANTHROPIC_AUTH_TOKEN: credential,
} }));
const env = {
  ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory,
  CLAUDE_PANEL_DATA_DIR: stateDirectory, CODEX_CLI_PATH: path.join(isolated, 'missing-codex.exe'),
  PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  Path: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  TEMP: TEST_ROOT, TMP: TEST_ROOT,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_HOME;
let application;
const rendererErrors = [];
try {
  application = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env, timeout: 30000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, workspace);
  await page.evaluate(() => window.claudePanel.openWorkspace());
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  const unspecified = await page.evaluate(async () => {
    try { await window.claudePanel.sendMessage({ text: 'A model must be selected first.' }); return null; }
    catch (error) { return error.message; }
  });
  assert.match(unspecified, /选择.*模型/);
  assert.equal(requests.length, 0, 'An unspecified GPT-channel model must not fall through to Claude');
  assert.equal((await page.evaluate(() => window.claudePanel.getState())).session.messages.length, 0);
  await page.evaluate(() => window.claudePanel.clearError());
  await page.evaluate(() => window.claudePanel.savePreferences({ model: 'gpt-fixture-code', permissionMode: 'manual', effort: 'low' }));
  const snapshot = () => page.evaluate(() => window.claudePanel.getState());
  async function start(text) {
    await page.getByRole('textbox', { name: '输入任务', exact: true }).fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
  }
  async function finished() {
    await page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
    await page.locator('.run-status').waitFor({ state: 'hidden' });
    return snapshot();
  }
  await start('DIRECT_LIST: list this folder using the file tool.');
  const listed = await finished();
  assert.equal(listed.error, null);
  assert.match(listed.session.messages.at(-1).text, /DIRECT_LIST_OK/);
  assert.match(listed.session.directResponsesSessionId, /^direct-/);
  assert.ok(listed.session.tools.some(tool => tool.name === 'Glob' && tool.status === 'done'));
  assert.equal(JSON.stringify(listed).includes(credential), false);
  const directSessionId = listed.session.directResponsesSessionId;
  await page.locator('.message-assistant').last().getByText('DIRECT_LIST_OK: README.md, notes.txt', { exact: true }).waitFor();

  await start('DIRECT_FOLLOWUP: continue the existing conversation.');
  const continued = await finished();
  assert.equal(continued.error, null);
  assert.match(continued.session.messages.at(-1).text, /DIRECT_FOLLOWUP_OK/);
  assert.equal(continued.session.directResponsesSessionId, directSessionId);

  await start('DIRECT_WRITE: create approved.txt after permission.');
  await page.locator('.permission-modal').waitFor();
  const waiting = await snapshot();
  assert.equal(waiting.run.status, 'waiting');
  assert.equal(waiting.permission.toolName, 'Write');
  assert.equal(await fs.access(path.join(workspace, 'approved.txt')).then(() => true, () => false), false, 'Write must wait for user approval');
  await page.locator('.permission-modal').getByRole('button', { name: '允许一次', exact: true }).click();
  const written = await finished();
  assert.equal(written.error, null);
  assert.match(written.session.messages.at(-1).text, /DIRECT_WRITE_OK/);
  assert.equal(await fs.readFile(path.join(workspace, 'approved.txt'), 'utf8'), 'APPROVED_DIRECT_WRITE');
  assert.ok(written.session.changes.some(change => change.path === 'approved.txt' && change.status === 'added'));

  await start('DIRECT_FAIL: exercise the failure state.');
  const failed = await finished();
  assert.ok(failed.error, 'HTTP failure must have a visible error');
  assert.ok(failed.session.messages.at(-1).text.trim(), 'HTTP failure must not leave an empty assistant message');
  assert.equal(JSON.stringify(failed).includes(credential), false);
  await page.locator('.message-assistant').last().locator('.message-body').filter({ hasText: /\S/ }).waitFor();
  await page.evaluate(() => window.claudePanel.clearError());

  await start('DIRECT_STOP: keep streaming until I stop.');
  await page.waitForFunction(async () => Boolean((await window.claudePanel.getState()).run));
  for (let attempt = 0; !heldStream && attempt < 100; attempt++) await page.waitForTimeout(20);
  assert.ok(heldStream, 'The direct HTTP stream must have started');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const stopped = await finished();
  assert.equal(stopped.permission, null);
  assert.equal(stopped.run, null);
  for (let attempt = 0; !heldStreamClosed && attempt < 100; attempt++) await page.waitForTimeout(20);
  assert.equal(heldStreamClosed, true, 'Stopping must abort the active HTTP stream');
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(rendererErrors, []);
  assert.equal(requests.length, 7, 'Direct requests must not retry or require an external Codex process');
  console.log('Electron direct Responses integration passed: real HTTP routing without Codex, folder tools, resumed history, manual write confirmation and changes, visible failures, and stop cancellation.');
} finally {
  if (application) await application.close();
  heldStream?.end();
  modelServer.closeAllConnections();
  await new Promise(resolve => modelServer.close(resolve));
}
