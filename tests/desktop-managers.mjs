import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const isolated = path.join(TEST_ROOT, `desktop-managers-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const qa = path.join(root, 'data', 'qa');
const privateToken = 'fixture-managers-private-token';
const generationRequests = [];
const modelServer = createServer((request, response) => {
  if (request.method === 'POST' && /\/(messages|responses|chat\/completions|completions)(?:\?|$)/.test(request.url)) generationRequests.push(request.url);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'claude-fixture-code', display_name: 'Claude Fixture' }], has_more: false }));
});
await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(configDirectory, { recursive: true }), fs.mkdir(qa, { recursive: true })]);
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${modelServer.address().port}`;
const initialSettings = { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: privateToken, FIXTURE_MARKER: 'preserved' }, fixtureSetting: { keep: true }, permissions: { allow: ['Read'] } };
await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify(initialSettings));
await fs.writeFile(path.join(configDirectory, '.claude.json'), JSON.stringify({ fixtureGlobal: { keep: true } }));
await fs.writeFile(path.join(workspace, 'README.md'), '# Isolated command manager checks\n');
const env = { ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory, CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'), TEMP: TEST_ROOT, TMP: TEST_ROOT };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
let page;

async function readSettings() { return JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8')); }
async function selectManager(id) {
  const settings = page.getByRole('main', { name: '设置', exact: true });
  if (await settings.isVisible() && await settings.locator(`[data-settings-page="${id}"]`).count()) {
    const navigation = settings.locator(`[data-settings-page="${id}"]`);
    if (await navigation.isVisible()) await navigation.click();
    else await settings.getByRole('combobox', { name: '设置分类', exact: true }).selectOption(id);
  } else {
    if (await settings.isVisible()) await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.getByRole('button', { name: '命令中心', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索命令', exact: true }).fill(id);
    await page.locator(`[data-command-id="${id}"]`).click();
  }
  const manager = page.getByRole('region', { name: `${id} 管理`, exact: true });
  await manager.waitFor();
  await expect(manager.locator('.manager-loading')).toHaveCount(0);
  await expect(manager.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
  assert.equal(await manager.locator('pre').count(), 0, `${id} should expose native controls, not raw JSON`);
  assert.equal((await manager.innerText()).includes(privateToken), false);
  return manager;
}

async function settle(manager) {
  await expect(manager.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
  await expect(manager.getByRole('alert')).toHaveCount(0);
}

async function layoutChecks(label) {
  const issues = await page.locator('.command-manager').evaluate(manager => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const bounds = manager.closest('.workbench-settings-content').getBoundingClientRect();
    const issues = [];
    for (const element of manager.querySelectorAll('input:not([type="radio"]):not([role="switch"]), textarea, select, button, .manager-form-actions, .manager-row-actions, .manager-field, .manager-facts dd')) {
      if (!visible(element)) continue;
      const rectangle = element.getBoundingClientRect();
      if (rectangle.left < bounds.left - 1 || rectangle.right > bounds.right + 1) issues.push(`${element.tagName}.${element.className}: horizontal overflow`);
      if (element.matches('button') && element.scrollWidth > element.clientWidth + 2) issues.push(`button ${element.textContent}: clipped text`);
      if (element.matches('.manager-binding input') && rectangle.width < 80) issues.push('keybinding key input is too narrow to show a shortcut');
    }
    for (const row of manager.querySelectorAll('.manager-row, .manager-setting-row')) {
      const main = row.querySelector('.manager-row-main, .manager-setting-copy')?.getBoundingClientRect();
      const actions = row.querySelector('.manager-row-actions, .manager-setting-control')?.getBoundingClientRect();
      if (main && actions && Math.min(main.right, actions.right) - Math.max(main.left, actions.left) > 1 && Math.min(main.bottom, actions.bottom) - Math.max(main.top, actions.top) > 1) issues.push('row actions overlap row text');
    }
    return issues;
  });
  assert.deepEqual(issues, [], label);
}

try {
  application = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], env, timeout: 30000 });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, workspace);
  await page.evaluate(() => window.claudePanel.openWorkspace());
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  await page.getByRole('button', { name: '连接与设置', exact: true }).click();

  let manager = await selectManager('chrome');
  await expect(manager.getByRole('switch', { name: '默认启用 Chrome 集成', exact: true })).not.toBeChecked();
  await manager.getByRole('switch', { name: '默认启用 Chrome 集成', exact: true }).click();
  await settle(manager);
  await expect(manager.getByRole('switch', { name: '默认启用 Chrome 集成', exact: true })).toBeChecked();
  const globalConfig = JSON.parse(await fs.readFile(path.join(configDirectory, '.claude.json'), 'utf8'));
  assert.equal(globalConfig.claudeInChromeDefaultEnabled, true);
  assert.deepEqual(globalConfig.fixtureGlobal, { keep: true });
  assert.equal((await readSettings()).claudeInChromeDefaultEnabled, undefined);
  assert.match(await manager.innerText(), /API Key.*中转站令牌/);
  assert.equal(await manager.getByRole('button', { name: '安装扩展', exact: true }).count(), 1);
  await expect(manager.getByText('已开启，尚未检测连接', { exact: true })).toBeVisible();
  await expect(manager.getByText('未检测', { exact: true })).toBeVisible();
  await layoutChecks('chrome desktop');
  await page.screenshot({ path: path.join(qa, 'command-managers-chrome-desktop.png') });

  manager = await selectManager('hooks');
  await manager.getByRole('button', { name: '添加', exact: true }).click();
  await manager.getByLabel(/^触发事件/).selectOption('PreToolUse');
  await manager.getByText('更多选项', { exact: true }).click();
  await manager.getByLabel('匹配规则', { exact: true }).fill('Read');
  await manager.getByLabel('执行命令', { exact: true }).fill('echo fixture-hook-not-executed');
  await manager.getByLabel('超时（秒）', { exact: true }).fill('12');
  await layoutChecks('hooks add desktop');
  await page.screenshot({ path: path.join(qa, 'command-managers-hooks-form-desktop.png') });
  await manager.getByRole('button', { name: '创建', exact: true }).click();
  await settle(manager);
  assert.equal((await readSettings()).hooks.PreToolUse[0].hooks[0].command, 'echo fixture-hook-not-executed');
  await manager.getByRole('button', { name: '删除 PreToolUse', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除', exact: true }).click();
  await settle(manager);
  assert.deepEqual((await readSettings()).hooks.PreToolUse, []);

  manager = await selectManager('skills');
  await manager.getByRole('button', { name: '添加', exact: true }).click();
  await manager.getByLabel('名称', { exact: true }).fill('fixture-skill');
  await manager.getByLabel('用途说明', { exact: true }).fill('Isolated skill for desktop tests');
  await manager.getByLabel('操作要求', { exact: true }).fill('Return a fixture result.');
  await manager.getByRole('button', { name: '创建', exact: true }).click();
  await settle(manager);
  const skillFile = path.join(configDirectory, 'skills', 'fixture-skill', 'SKILL.md');
  assert.match(await fs.readFile(skillFile, 'utf8'), /Return a fixture result/);
  const editor = manager.getByRole('textbox', { name: '编辑操作要求', exact: true });
  await editor.fill('Edited successfully.\n');
  await manager.getByRole('button', { name: '保存', exact: true }).click();
  await settle(manager);
  assert.match(await fs.readFile(skillFile, 'utf8'), /Edited successfully/);
  await editor.fill('Attempted stale overwrite.');
  await fs.writeFile(skillFile, '# Written by another editor\n');
  await manager.getByRole('button', { name: '保存', exact: true }).click();
  await expect(manager.getByRole('alert')).toContainText('文件已被其他程序修改');
  assert.equal(await fs.readFile(skillFile, 'utf8'), '# Written by another editor\n');
  await manager.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  await manager.getByRole('button', { name: '编辑 fixture-skill', exact: true }).click();
  await settle(manager);
  await expect(editor).toHaveValue('# Written by another editor\n');
  await manager.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  await manager.getByRole('combobox', { name: 'fixture-skill 调用方式', exact: true }).selectOption('name-only');
  await settle(manager);
  const local = JSON.parse(await fs.readFile(path.join(workspace, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(local.skillOverrides['fixture-skill'], 'name-only');
  await layoutChecks('skills desktop');
  await page.screenshot({ path: path.join(qa, 'command-managers-skills-desktop.png') });

  for (const [id, folder] of [['agents', 'agents'], ['output-style', 'output-styles']]) {
    manager = await selectManager(id);
    await manager.getByRole('button', { name: '添加', exact: true }).click();
    await manager.getByLabel('名称', { exact: true }).fill(`fixture-${id}`);
    await manager.getByLabel('用途说明', { exact: true }).fill('Isolated test document');
    await manager.getByLabel('操作要求', { exact: true }).fill('Fixture instructions.');
    await manager.getByRole('button', { name: '创建', exact: true }).click();
    await settle(manager);
    assert.match(await fs.readFile(path.join(configDirectory, folder, `fixture-${id}.md`), 'utf8'), /Fixture instructions/);
    const closeEditor = manager.getByRole('button', { name: '关闭编辑器', exact: true });
    if (await closeEditor.count()) await closeEditor.click();
  }
  await manager.getByRole('combobox', { name: /^当前输出风格/ }).selectOption('Concise');
  await settle(manager);
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace, '.claude', 'settings.local.json'), 'utf8')).outputStyle, 'Concise');

  manager = await selectManager('statusline');
  await manager.getByRole('combobox', { name: '状态栏样式', exact: true }).selectOption('compact');
  await settle(manager);
  const presetStatusLine = (await readSettings()).statusLine;
  assert.equal(presetStatusLine.type, 'command');
  assert.ok(presetStatusLine.command.includes(configDirectory), 'Preset command and script must remain in the isolated configuration on D drive');
  const customScript = manager.getByRole('button', { name: '自定义脚本', exact: true });
  if (await customScript.count()) await customScript.click();
  await manager.getByLabel(/^状态栏命令/).fill('echo fixture-statusline');
  await manager.getByLabel('左右留白', { exact: true }).fill('3');
  await manager.getByRole('button', { name: '保存', exact: true }).click();
  await settle(manager);
  assert.deepEqual((await readSettings()).statusLine, { type: 'command', command: 'echo fixture-statusline', padding: 3 });

  manager = await selectManager('keybindings');
  await manager.getByRole('button', { name: '添加快捷键', exact: true }).click();
  await manager.getByLabel('快捷键 1 按键', { exact: true }).fill('ctrl+k');
  await manager.getByLabel('快捷键 1 操作', { exact: true }).selectOption('chat:newline');
  await manager.getByRole('button', { name: '保存', exact: true }).click();
  await settle(manager);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(configDirectory, 'keybindings.json'), 'utf8')).bindings, [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:newline' } }]);
  await layoutChecks('keybindings desktop');

  manager = await selectManager('mcp');
  await manager.getByRole('button', { name: '添加', exact: true }).click();
  await manager.getByLabel('名称', { exact: true }).fill('fixture-local-http');
  await expect(manager.getByRole('radio', { name: '网络服务', exact: true })).toBeChecked();
  await manager.getByLabel('服务器 URL', { exact: true }).fill(`${baseUrl}/mcp-fixture`);
  await manager.getByRole('button', { name: '创建', exact: true }).click();
  await settle(manager);
  assert.equal(JSON.parse(await fs.readFile(path.join(configDirectory, '.claude.json'), 'utf8')).mcpServers['fixture-local-http'].url, `${baseUrl}/mcp-fixture`);
  await manager.getByRole('button', { name: '删除 fixture-local-http', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除', exact: true }).click();
  await settle(manager);
  assert.equal(JSON.parse(await fs.readFile(path.join(configDirectory, '.claude.json'), 'utf8')).mcpServers?.['fixture-local-http'], undefined);

  manager = await selectManager('plugin');
  await expect(manager.getByRole('button', { name: '安装插件', exact: true })).toBeEnabled();
  assert.equal(await manager.locator('pre').count(), 0);

  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(800, 700); window.setSize(800, 700); });
  manager = await selectManager('keybindings');
  await layoutChecks('keybindings narrow');
  await page.screenshot({ path: path.join(qa, 'command-managers-keybindings-narrow.png') });
  manager = await selectManager('chrome');
  await layoutChecks('chrome narrow');
  await page.screenshot({ path: path.join(qa, 'command-managers-chrome-narrow.png') });
  manager = await selectManager('mcp');
  await manager.getByRole('button', { name: '添加', exact: true }).click();
  await manager.getByLabel('名称', { exact: true }).fill('fixture-visual-form');
  await expect(manager.getByRole('radio', { name: '网络服务', exact: true })).toBeChecked();
  await manager.getByLabel('服务器 URL', { exact: true }).fill(`${baseUrl}/mcp-visual-only`);
  await manager.locator('.manager-form-actions').last().scrollIntoViewIfNeeded();
  await layoutChecks('mcp form narrow');
  await page.screenshot({ path: path.join(qa, 'command-managers-mcp-form-narrow.png') });
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(dimensions.width <= 800 && dimensions.width >= 780, 'Narrow QA must exercise the actual 800px layout');

  const finalSettings = await readSettings();
  assert.deepEqual(finalSettings.env, initialSettings.env);
  assert.deepEqual(finalSettings.fixtureSetting, initialSettings.fixtureSetting);
  assert.deepEqual(finalSettings.permissions, initialSettings.permissions);
  const backups = await fs.readdir(path.join(configDirectory, 'panel-backups'));
  assert.ok(backups.length >= 4, 'Configuration mutations and document saves must produce backups');
  assert.deepEqual(generationRequests, [], 'Managers must never send model-generation requests');
  assert.deepEqual(errors, [], 'Renderer must not emit errors');
  console.log('Electron manager integration passed: Chrome global settings, preserved credentials, hooks add/remove, skills/agents/styles creation, conflict-safe document editing, visibility, terminal settings, actual Claude MCP add/remove and plugin listing, desktop/narrow QA. No model-generation requests were sent.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(qa, 'command-managers-failure.png') }).catch(() => {});
    const alerts = await page.getByRole('alert').allTextContents().catch(() => []);
    if (alerts.length) console.error('Manager alerts:', alerts.map(value => value.split(privateToken).join('[hidden]')));
  }
  throw error;
} finally {
  if (application) await application.close();
  await new Promise(resolve => modelServer.close(resolve));
}
