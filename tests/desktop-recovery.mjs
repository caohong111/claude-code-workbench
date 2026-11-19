import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const isolated = path.join(root, 'tests', '.tmp', `desktop-recovery-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const pendingAttachment = path.join(workspace, 'pending-attachment.txt');
const submittedAttachment = path.join(workspace, 'submitted-attachment.txt');
const requests = [];
const serverErrors = [];
let brokenStream;
let application;
const partialText = 'RECOVERY_PARTIAL: completed inspection before the connection broke.';
const event = (response, value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
function complete(response, output) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  event(response, { type: 'response.completed', response: { status: 'completed', output } });
  response.end();
}
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && new URL(request.url, 'http://localhost').pathname.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-recovery-fixture' }], has_more: false }));
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    const lastUser = body.input.findLastIndex(item => item.role === 'user');
    const current = JSON.stringify(body.input[lastUser]);
    assert.equal(current.includes('INITIAL_SAVE_FAIL'), false, 'A failed initialization must not reach the paid endpoint');
    if (current.includes('REUSED_FIRST') || current.includes('DELAYED_SECOND')) {
      const marker = current.includes('REUSED_FIRST') ? 'REUSED_FIRST' : 'DELAYED_SECOND';
      const file = marker === 'REUSED_FIRST' ? 'first-reused-tool.txt' : 'second-reused-tool.txt';
      const output = body.input.slice(lastUser + 1).find(item => item.type === 'function_call_output' && item.call_id === 'reused-tool-call');
      if (!output) complete(response, [{ type: 'function_call', id: 'reused-provider-id', call_id: 'reused-tool-call', name: 'Write', arguments: JSON.stringify({ file_path: file, content: marker }) }]);
      else {
        assert.equal(await fs.readFile(path.join(workspace, file), 'utf8'), marker);
        complete(response, [{ type: 'message', id: `${marker}-answer`, role: 'assistant', content: [{ type: 'output_text', text: `${marker}_DONE` }] }]);
      }
      return;
    }
    if (current.includes('RECOVERY_FAIL')) {
      brokenStream = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      event(response, { type: 'response.output_text.delta', item_id: 'partial-message', delta: partialText });
      return;
    }
    assert.match(current, /从刚才中断处继续/);
    assert.match(JSON.stringify(body.input.slice(0, lastUser)), /RECOVERY_PARTIAL/);
    assert.equal(current.includes('LOCAL_DRAFT_MUST_SURVIVE'), false);
    assert.equal(current.includes('pending-attachment.txt'), false, 'Continue must not submit a pending attachment');
    const progress = body.input.slice(lastUser + 1).find(item => item.type === 'message' && item.phase === 'commentary' && JSON.stringify(item).includes('RECOVERY_PROGRESS'));
    if (!progress) {
      complete(response, [{ type: 'message', id: 'recovery-progress', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'RECOVERY_PROGRESS: continuing the requested task.' }] }]);
      return;
    }
    const output = body.input.slice(lastUser + 1).find(item => item.type === 'function_call_output' && item.call_id === 'recovery-write');
    if (!output) complete(response, [{ type: 'function_call', id: 'recovery-call', call_id: 'recovery-write', name: 'Write', arguments: JSON.stringify({ file_path: 'recovered.txt', content: 'RECOVERY_WRITTEN' }) }]);
    else {
      assert.equal(await fs.readFile(path.join(workspace, 'recovered.txt'), 'utf8'), 'RECOVERY_WRITTEN');
      complete(response, [{ type: 'message', id: 'recovery-answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'RECOVERY_CONTINUED' }] }]);
    }
  } catch (error) {
    serverErrors.push(error.message);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Recovery fixture validation failed' } }));
  }
});

await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(configDirectory, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# Isolated recovery fixture\n');
await fs.writeFile(pendingAttachment, 'PENDING_ATTACHMENT_MUST_SURVIVE_CONTINUE');
await fs.writeFile(submittedAttachment, 'SUBMITTED_ATTACHMENT_FOR_DELAYED_SEND');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'fixture-recovery-private-token',
} }));
const env = { ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory, CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'), TEMP: isolated, TMP: isolated };
delete env.ELECTRON_RUN_AS_NODE;
const rendererErrors = [];
try {
  application = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], env, timeout: 30000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();
  await application.evaluate(({ dialog }, { directory, modulePath }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    const Store = process.mainModule.require(modulePath).WorkspaceStore;
    const save = Store.prototype.save;
    globalThis.__recoverySaveFailed = false;
    globalThis.__recoveryInitFailNext = false;
    globalThis.__recoveryInitFailed = false;
    globalThis.__recoveryDelayNext = false;
    globalThis.__recoveryInitializationHeld = false;
    Store.prototype.save = function () {
      if (globalThis.__recoveryInitFailNext && this.currentSession?.messages.at(-1)?.status === 'running') {
        globalThis.__recoveryInitFailNext = false;
        globalThis.__recoveryInitFailed = true;
        return Promise.reject(new Error('Fixture initial persistence failure'));
      }
      if (globalThis.__recoveryDelayNext && this.currentSession?.messages.at(-1)?.status === 'running') {
        globalThis.__recoveryDelayNext = false;
        globalThis.__recoveryInitializationHeld = true;
        return new Promise((resolve, reject) => {
          globalThis.__recoveryReleaseInitialization = () => {
            globalThis.__recoveryInitializationHeld = false;
            save.call(this).then(resolve, reject);
          };
        });
      }
      if (!globalThis.__recoverySaveFailed && this.currentSession?.messages.at(-1)?.status === 'interrupted') {
        globalThis.__recoverySaveFailed = true;
        return Promise.reject(new Error('Fixture terminal persistence failure'));
      }
      return save.call(this);
    };
  }, { directory: workspace, modulePath: path.join(root, 'electron', 'workspace.mjs') });
  await page.evaluate(() => window.claudePanel.openWorkspace());
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  await page.evaluate(async () => {
    await window.claudePanel.savePreferences({ model: 'gpt-recovery-fixture', permissionMode: 'acceptEdits', effort: 'low' });
    window.__recoveryPermissionCount = 0;
    window.__recoveryPrematureCompletion = 0;
    window.claudePanel.onState(state => {
      if (state.permission) window.__recoveryPermissionCount++;
      const text = state.session?.messages.at(-1)?.text || '';
      if (!state.run && text.includes('RECOVERY_PROGRESS') && !text.includes('RECOVERY_CONTINUED')) window.__recoveryPrematureCompletion++;
    });
  });
  const input = page.getByRole('textbox', { name: '输入任务', exact: true });
  await input.fill('RECOVERY_FAIL: work until the simulated connection interruption.');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.message-assistant').last()).toContainText(partialText);
  const stale = await page.evaluate(() => window.claudePanel.getState());
  assert.ok(stale.run);
  assert.equal(requests.length, 1);
  assert.ok(brokenStream);
  brokenStream.destroy();
  await page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
  const resume = page.getByRole('button', { name: '继续任务', exact: true });
  await expect(resume).toBeEnabled();
  const failed = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(failed.session.messages.at(-1).status, 'interrupted');
  assert.match(failed.session.messages.at(-1).text, /RECOVERY_PARTIAL/);
  assert.equal(await application.evaluate(() => globalThis.__recoverySaveFailed), true);

  // Replay an older running snapshot after the terminal state has reached the renderer.
  await application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('panel:state', state), stale);
  await input.fill('LOCAL_DRAFT_MUST_SURVIVE');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(isolated, 'recovery-desktop.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760));
  await expect(resume).toBeVisible();
  const narrowViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(narrowViewport.width >= 800 && narrowViewport.width <= 900, `Expected a narrow desktop viewport, got ${JSON.stringify(narrowViewport)}`);
  await page.screenshot({ path: path.join(isolated, 'recovery-narrow-desktop.png') });
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, pendingAttachment);
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await expect(page.locator('.attachment-chip')).toContainText('pending-attachment.txt');
  await resume.click();
  await expect(page.locator('.message-assistant').last()).toContainText('RECOVERY_CONTINUED');
  await page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
  await expect(input).toHaveValue('LOCAL_DRAFT_MUST_SURVIVE');
  await expect(page.locator('.attachment-chip')).toContainText('pending-attachment.txt');
  assert.equal(await page.evaluate(() => window.__recoveryPermissionCount), 0, 'Automatic workspace editing must not require permission');
  const continued = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(continued.session.directResponsesSessionId, failed.session.directResponsesSessionId);
  assert.equal(continued.session.messages.at(-1).status, 'completed');
  assert.equal(continued.error, null);
  assert.equal(requests.length, 4, 'Only explicit turns and model progress/tool continuations should make requests');
  assert.equal(await page.evaluate(() => window.__recoveryPrematureCompletion), 0, 'Commentary must not complete the desktop task');

  // A disk failure before service.run must release the send lock without making a request.
  await application.evaluate(() => { globalThis.__recoveryInitFailNext = true; });
  await input.fill('INITIAL_SAVE_FAIL: this turn must never reach the model.');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.message-assistant').last()).toContainText('Fixture initial persistence failure');
  await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  const initializationFailed = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(initializationFailed.run, null);
  assert.equal(initializationFailed.session.messages.at(-1).status, 'interrupted');
  assert.match(initializationFailed.session.messages.at(-1).error, /Fixture initial persistence failure/);
  assert.equal(await application.evaluate(() => globalThis.__recoveryInitFailed), true);
  assert.equal(requests.length, 4, 'Initialization failure must not submit or retry the task');
  await expect(page.locator('.attachment-chip')).toContainText('pending-attachment.txt');

  await input.fill('REUSED_FIRST: write the first tool result.');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.message-assistant').last()).toContainText('REUSED_FIRST_DONE');
  await page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
  await expect(page.locator('.attachment-chip')).toHaveCount(0);
  const firstReuse = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(firstReuse.session.id, continued.session.id);
  assert.equal(firstReuse.session.messages.at(-2).attachments[0].path, pendingAttachment);
  assert.equal(requests.length, 6);

  // Keep the actual send IPC pending while the user edits the next draft.
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, submittedAttachment);
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await expect(page.locator('.attachment-chip')).toContainText('submitted-attachment.txt');
  await application.evaluate(() => { globalThis.__recoveryDelayNext = true; });
  await input.fill('DELAYED_SECOND: write the second tool result with a reused call ID.');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.__recoveryInitializationHeld)).toBe(true);
  await input.fill('NEW_DRAFT_DURING_SEND_MUST_SURVIVE');
  assert.equal(requests.length, 6, 'The delayed initialization must not contact the model early');
  await application.evaluate(() => globalThis.__recoveryReleaseInitialization());
  await expect(page.locator('.message-assistant').last()).toContainText('DELAYED_SECOND_DONE');
  await page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
  await expect(input).toHaveValue('NEW_DRAFT_DURING_SEND_MUST_SURVIVE');
  await expect(page.locator('.attachment-chip')).toHaveCount(0);
  const finished = await page.evaluate(() => window.claudePanel.getState());
  const reusedTools = finished.session.tools.filter(tool => tool.id === 'reused-tool-call');
  assert.equal(reusedTools.length, 2, 'Repeated provider call IDs must retain each turn in operation history');
  assert.equal(new Set(reusedTools.map(tool => tool.runId)).size, 2);
  assert.deepEqual(reusedTools.map(tool => tool.input.file_path), ['first-reused-tool.txt', 'second-reused-tool.txt']);
  assert.ok(reusedTools.every(tool => tool.status === 'done'));
  assert.equal(finished.session.messages.at(-2).attachments[0].path, submittedAttachment);
  assert.equal(finished.session.messages.at(-1).status, 'completed');
  assert.equal(finished.error, null);
  assert.equal(requests.length, 8, 'Only the explicit turns and their progress/tool continuations should reach the model');
  assert.equal(JSON.stringify(requests).includes('NEW_DRAFT_DURING_SEND_MUST_SURVIVE'), false);
  assert.equal(await page.evaluate(() => window.__recoveryPermissionCount), 0);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(rendererErrors, []);
  console.log(`Desktop recovery passed: interrupted streams, commentary continuation, initial and terminal save failures, stale-state protection, same-session continuation, pending attachments, repeated tool IDs, delayed-send draft retention, automatic edits, and desktop screenshots (${narrowViewport.width}x${narrowViewport.height} narrow viewport) in ${isolated}`);
} finally {
  try { if (application) await application.close(); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
