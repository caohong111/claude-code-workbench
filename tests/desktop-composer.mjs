import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const isolated = path.join(TEST_ROOT, `desktop-composer-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const generationRequests = [];
const server = createServer((request, response) => {
  if (request.method === 'POST' && /\/(messages|responses|chat\/completions|completions)(?:\?|$)/.test(request.url)) generationRequests.push(request.url);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'claude-fixture-code', display_name: 'Claude Fixture' }], has_more: false }));
});
await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(configDirectory, { recursive: true })]);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'fixture-composer-private-token', ANTHROPIC_MODEL: 'claude-fixture-code' } }));
await fs.writeFile(path.join(workspace, 'README.md'), '# Isolated composer keyboard checks\n');
const env = { ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory, CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'), TEMP: TEST_ROOT, TMP: TEST_ROOT };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];

try {
  application = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], env, timeout: 30000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();
  await application.evaluate(({ dialog }, { directory, modulePath }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    globalThis.__composerRuns = [];
    globalThis.__composerHoldNext = false;
    const Service = process.mainModule.require(modulePath).ClaudeService;
    Service.prototype.run = async function (options) {
      const index = globalThis.__composerRuns.length + 1;
      const sessionId = `claude-composer-fixture-${index}`;
      globalThis.__composerRuns.push({ prompt: options.prompt, index });
      await this.onEvent({ type: 'session', runId: options.runId, sessionId, engine: 'claude', model: options.model });
      if (globalThis.__composerHoldNext) {
        globalThis.__composerHoldNext = false;
        await new Promise(resolve => { globalThis.__releaseComposerRun = resolve; });
        globalThis.__releaseComposerRun = null;
      }
      const result = `COMPOSER_REPLY_${index}`;
      await this.onEvent({ type: 'text', runId: options.runId, text: result, engine: 'claude' });
      await this.onEvent({ type: 'done', runId: options.runId, sessionId, result, engine: 'claude' });
      return { sessionId, result, stopped: false, isError: false };
    };
  }, { directory: workspace, modulePath: path.join(root, 'electron', 'claude-service.mjs') });
  await page.evaluate(() => window.claudePanel.openWorkspace());
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  await page.evaluate(() => window.claudePanel.executeCommand({ id: 'model', values: { model: 'claude-fixture-code' } }));
  const input = page.getByRole('textbox', { name: '输入任务', exact: true });
  const runs = () => application.evaluate(() => globalThis.__composerRuns);
  const runCount = async () => (await runs()).length;
  const idle = () => page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
  async function assertCaret(position) {
    await expect.poll(() => input.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([position, position]);
  }

  await input.fill('alpha beta');
  await input.evaluate(element => element.setSelectionRange(5, 5));
  await input.press('Control+Enter');
  await expect(input).toHaveValue('alpha\n beta');
  await assertCaret(6);
  assert.equal(await runCount(), 0, 'Ctrl+Enter must insert a newline, not send');

  await input.fill('abcdef');
  await input.evaluate(element => element.setSelectionRange(2, 5));
  await input.press('Control+Enter');
  await expect(input).toHaveValue('ab\nf');
  await assertCaret(3);
  assert.equal(await runCount(), 0, 'Ctrl+Enter must replace the selected range with one newline');

  await input.fill('');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  assert.equal(await runCount(), 0, 'Empty Enter must not send an empty message');

  const firstPrompt = 'First line\nSecond line';
  await input.fill(firstPrompt);
  await input.press('Enter');
  await expect.poll(runCount).toBe(1);
  await idle();
  assert.equal((await runs())[0].prompt, firstPrompt);
  await expect(input).toHaveValue('');
  await expect(page.locator('.message-assistant').last()).toContainText('COMPOSER_REPLY_1');

  await input.fill('IME fixture task');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', isComposing: true }));
  });
  assert.equal(await runCount(), 1, 'IME candidate confirmation must not send');
  await expect(input).toHaveValue('IME fixture task');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'fixture' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 229, which: 229, isComposing: false }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 229, which: 229 }));
  });
  assert.equal(await runCount(), 1, 'IME keyCode 229 must not send after compositionend');
  await expect(input).toHaveValue('IME fixture task');
  await input.press('Enter');
  await expect.poll(runCount).toBe(2);
  await idle();
  assert.equal((await runs())[1].prompt, 'IME fixture task');

  await application.evaluate(() => { globalThis.__composerHoldNext = true; });
  await input.fill('Held fixture task');
  await input.press('Enter');
  await expect.poll(runCount).toBe(3);
  await page.waitForFunction(async () => Boolean((await window.claudePanel.getState()).run));
  await page.getByRole('button', { name: '停止', exact: true }).waitFor();
  await expect(input).toHaveValue('');
  await input.fill('Preserved draft while running');
  await input.press('Enter');
  await input.press('Enter');
  await input.press('Enter');
  assert.equal(await runCount(), 3, 'Repeated Enter during a running task must not submit again');
  await expect(input).toHaveValue('Preserved draft while running');
  await application.evaluate(() => globalThis.__releaseComposerRun());
  await idle();
  await input.press('Enter');
  await expect.poll(runCount).toBe(4);
  await idle();
  assert.equal((await runs())[3].prompt, 'Preserved draft while running');
  await expect(input).toHaveValue('');
  const state = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(state.session.messages.filter(message => message.role === 'user').length, 4, 'Each deliberate send must append exactly one user message');
  assert.equal(state.error, null);
  assert.deepEqual(generationRequests, [], 'The isolated fixture must not generate a real model request');
  assert.deepEqual(errors, [], 'The composer must not emit renderer errors');
  console.log('Electron composer keyboard integration passed: Enter sends once, Ctrl+Enter inserts newline at caret or selection, empty and IME Enter do not send, and running-task repeats preserve the draft. No model-generation requests were sent.');
} finally {
  if (application) {
    await application.evaluate(() => globalThis.__releaseComposerRun?.()).catch(() => {});
    await application.close();
  }
  await new Promise(resolve => server.close(resolve));
}
