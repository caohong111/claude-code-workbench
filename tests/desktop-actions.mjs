import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const isolated = path.join(TEST_ROOT, `desktop-actions-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const stateDirectory = path.join(isolated, 'state');
const credential = 'fixture-actions-private-token';
const requests = [];
const modelServer = createServer((request, response) => {
  if (request.method !== 'GET' || !new URL(request.url, 'http://localhost').pathname.endsWith('/models')) requests.push({ method: request.method, path: request.url });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'gpt-fixture-code', display_name: 'GPT Fixture' }, { id: 'claude-fixture-code', display_name: 'Claude Fixture' }], has_more: false }));
});
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(configDirectory, { recursive: true });
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${modelServer.address().port}`;
const initialSettings = { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: credential, FIXTURE_MARKER: 'preserved' }, fixtureSetting: { keep: true }, permissions: { allow: ['Read'] } };
await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify(initialSettings));
await fs.writeFile(path.join(workspace, 'README.md'), '# Isolated desktop action checks\n');
const assets = ['app-icon.png', 'app-icon.ico', 'assistant-avatar.png', 'user-avatar.png'];
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const originals = new Map(await Promise.all(assets.map(async name => [name, digest(await fs.readFile(path.join(root, 'assets', name)))])));
const env = { ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory, CLAUDE_PANEL_DATA_DIR: stateDirectory, TEMP: TEST_ROOT, TMP: TEST_ROOT };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
try {
  application = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], env, timeout: 30000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();

  await application.evaluate(({ clipboard }, modules) => {
    globalThis.__actionRuns = [];
    globalThis.__copiedActionText = null;
    clipboard.writeText = text => { globalThis.__copiedActionText = text; };
    for (const [engine, modulePath, className] of modules) {
      const Service = process.mainModule.require(modulePath)[className];
      Service.prototype.run = async function (options) {
        const index = globalThis.__actionRuns.length + 1;
        const sessionId = `${engine === 'responses' ? 'direct' : 'claude'}-fixture-session-${index}`;
        const text = engine === 'claude' ? 'CLAUDE_INTERVENING_REPLY' : index === 1 ? 'GPT_FIRST_REPLY' : 'GPT_AFTER_CLAUDE_REPLY';
        globalThis.__actionRuns.push({ engine, model: options.model, prompt: options.prompt, historyContext: options.historyContext, resumeSessionId: options.resumeSessionId ?? null, sessionId });
        await this.onEvent({ type: 'session', runId: options.runId, sessionId, engine, model: options.model });
        await this.onEvent({ type: 'text', runId: options.runId, text, engine });
        await this.onEvent({ type: 'done', runId: options.runId, sessionId, result: text, engine });
        return { sessionId, result: text, stopped: false, isError: false };
      };
    }
  }, [
    ['claude', path.join(root, 'electron', 'claude-service.mjs'), 'ClaudeService'],
    ['responses', path.join(root, 'electron', 'responses-service.mjs'), 'ResponsesService'],
  ]);

  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, workspace);
  await page.evaluate(() => window.claudePanel.openWorkspace());
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  const initial = await page.evaluate(() => window.claudePanel.getState());
  const sessionId = initial.session.id;
  const execute = (id, values = {}) => page.evaluate(request => window.claudePanel.executeCommand(request), { id, values });
  const snapshot = () => page.evaluate(() => window.claudePanel.getState());
  const send = async text => {
    await page.evaluate(text => window.claudePanel.sendMessage({ text }), text);
    await page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
    await page.locator('.run-status').waitFor({ state: 'hidden' });
    const state = await snapshot();
    assert.equal(state.error, null);
    return state;
  };

  await execute('rename', { name: 'Actions Fixture' });
  assert.equal((await snapshot()).session.title, 'Actions Fixture');
  await execute('fast', { enabled: true });
  await execute('autocompact', { window: 500000 });
  const savedSettings = JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8'));
  assert.equal(savedSettings.fastMode, true);
  assert.equal(savedSettings.autoCompactWindow, 500000);
  for (const [key, value] of Object.entries(initialSettings.env)) assert.equal(savedSettings.env[key], value);
  assert.deepEqual(savedSettings.fixtureSetting, initialSettings.fixtureSetting);
  assert.deepEqual(savedSettings.permissions, initialSettings.permissions);
  assert.deepEqual((await snapshot()).connection.claudeOptions, { fastMode: true, autoCompactWindow: 500000, autoCompactEnvironmentOverride: false, modelAutoCompactWindows: {}, modelAliases: {} });
  await execute('autocompact', { scope: 'model', model: 'claude-opus-4-6-20251101[1m]', window: 700000 });
  const modelSettings = JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8'));
  assert.equal(modelSettings.modelSettings['claude-opus-4-6'].autoCompactWindow, 700000);
  assert.equal(modelSettings.autoCompactWindow, 500000);
  await execute('autocompact', { scope: 'model', model: 'claude-opus-4-6', window: 'auto' });
  assert.equal(JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8')).modelSettings['claude-opus-4-6'].autoCompactWindow, 'auto');
  await execute('autocompact', { window: 'auto' });
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8')), 'autoCompactWindow'), false);
  const memory = await execute('memory', { action: 'read' });
  assert.equal(memory.type, 'editor');
  assert.equal(memory.content, '');
  await execute('memory', { action: 'save', content: '# Fixture project rules\nKeep this workspace isolated.\n' });
  assert.equal(await fs.readFile(path.join(workspace, 'CLAUDE.md'), 'utf8'), '# Fixture project rules\nKeep this workspace isolated.\n');

  for (const slot of ['appIcon', 'claudeAvatar', 'userAvatar']) {
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(root, 'assets', 'user-avatar.png'));
    const picked = await page.evaluate(slot => window.claudePanel.pickAppearance(slot), slot);
    assert.equal(picked.appearance[slot].custom, true);
    assert.equal(picked.appearance[slot].fileName, 'user-avatar.png');
    assert.match(picked.appearance[slot].src, /^data:image\/png;base64,/);
    if (slot === 'appIcon') {
      const metadata = JSON.parse(await fs.readFile(path.join(stateDirectory, 'appearance', 'appearance.json'), 'utf8'));
      const icon = await fs.readFile(path.join(stateDirectory, 'appearance', metadata.slots.appIcon.fileName.replace(/\.png$/, '.ico')));
      assert.equal(icon.readUInt16LE(2), 1);
      assert.equal(icon.readUInt16LE(4), 1);
    }
    const reset = await page.evaluate(slot => window.claudePanel.resetAppearance(slot), slot);
    assert.equal(reset.appearance[slot].custom, false);
    assert.equal(reset.appearance[slot].src, initial.appearance[slot].src);
  }
  for (const [name, original] of originals) assert.equal(digest(await fs.readFile(path.join(root, 'assets', name))), original, `${name} must remain unchanged`);

  await execute('model', { model: 'gpt-fixture-code' });
  const gpt = await send('GPT_FIRST_TASK');
  assert.equal(gpt.session.directResponsesSessionId, 'direct-fixture-session-1');
  assert.equal(gpt.session.lastEngine, 'responses');
  await execute('model', { model: 'claude-fixture-code' });
  const native = await send('CLAUDE_INTERVENING_TASK');
  assert.equal(native.session.claudeSessionId, 'claude-fixture-session-2');
  assert.equal(native.session.directResponsesSessionId, 'direct-fixture-session-1');
  assert.equal(native.session.lastEngine, 'claude');
  await execute('model', { model: 'gpt-fixture-code' });
  const returned = await send('GPT_AFTER_CLAUDE_TASK');
  const runs = await application.evaluate(() => globalThis.__actionRuns);
  assert.deepEqual(runs.map(run => run.engine), ['responses', 'claude', 'responses']);
  assert.equal(runs[0].resumeSessionId, null);
  assert.equal(runs[1].resumeSessionId, null);
  assert.equal(runs[2].resumeSessionId, null, 'Switching back must start a thread with intervening history');
  assert.match(runs[1].prompt, /GPT_FIRST_REPLY/);
  assert.match(runs[2].prompt, /CLAUDE_INTERVENING_TASK/);
  assert.match(runs[2].prompt, /CLAUDE_INTERVENING_REPLY/);
  assert.equal(returned.session.id, sessionId);
  assert.equal(returned.session.directResponsesSessionId, 'direct-fixture-session-3');
  assert.equal(returned.session.claudeSessionId, 'claude-fixture-session-2');
  assert.equal(returned.session.messages.at(-1).text, 'GPT_AFTER_CLAUDE_REPLY');
  await execute('copy', { number: 1 });
  assert.equal(await application.evaluate(() => globalThis.__copiedActionText), 'GPT_AFTER_CLAUDE_REPLY');

  for (const [format, name] of [['markdown', 'conversation.md'], ['json', 'conversation.json']]) {
    const destination = path.join(workspace, name);
    await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, destination);
    await execute('export', { format });
    const exported = await fs.readFile(destination, 'utf8');
    assert.match(exported, /Actions Fixture/);
    assert.match(exported, /GPT_FIRST_REPLY/);
    assert.match(exported, /CLAUDE_INTERVENING_REPLY/);
    assert.equal(exported.includes(credential), false);
    if (format === 'json') assert.equal(JSON.parse(exported).messages.length, 6);
  }
  await execute('branch', { name: 'Independent Branch' });
  const branched = await snapshot();
  assert.notEqual(branched.session.id, sessionId);
  assert.equal(branched.session.branchOf, sessionId);
  assert.equal(branched.session.title, 'Independent Branch');
  assert.deepEqual(branched.session.messages, returned.session.messages);
  assert.equal(branched.session.claudeSessionId, null);
  assert.ok(branched.session.directResponsesSessionId == null);
  await execute('model', { model: 'claude-fixture-code' });
  await send('/compact keep the key decisions');
  const commandRun = await application.evaluate(() => globalThis.__actionRuns.at(-1));
  assert.equal(commandRun.prompt, '/compact keep the key decisions', 'History must not turn a slash command into a plain prompt');
  assert.match(commandRun.historyContext, /GPT_AFTER_CLAUDE_REPLY/);
  assert.equal(commandRun.resumeSessionId, null);
  await execute('resume', { sessionId });
  assert.equal((await snapshot()).session.id, sessionId);
  assert.equal((await snapshot()).sessions.length, 2);
  assert.deepEqual(requests, [], 'Model generation must never reach the fixture server');
  assert.deepEqual(errors, [], 'The desktop must not emit renderer errors');
  console.log('Electron action integration passed: native commands, preserved config and assets, icon import/reset, isolated export/copy, and GPT/Claude routing with engine-specific sessions and intervening history. No model-generation requests were sent.');
} finally {
  if (application) await application.close();
  await new Promise(resolve => modelServer.close(resolve));
}
