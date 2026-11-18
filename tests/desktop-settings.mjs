import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const isolated = path.join(TEST_ROOT, `desktop-settings-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const qa = path.join(root, 'data', 'qa');
const privateToken = 'fixture-settings-private-token';
const generationRequests = [];
const modelServer = createServer((request, response) => {
  if (request.method === 'POST' && /\/(messages|responses|chat\/completions|completions)(?:\?|$)/.test(request.url)) generationRequests.push(request.url);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'claude-fixture-code', display_name: 'Claude Fixture' }], has_more: false }));
});
await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(configDirectory, { recursive: true }), fs.mkdir(qa, { recursive: true })]);
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${modelServer.address().port}`;
const initialSettings = { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: privateToken }, model: 'claude-opus-4-6', autoCompactWindow: 500000, modelSettings: { 'claude-opus-4-6': { autoCompactWindow: 700000, fixtureModelKey: 'preserved' }, 'claude-sonnet-4-6': { autoCompactWindow: 600000 } }, fixtureSetting: { keep: true }, permissions: { allow: ['Read'] } };
const expectedSettings = structuredClone(initialSettings);
expectedSettings.modelSettings['claude-opus-4-6'].autoCompactWindow = 'auto';
await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify(initialSettings));
await fs.writeFile(path.join(configDirectory, '.claude.json'), JSON.stringify({ fixtureGlobal: { keep: true } }));
await fs.writeFile(path.join(workspace, 'README.md'), '# Isolated settings checks\n');
const env = { ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory, CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'), TEMP: TEST_ROOT, TMP: TEST_ROOT };
delete env.ELECTRON_RUN_AS_NODE;
let application;
let page;
const errors = [];

async function selectPage(id, heading) {
  const navigation = page.locator(`[data-settings-page="${id}"]`);
  if (await navigation.isVisible()) await navigation.click();
  else await page.getByRole('combobox', { name: '设置分类', exact: true }).selectOption(id);
  await expect(page.locator('#workbench-settings-title')).toHaveText(heading);
  if (['chrome', 'mcp', 'plugin', 'ide', 'skills', 'agents', 'hooks', 'output-style', 'keybindings', 'statusline'].includes(id)) {
    const manager = page.getByRole('region', { name: `${id} 管理`, exact: true });
    await expect(manager).toBeVisible();
    const readySelector = ({ chrome: '.manager-setting-group', ide: '.manager-setting-group', hooks: '.manager-setting-row', keybindings: '.manager-binding-list', statusline: '[aria-label="状态栏样式"]' })[id] || '.manager-list, .manager-empty';
    await expect(manager.locator(readySelector).first()).toBeVisible();
    await expect(manager.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
    await expect(manager.locator('.manager-loading')).toHaveCount(0);
  }
}

async function layoutChecks(label) {
  const issues = await page.getByRole('main', { name: '设置', exact: true }).evaluate(main => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const issues = [];
    const bounds = main.getBoundingClientRect();
    if (main.scrollWidth > main.clientWidth + 1) issues.push('settings surface scrolls horizontally');
    for (const element of main.querySelectorAll('button, input, textarea, select, .manager-field, .workbench-settings-row')) {
      if (!visible(element)) continue;
      const rectangle = element.getBoundingClientRect();
      if (rectangle.left < bounds.left - 1 || rectangle.right > bounds.right + 1) issues.push(`${element.tagName}.${element.className} overflows horizontally`);
      if (element.matches('button') && element.scrollWidth > element.clientWidth + 2) issues.push(`button ${element.textContent} clips its label`);
    }
    for (const row of main.querySelectorAll('.workbench-settings-row, .manager-setting-row')) {
      const copy = row.querySelector('.workbench-settings-row-copy, .manager-setting-copy')?.getBoundingClientRect();
      const controls = row.querySelector('.workbench-settings-row-control, .manager-setting-control')?.getBoundingClientRect();
      if (copy && controls && Math.min(copy.right, controls.right) - Math.max(copy.left, controls.left) > 1 && Math.min(copy.bottom, controls.bottom) - Math.max(copy.top, controls.top) > 1) issues.push('setting text overlaps its controls');
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
  const settings = page.getByRole('main', { name: '设置', exact: true });
  await expect(settings).toBeVisible();
  await expect(page.locator('#workbench-settings-title')).toHaveText('常规');
  await expect(settings.getByRole('navigation', { name: '设置分类', exact: true })).toBeVisible();
  assert.equal(await settings.locator('.command-list, .command-categories, .command-total, .command-aliases').count(), 0);
  assert.equal(await settings.locator('code, pre').count(), 0, 'General settings must not expose terminal command syntax');
  await layoutChecks('general desktop');
  await page.screenshot({ path: path.join(qa, 'settings-general.png') });

  await settings.getByRole('button', { name: '更改', exact: true }).click();
  await expect(page.locator('#workbench-settings-title')).toHaveText('模型与权限');
  await settings.getByRole('combobox', { name: '思考强度', exact: true }).selectOption('low');
  await page.waitForFunction(async () => (await window.claudePanel.getState()).preferences.effort === 'low');
  await settings.getByRole('combobox', { name: '操作权限', exact: true }).selectOption('plan');
  await page.waitForFunction(async () => (await window.claudePanel.getState()).preferences.permissionMode === 'plan');
  const compactScope = settings.getByRole('combobox', { name: '压缩设置范围', exact: true });
  const compactWindow = settings.getByRole('combobox', { name: '自动压缩窗口', exact: true });
  await expect(compactScope).toHaveValue('model');
  await expect(compactWindow).toHaveValue('custom');
  await expect(settings.getByRole('spinbutton', { name: '上下文 Token 数', exact: true })).toHaveValue('700000');
  await compactWindow.selectOption('auto');
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.claudeOptions.modelAutoCompactWindows['claude-opus-4-6'] === 'auto');
  await expect(compactWindow).toHaveValue('auto');
  await compactScope.selectOption('all');
  await expect(compactWindow).toHaveValue('custom');
  await expect(settings.getByRole('spinbutton', { name: '上下文 Token 数', exact: true })).toHaveValue('500000');
  await compactScope.selectOption('model');
  await expect(compactWindow).toHaveValue('auto');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8')), expectedSettings);
  await layoutChecks('model desktop');

  await selectPage('chrome', '浏览器');
  await expect(settings.getByText('浏览器控制', { exact: true })).toBeVisible();
  await expect(settings.getByText('未检测', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '检测连接', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: '安装扩展', exact: true })).toBeEnabled();
  assert.equal(await settings.locator('code, pre').count(), 0);
  await layoutChecks('browser desktop');
  await page.screenshot({ path: path.join(qa, 'settings-browser-desktop.png') });

  await settings.getByRole('searchbox', { name: '搜索设置', exact: true }).fill('工具连接');
  await expect(settings.locator('[data-settings-page]')).toHaveCount(1);
  await settings.getByRole('searchbox', { name: '搜索设置', exact: true }).press('Enter');
  await expect(page.locator('#workbench-settings-title')).toHaveText('工具连接');
  await settings.getByRole('searchbox', { name: '搜索设置', exact: true }).fill('');
  await selectPage('plugin', '插件');
  await expect(settings.getByRole('button', { name: '安装插件', exact: true })).toBeEnabled();
  await selectPage('appearance', '外观');
  const alternateTheme = settings.locator('[data-theme-value="emerald"]');
  await alternateTheme.check();
  await page.waitForFunction(async () => (await window.claudePanel.getState()).preferences.theme === 'emerald');
  await expect(alternateTheme).toBeChecked();
  await layoutChecks('appearance desktop');
  await selectPage('icons', '图标与头像');
  await expect(settings.getByText('应用图标', { exact: true })).toBeVisible();
  await expect(settings.getByText('Claude 头像', { exact: true })).toBeVisible();
  await expect(settings.getByText('我的头像', { exact: true })).toBeVisible();
  await layoutChecks('icons desktop');
  await selectPage('memory', '项目规则');
  const rules = settings.getByRole('textbox', { name: '项目要求', exact: true });
  await expect(rules).toBeEnabled();
  await rules.fill('Always preserve the fixture settings.\n');
  await settings.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(settings.getByText('项目规则已保存。', { exact: true })).toBeVisible();
  const rulesFile = path.join(workspace, 'CLAUDE.md');
  const rulesBackup = path.join(workspace, 'CLAUDE.fixture-backup.md');
  assert.equal(await fs.readFile(rulesFile, 'utf8'), 'Always preserve the fixture settings.\n');
  await selectPage('general', '常规');
  await fs.rename(rulesFile, rulesBackup);
  await fs.mkdir(rulesFile);
  try {
    await selectPage('memory', '项目规则');
    await expect(settings.getByRole('alert').first()).toBeVisible();
    await expect(settings.getByRole('textbox', { name: '项目要求', exact: true })).toBeDisabled();
    await expect(settings.getByRole('button', { name: '保存规则', exact: true })).toBeDisabled();
    await expect(settings.getByRole('button', { name: '重新读取', exact: true })).toBeEnabled();
  } finally {
    await fs.rmdir(rulesFile);
    await fs.rename(rulesBackup, rulesFile);
  }
  await settings.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: '项目要求', exact: true })).toBeEnabled();
  await expect(settings.getByRole('textbox', { name: '项目要求', exact: true })).toHaveValue('Always preserve the fixture settings.\n');
  await expect(settings.getByRole('button', { name: '保存规则', exact: true })).toBeDisabled();
  await expect(settings.getByRole('alert')).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.claudePanel.getState())).error, null, 'Recovered settings errors must not leave a conversation error banner');

  await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: '命令中心', exact: true }).click();
  const operations = page.getByRole('dialog', { name: '命令中心', exact: true });
  await expect(operations).toBeVisible();
  await expect(operations.getByLabel('正在读取命令', { exact: true })).toHaveCount(0);
  assert.equal(await operations.locator('[data-command-id] code:visible').count(), 0, 'Common actions must use readable labels');
  assert.equal(await operations.locator('.command-total:visible').count(), 0);
  const commonCount = await operations.locator('[data-command-id]').count();
  await page.screenshot({ path: path.join(qa, 'settings-quick-actions-desktop.png') });
  await operations.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect.poll(() => operations.locator('[data-command-id]').count(), { message: 'More actions must reveal the complete catalog' }).toBeGreaterThan(commonCount);
  await operations.getByRole('button', { name: '关闭命令中心', exact: true }).click();
  for (const [id, heading] of [['model', '模型与权限'], ['mcp', '工具连接'], ['chrome', '浏览器']]) {
    await page.getByRole('button', { name: '命令中心', exact: true }).click();
    await page.locator(`[data-command-id="${id}"]`).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#workbench-settings-title')).toHaveText(heading);
    if (id !== 'chrome') await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  }
  await expect(settings.getByText('浏览器控制', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();

  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(800, 700); window.setSize(800, 700); });
  await expect(settings.getByRole('navigation', { name: '设置分类', exact: true })).toBeHidden();
  await expect(settings.getByRole('combobox', { name: '设置分类', exact: true })).toBeVisible();
  await layoutChecks('browser narrow');
  await page.screenshot({ path: path.join(qa, 'settings-browser-narrow.png') });
  await selectPage('mcp', '工具连接');
  await settings.getByRole('button', { name: '添加', exact: true }).click();
  await expect(settings.getByRole('radio', { name: '网络服务', exact: true })).toBeChecked();
  await settings.getByRole('textbox', { name: '名称', exact: true }).fill('fixture-visual-only');
  await settings.getByRole('textbox', { name: '服务器 URL', exact: true }).fill(`${baseUrl}/mcp-visual-only`);
  await layoutChecks('mcp form narrow');
  await page.screenshot({ path: path.join(qa, 'settings-mcp-form-narrow.png') });
  await selectPage('skills', '技能');
  await settings.getByRole('button', { name: '添加', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: '用途说明', exact: true })).toBeVisible();
  await expect(settings.getByRole('textbox', { name: '操作要求', exact: true })).toBeVisible();
  assert.equal(await settings.getByRole('textbox', { name: '内容', exact: true }).isVisible(), false);
  await layoutChecks('skills form narrow');
  await page.screenshot({ path: path.join(qa, 'settings-skills-form.png') });
  await selectPage('general', '常规');
  await layoutChecks('general narrow');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: '命令中心', exact: true }).click();
  await expect(operations).toBeVisible();
  await expect(operations.getByLabel('正在读取命令', { exact: true })).toHaveCount(0);
  const operationsOverflow = await operations.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth + 1);
  assert.equal(operationsOverflow, false, 'Narrow quick actions must not overflow horizontally');
  await page.screenshot({ path: path.join(qa, 'settings-quick-actions-narrow.png') });
  await operations.getByRole('button', { name: '关闭命令中心', exact: true }).click();

  const savedSettings = JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8'));
  assert.deepEqual(savedSettings, expectedSettings);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(configDirectory, '.claude.json'), 'utf8')).fixtureGlobal, { keep: true });
  assert.deepEqual(generationRequests, [], 'Settings must never request a generated response');
  assert.deepEqual(errors, [], 'Settings must not emit renderer errors');
  console.log('Electron settings integration passed: direct navigation, search, native controls, preferences, project rules, command jump, desktop/narrow layout, preserved credentials, no model generation.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(qa, 'settings-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await new Promise(resolve => modelServer.close(resolve));
}
