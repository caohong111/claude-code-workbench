import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const themes = JSON.parse(await fs.readFile(path.join(root, 'themes.json'), 'utf8'));
const output = path.join(root, 'output', 'theme-check');
const isolated = path.join(TEST_ROOT, `desktop-themes-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const config = path.join(isolated, 'config');
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'claude-theme-fixture', display_name: 'Claude Theme Fixture' }], has_more: false }));
});
await Promise.all([fs.mkdir(output, { recursive: true }), fs.mkdir(workspace, { recursive: true }), fs.mkdir(config, { recursive: true })]);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureSettings = { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'theme-test-fixture-token' } };
await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify(fixtureSettings));
await fs.writeFile(path.join(workspace, 'README.md'), '# Isolated theme checks\n');
const env = { ...process.env, CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: config, CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'), TEMP: TEST_ROOT, TMP: TEST_ROOT };
delete env.ELECTRON_RUN_AS_NODE;
const options = { executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], env, timeout: 30000 };
let application;
let page;
const errors = [];
const results = [];

async function launch() {
  application = await electron.launch(options);
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
}

async function appearancePage() {
  await page.getByRole('button', { name: '连接与设置', exact: true }).click();
  await page.locator('[data-settings-page="appearance"]').click();
  await expect(page.locator('#workbench-settings-title')).toHaveText('外观');
}

async function chooseTheme(theme) {
  const radio = page.locator(`[data-theme-value="${theme.value}"]`);
  await expect(radio).toBeEnabled();
  await radio.check();
  await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme.value);
  await page.waitForFunction(async id => (await window.claudePanel.getState()).preferences.theme === id, theme.value);
  await expect(radio).toBeChecked();
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), theme.scheme, `${theme.name}: native theme source`);
}

async function themePaint() {
  return page.evaluate(() => {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    const probe = document.createElement('i');
    document.body.append(probe);
    const context = document.createElement('canvas').getContext('2d');
    const color = token => {
      probe.style.color = `var(${token})`;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(probe).color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = channels => channels.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    const result = {
      scheme: computed.colorScheme,
      metadata: document.querySelector('meta[name="color-scheme"]')?.content,
      surface: color('--surface'),
      text: contrast(color('--text'), color('--surface')),
      secondary: contrast(color('--text-secondary'), color('--sidebar')),
      muted: contrast(color('--text-muted'), color('--sidebar')),
      button: contrast(color('--accent-ink'), color('--accent')),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
    probe.remove();
    return result;
  });
}

try {
  await launch();
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, workspace);
  await page.locator('.open-folder-button').click();
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  await appearancePage();
  assert.deepEqual(await page.locator('.theme-group-label').allTextContents(), ['基础主题', '通用配色', '粉色系']);
  await expect(page.locator('[data-theme-value]')).toHaveCount(16);
  for (const theme of themes) {
    await expect(page.getByRole('radio', { name: theme.name, exact: true })).toHaveCount(1);
    await expect(page.locator(`[data-theme-value="${theme.value}"]`).locator('..').locator('.theme-swatches > i')).toHaveCount(theme.swatches.length);
  }

  for (const theme of themes) {
    await chooseTheme(theme);
    const paint = await themePaint();
    assert.equal(paint.scheme, theme.scheme, `${theme.name}: renderer color scheme`);
    assert.equal(paint.metadata, theme.scheme, `${theme.name}: metadata color scheme`);
    assert.equal(paint.horizontalOverflow, false, `${theme.name}: page horizontal overflow`);
    for (const name of ['text', 'secondary', 'muted', 'button']) assert.ok(paint[name] >= 4.5, `${theme.name}: ${name} contrast ${paint[name].toFixed(2)}`);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.screenshot({ path: path.join(output, `${theme.value}.png`) });
    results.push({ theme: theme.value, ...paint });
    await appearancePage();
  }
  assert.equal(new Set(results.map(result => result.surface.join(','))).size, 16, 'All themes must change the main surface');

  const selected = themes.find(theme => theme.value === 'black-gold');
  await chooseTheme(selected);
  await application.close();
  application = null;
  await launch();
  await page.waitForFunction(id => document.documentElement.dataset.theme === id, selected.value);
  const restored = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(restored.preferences.theme, selected.value);
  assert.equal(restored.workspace.path, workspace);
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), selected.scheme);

  await appearancePage();
  const narrowTheme = themes.find(theme => theme.value === 'pink-blue-macaron');
  await chooseTheme(narrowTheme);
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(800, 700); window.setSize(800, 760); });
  const layout = await page.locator('.theme-picker').evaluate(picker => {
    const bounds = picker.getBoundingClientRect();
    return [...picker.querySelectorAll('.theme-option')].map(option => {
      const rectangle = option.getBoundingClientRect();
      const title = option.querySelector('.theme-option-meta strong');
      return { clipped: title.scrollWidth > title.clientWidth + 1, outside: rectangle.left < bounds.left - 1 || rectangle.right > bounds.right + 1 };
    });
  });
  assert.ok(layout.every(item => !item.clipped && !item.outside), 'Narrow theme names and controls must fit');
  await page.locator(`[data-theme-value="${narrowTheme.value}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'themes-narrow.png') });
  await application.close();
  application = null;
  await launch();
  await page.waitForFunction(id => document.documentElement.dataset.theme === id, narrowTheme.value);
  assert.equal((await page.evaluate(() => window.claudePanel.getState())).preferences.theme, narrowTheme.value);
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), narrowTheme.scheme);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(config, 'settings.json'), 'utf8')), fixtureSettings);
  assert.equal(requests.some(request => request.method === 'POST'), false, 'Theme checks must not request generation');
  assert.deepEqual(errors, [], 'Themes must not cause renderer errors');
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ themes: results, grouped: true, narrowLayout: true, persistence: ['black-gold', 'pink-blue-macaron'], rendererErrors: errors }, null, 2));
  console.log('Electron theme checks passed: 16 palettes, grouped picker, native/renderer schemes, readable text, 16 workspace screenshots, narrow layout, dark/light restart persistence.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'theme-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await new Promise(resolve => server.close(resolve));
}
