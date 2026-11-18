import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const qa = path.join(root, 'qa');
const isolated = path.join(TEST_ROOT, `desktop-e2e-${randomUUID()}`);
const fixture = path.join(isolated, 'workspace');
const isLive = process.env.CLAUDE_PANEL_LIVE_TEST === '1';
let modelServer;
let firstProvider;
let secondProvider;
let chosenModel = 'opus';
await fs.mkdir(fixture, { recursive: true });
await fs.mkdir(qa, { recursive: true });
await fs.writeFile(path.join(fixture, 'README.md'), '# Desktop test workspace\n');
const env = { ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'), TEMP: TEST_ROOT, TMP: TEST_ROOT };
if (!isLive) {
  modelServer = createServer((request, response) => {
    const second = request.url.startsWith('/second/');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: second ? [{ id: 'gpt-fixture-2', display_name: 'GPT Channel Two' }] : [{ id: 'gpt-fixture-1', display_name: 'GPT Channel One' }, { id: 'claude-fixture-1', display_name: 'Claude Channel One' }], has_more: false }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${modelServer.address().port}`;
  firstProvider = `${address}/first`;
  secondProvider = `${address}/second`;
  env.CLAUDE_PANEL_TEST_CONFIG_DIR = path.join(isolated, 'config');
  await fs.mkdir(env.CLAUDE_PANEL_TEST_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(env.CLAUDE_PANEL_TEST_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: firstProvider, ANTHROPIC_AUTH_TOKEN: 'fixture-key-one' } }));
  chosenModel = 'gpt-fixture-1';
}
delete env.ELECTRON_RUN_AS_NODE;
const options = { executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env, timeout: 30000 };
let application;
const errors = [];
try {
  application = await electron.launch(options);
  let page = await application.firstWindow();
  async function chooseModel(id, value) {
    await page.locator(`#${id}`).click();
    await page.locator(`[role="option"][data-model-id="${value}"]`).click();
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台' }).waitFor();
  await page.screenshot({ path: path.join(qa, 'desktop-empty.png') });
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, fixture);
  await page.locator('.open-folder-button').click();
  await page.getByRole('button', { name: '了解项目' }).waitFor();
  assert.equal((await page.evaluate(() => window.claudePanel.getState())).preferences.model, 'default');
  assert.match(await page.locator('#composer-model').innerText(), /跟随 CC Switch/);
  if (!isLive) {
    await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.models.some(model => model.id === 'gpt-fixture-1'));
    assert.equal((await page.evaluate(() => window.claudePanel.getState())).connection.catalog.models.some(model => model.id === 'sonnet'), false, 'No hard-coded model aliases');
    await chooseModel('composer-model', chosenModel);
  } else {
    await chooseModel('composer-model', '__custom__');
    await page.locator('#composer-model-custom').fill(chosenModel);
    await page.getByRole('button', { name: '应用模型', exact: true }).click();
  }
  await page.getByRole('button', { name: '连接与设置', exact: true }).click();
  await page.locator('.workbench-settings').waitFor();
  await page.locator('[data-settings-page="connection"]').click();
  const connection = (await page.evaluate(() => window.claudePanel.getState())).connection;
  assert.ok((await page.locator('.workbench-settings').innerText()).includes(connection.baseUrl));
  assert.doesNotMatch(await page.locator('.workbench-settings').innerText(), /sk-[A-Za-z0-9_-]{12,}/);
  await page.locator('[data-settings-page="icons"]').click();
  for (const name of ['更换应用图标', '更换Claude 头像', '更换我的头像']) await page.locator('.appearance-assets').getByRole('button', { name, exact: true }).waitFor();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.appearance-asset-preview img')];
    return images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  const previews = await page.locator('.appearance-asset-preview img').evaluateAll(images => images.map(image => image.complete && image.naturalWidth > 0));
  assert.equal(previews.length, 3);
  assert.ok(previews.every(Boolean), 'Application icon and both avatars must render in appearance settings');
  await page.locator('[data-settings-page="model"]').click();
  await page.locator('#settings-effort').selectOption('low');
  const themes = ['tech-dark', 'graphite', 'emerald', 'light'];
  const surfaces = [];
  for (const theme of themes) {
    await page.locator('[data-settings-page="appearance"]').click();
    await page.locator(`[data-theme-value="${theme}"]`).click();
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    await page.waitForFunction(value => document.querySelector(`[data-theme-value="${value}"]`).checked, theme);
    await page.waitForFunction(async value => (await window.claudePanel.getState()).preferences.theme === value, theme);
    assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), theme === 'light' ? 'light' : 'dark');
    surfaces.push(await page.locator('.workbench-settings').evaluate(element => getComputedStyle(element).backgroundColor));
    await page.locator('[data-settings-page="model"]').click();
    await page.locator('#settings-model').click();
    const picker = page.locator('.model-picker-popup');
    await picker.waitFor();
    const selectedOption = picker.locator(`[role="option"][data-model-id="${chosenModel}"]`);
    await selectedOption.hover();
    if (theme !== 'light') {
      for (const element of [picker, selectedOption]) {
        const color = await element.evaluate(node => getComputedStyle(node).backgroundColor);
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number);
        assert.ok(channels.some(channel => channel < 180), `Dark-theme model picker must not have a white background: ${color}`);
      }
    }
    const box = await picker.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'Model popup must stay within the viewport');
    await page.screenshot({ path: path.join(qa, `desktop-model-picker-${theme}.png`) });
    await page.getByRole('searchbox', { name: '筛选模型', exact: true }).press('Escape');
    await page.screenshot({ path: path.join(qa, `desktop-settings-${theme}.png`) });
  }
  assert.ok(new Set(surfaces).size >= 3, 'Themes must change page surfaces as well as accent colors');
  await page.locator('[data-settings-page="appearance"]').click();
  await page.locator('[data-theme-value="tech-dark"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'tech-dark');
  await page.screenshot({ path: path.join(qa, 'desktop-settings.png') });
  await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  await page.getByRole('button', { name: '命令中心', exact: true }).click();
  await page.getByRole('dialog', { name: '命令中心', exact: true }).waitFor();
  await page.locator('[data-command-id="model"]').waitFor();
  await page.getByRole('searchbox', { name: '搜索命令', exact: true }).fill('/effort');
  await page.locator('[data-command-id="effort"]').waitFor();
  await page.screenshot({ path: path.join(qa, 'desktop-command-center.png') });
  await page.getByRole('button', { name: '关闭命令中心', exact: true }).click();
  if (!isLive) {
    const hostState = await page.evaluate(() => window.claudePanel.getState());
    const createdAt = new Date().toISOString();
    const renderedState = { ...hostState, session: { ...hostState.session, messages: [
      ...hostState.session.messages,
      { id: 'smoke-user-layout', role: 'user', text: '用户侧布局检查', createdAt },
      { id: 'smoke-assistant-layout', role: 'assistant', text: '助手侧布局检查', createdAt },
    ] } };
    await application.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('panel:state', snapshot), renderedState);
    const user = page.locator('.message-user').filter({ hasText: '用户侧布局检查' });
    const assistant = page.locator('.message-assistant').filter({ hasText: '助手侧布局检查' });
    await user.waitFor();
    const userAvatar = await user.locator('.message-avatar').boundingBox();
    const assistantAvatar = await assistant.locator('.message-avatar').boundingBox();
    assert.ok(userAvatar.x > assistantAvatar.x + 100, 'User avatar must sit to the right of the assistant avatar');
    await page.screenshot({ path: path.join(qa, 'desktop-message-alignment.png') });
    await application.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('panel:state', snapshot), hostState);
    await user.waitFor({ state: 'hidden' });
  }
  await page.getByRole('button', { name: /README.md/ }).click();
  await page.locator('.file-preview').waitFor();
  await page.screenshot({ path: path.join(qa, 'desktop-workspace.png') });
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('保留这段尚未发送的草稿');
  for (const theme of themes) {
    await page.getByRole('button', { name: '连接与设置', exact: true }).click();
    await page.locator('[data-settings-page="appearance"]').click();
    await page.locator(`[data-theme-value="${theme}"]`).click();
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '输入任务', exact: true }).inputValue(), '保留这段尚未发送的草稿');
    await page.screenshot({ path: path.join(qa, `desktop-workspace-${theme}.png`) });
  }
  await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('');

  if (!isLive) {
    await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('渠道切换时保留的草稿');
    const replacement = path.join(env.CLAUDE_PANEL_TEST_CONFIG_DIR, 'settings.next');
    await fs.writeFile(replacement, JSON.stringify({ env: { ANTHROPIC_BASE_URL: secondProvider, ANTHROPIC_AUTH_TOKEN: 'fixture-key-two' } }));
    await fs.rename(replacement, path.join(env.CLAUDE_PANEL_TEST_CONFIG_DIR, 'settings.json'));
    await page.waitForFunction(async expected => { const value = await window.claudePanel.getState(); return value.connection.baseUrl === expected && value.connection.catalog.status === 'ready'; }, secondProvider);
    const afterSwitch = await page.evaluate(() => window.claudePanel.getState());
    assert.ok(afterSwitch.connection.catalog.models.some(model => model.id === 'gpt-fixture-2'));
    assert.equal(afterSwitch.connection.catalog.models.some(model => model.id === 'gpt-fixture-1'), false, 'Old channel models must be removed');
    assert.equal(afterSwitch.preferences.model, 'default', 'Channel switch clears old explicit selection');
    assert.match(await page.locator('#composer-model').innerText(), /跟随 CC Switch/);
    assert.equal(await page.getByRole('textbox', { name: '输入任务', exact: true }).inputValue(), '渠道切换时保留的草稿');
    chosenModel = 'gpt-fixture-2';
    await chooseModel('composer-model', chosenModel);
    await page.waitForFunction(async expected => (await window.claudePanel.getState()).preferences.model === expected, chosenModel);
    const changed = await page.evaluate(() => window.claudePanel.getState());
    assert.equal(changed.preferences.modelSourceId, changed.connection.sourceId);
    assert.ok(!JSON.stringify(changed).includes('fixture-key'));
    await page.screenshot({ path: path.join(qa, 'desktop-channel-models.png') });
    await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('');
  }

  if (process.env.CLAUDE_PANEL_LIVE_TEST === '1') {
    const sends = await page.evaluate(async () => {
      const results = await Promise.allSettled([
        window.claudePanel.sendMessage({ text: 'Use the Write tool to create two files in the current folder: panel-check.txt with exactly WORKBENCH_READY, and panel-check-2.txt with exactly SECOND_FILE_READY. These writes are independent, so issue the two Write calls together. Do not modify any other file. After writing reply with exactly GUI_CHECK_OK.', model: 'opus', effort: 'low', permissionMode: 'manual' }),
        window.claudePanel.sendMessage({ text: 'This duplicate task must be rejected before reaching the model.' }),
      ]);
      return results.map(result => result.status);
    });
    assert.equal(sends.filter(status => status === 'fulfilled').length, 1, 'Only one concurrent send may start');
    assert.equal(sends.filter(status => status === 'rejected').length, 1, 'The duplicate send must be rejected');
    await page.evaluate(() => window.claudePanel.clearError());
    const deadline = Date.now() + 120000;
    let approved = 0;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => window.claudePanel.getState());
      if (state.permission) {
        const candidate = state.permission.input?.file_path;
        const isAllowed = state.permission.toolName === 'Write' && candidate && ['panel-check.txt', 'panel-check-2.txt'].some(name => path.resolve(fixture, candidate) === path.join(fixture, name));
        await page.screenshot({ path: path.join(qa, 'desktop-permission.png') });
        await page.locator('.permission-modal').waitFor();
        await page.locator('.permission-modal').getByRole('button', { name: isAllowed ? '允许一次' : '拒绝', exact: true }).click();
        if (isAllowed) approved += 1;
      }
      if (!state.run) {
        assert.equal(state.error, null, state.error || '');
        assert.match(state.session.messages.at(-1).text, /GUI_CHECK_OK/);
        assert.equal(await fs.readFile(path.join(fixture, 'panel-check.txt'), 'utf8'), 'WORKBENCH_READY');
        assert.ok(approved >= 2, 'Both writes required an explicit GUI confirmation');
        assert.ok(state.session.changes.some(change => change.path === 'panel-check.txt' && change.status === 'added'));
        assert.ok(state.session.changes.some(change => change.path === 'panel-check-2.txt' && change.status === 'added'));
        break;
      }
      await page.waitForTimeout(200);
    }
    const state = await page.evaluate(() => window.claudePanel.getState());
    assert.equal(state.run, null, 'Live task must finish before the timeout');
    const avatarImages = await page.locator('.message-avatar img').evaluateAll(images => images.map(image => ({ loaded: image.complete && image.naturalWidth > 0, src: image.getAttribute('src') })));
    assert.ok(avatarImages.length >= 2 && avatarImages.every(image => image.loaded), 'Both supplied chat avatars must render');
    await page.getByRole('button', { name: '文件与操作记录', exact: true }).click();
    await page.getByRole('tab', { name: /更改/ }).click();
    await page.getByRole('button', { name: /panel-check.txt.*新增/ }).click();
    await page.screenshot({ path: path.join(qa, 'desktop-live-result.png') });
    console.log(JSON.stringify({ live: 'passed', permissionApprovals: approved, changes: state.session.changes.map(change => change.path), toolCount: state.session.tools.length, sessionId: state.session.claudeSessionId }));
  }
  const beforeClose = await page.evaluate(() => window.claudePanel.getState());
  await application.close();
  application = await electron.launch(options);
  page = await application.firstWindow();
  await page.getByRole('heading', { name: 'Claude 工作台' }).waitFor();
  const restored = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(restored.workspace.path, fixture);
  assert.equal(restored.preferences.model, chosenModel);
  assert.equal(restored.preferences.theme, 'light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'light');
  assert.equal(restored.session.id, beforeClose.session.id);
  assert.equal(restored.session.messages.length, beforeClose.session.messages.length);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Electron desktop smoke passed: channel-model synchronization, themed model menus, command center, appearance entries, draft retention, themes, preferences and history restore, no renderer errors.');
} finally {
  if (application) await application.close();
  if (modelServer) await new Promise(resolve => modelServer.close(resolve));
}
