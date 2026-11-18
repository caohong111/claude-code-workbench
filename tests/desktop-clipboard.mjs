import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WorkspaceStore } from '../electron/workspace.mjs';

const root = path.resolve('.');
const packagedDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
const testRoot = path.join(root, 'tests', '.tmp');
const isolated = path.join(testRoot, `desktop-clipboard-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const stateDirectory = path.join(isolated, 'state');
const userText = 'CLIPBOARD_USER：用户消息\n第二行\t保留制表符和末尾换行\n';
const olderReply = 'CLIPBOARD_OLDER：较早的回答\n原样复制这段文字。\n';
const codeText = 'const label = "复制代码";\nconsole.log(label);\n';
const latestReply = `CLIPBOARD_LATEST：最新回答\n\n\`\`\`js\n${codeText}\`\`\`\n\n保留 Markdown **格式**和多行文字。\n`;
const requests = [];
const rendererErrors = [];
let application;

const server = createServer((request, response) => {
  requests.push({ method: request.method, path: new URL(request.url, 'http://localhost').pathname });
  if (request.method !== 'GET' || !requests.at(-1).path.endsWith('/models')) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Clipboard tests must only request the local model catalog' } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'claude-clipboard-fixture', display_name: 'Claude Clipboard Fixture' }], has_more: false }));
});

await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(configDirectory, { recursive: true })]);
await fs.writeFile(path.join(workspace, 'README.md'), '# Isolated native clipboard checks\n');
const store = new WorkspaceStore(stateDirectory);
await store.load();
await store.openWorkspace(workspace);
const createdAt = new Date().toISOString();
store.currentSession.messages = [
  { id: randomUUID(), role: 'user', text: userText, createdAt },
  { id: randomUUID(), role: 'assistant', text: olderReply, createdAt },
  { id: randomUUID(), role: 'assistant', text: latestReply, createdAt },
];
await store.save();

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_AUTH_TOKEN: 'fixture-clipboard-private-token',
    ANTHROPIC_MODEL: 'claude-clipboard-fixture',
  } }));
  const env = {
    ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory,
    CLAUDE_PANEL_DATA_DIR: stateDirectory, TEMP: testRoot, TMP: testRoot,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: packagedDirectory ? path.join(packagedDirectory, 'Claude Code Workbench.exe') : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: packagedDirectory ? [] : [root], env, timeout: 30000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();
  await page.locator('.message-assistant').last().filter({ hasText: 'CLIPBOARD_LATEST' }).waitFor();
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  assert.equal(await page.evaluate(() => typeof window.claudePanel.copyText), 'function');

  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const previous = [];
    for (const item of await clipboard.read()) {
      // Empty Windows runner clipboards can expose a placeholder without MIME types.
      if (!item.types.length) continue;
      const data = {};
      for (const type of item.types) data[type] = await item.getType(type);
      previous.push(new ClipboardItem(data));
    }
    globalThis.__clipboardFixtureOriginal = previous;
  });
  const denied = await page.evaluate(async () => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); },
    });
    try { await navigator.clipboard.writeText('CLIPBOARD_PERMISSION_PROBE'); return null; }
    catch (error) { return { name: error.name, message: error.message }; }
  });
  assert.deepEqual(denied, { name: 'NotAllowedError', message: 'Write permission denied.' }, 'The browser clipboard denial must be active');

  const readClipboard = () => application.evaluate(({ clipboard }) => clipboard.readText());
  async function copyAndCheck(label, expected, action) {
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), `CLIPBOARD_SENTINEL_${randomUUID()}`);
    await action();
    await expect.poll(readClipboard, { timeout: 15000, message: label }).toBe(expected);
  }

  await copyAndCheck('User message copy must write the exact native clipboard text', userText,
    () => page.locator('.message-user').getByRole('button', { name: '复制消息', exact: true }).click());
  const latest = page.locator('.message-assistant').last();
  await copyAndCheck('Assistant message copy must retain its complete Markdown source', latestReply,
    () => latest.getByRole('button', { name: '复制消息', exact: true }).click());
  const code = latest.locator('.code-block');
  await copyAndCheck('Code copy must retain Unicode and its final newline', codeText,
    () => code.getByRole('button', { name: '复制代码', exact: true }).click());
  await expect(code.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  assert.deepEqual(await page.locator('.chat-asset-error:visible').allTextContents(), []);
  assert.equal((await page.evaluate(() => window.claudePanel.getState())).error, null);

  await page.getByRole('button', { name: '命令中心', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '命令中心', exact: true });
  await menu.locator('[data-command-id="copy"]').click();
  for (const [number, expected] of [[1, latestReply], [2, olderReply]]) {
    await menu.getByRole('spinbutton', { name: '最近第几条回答', exact: true }).fill(String(number));
    const button = menu.locator('.command-detail-actions').getByRole('button', { name: '复制回答', exact: true });
    await expect(button).toBeEnabled();
    await copyAndCheck(`Menu copy ${number} must select the matching assistant reply`, expected, () => button.click());
    await expect(menu.getByRole('region', { name: '操作结果', exact: true })).toContainText('回答已复制');
    await expect(button).toBeEnabled();
    await expect(menu.getByRole('alert')).toHaveCount(0);
  }
  await menu.getByRole('button', { name: '关闭命令中心', exact: true }).click();

  const directText = 'CLIPBOARD_DIRECT： 空白不能被裁剪 \n\t第二行\n';
  await copyAndCheck('The native copy API must preserve whitespace', directText,
    () => page.evaluate(text => window.claudePanel.copyText(text), directText));
  const sentinel = `CLIPBOARD_REJECTED_${randomUUID()}`;
  await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel);
  const invalidResults = await page.evaluate(async () => {
    const inputs = [null, 17, {}, ['not a string'], '测'.repeat(Math.floor(4 * 1024 * 1024 / 3) + 1)];
    const results = [];
    for (const input of inputs) {
      try { await window.claudePanel.copyText(input); results.push(false); }
      catch { results.push(true); }
      await window.claudePanel.clearError();
    }
    return results;
  });
  assert.deepEqual(invalidResults, [true, true, true, true, true], 'Only strings within the UTF-8 byte limit may reach the clipboard');
  assert.equal(await readClipboard(), sentinel, 'Rejected copy input must leave the clipboard unchanged');
  assert.equal((await page.evaluate(() => window.claudePanel.getState())).error, null);
  assert.deepEqual(rendererErrors, [], 'Copy operations must not emit renderer errors');
  assert.ok(requests.every(request => request.method === 'GET' && request.path.endsWith('/models')), 'Clipboard checks must not request model generation');
  console.log('Electron clipboard checks passed: browser write denial, exact native user/assistant/code/menu copies, answer ordering, whitespace, invalid input rejection, and clipboard restoration.');
} finally {
  try {
    if (application) await application.evaluate(async ({ clipboard }) => {
      const previous = globalThis.__clipboardFixtureOriginal;
      if (previous?.length) await clipboard.write(previous);
      else if (previous) clipboard.clear();
    });
  } finally {
    try { if (application) await application.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}
