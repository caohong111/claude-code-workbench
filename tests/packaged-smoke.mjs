import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TEST_ROOT } from './test-paths.mjs';

const directory = path.resolve(process.argv[2] || 'release/win-unpacked');
const isolated = path.join(TEST_ROOT, `packaged-${randomUUID()}`);
const configDirectory = path.join(isolated, 'config');
const workspace = path.join(isolated, 'workspace');
await fs.mkdir(configDirectory, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# Packaged application fixture\n');
const env = {
  ...process.env,
  CLAUDE_PANEL_TEST: '1',
  CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'),
  CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory,
  CLAUDE_CONFIG_DIR: configDirectory,
  CLAUDE_WORKBENCH_HOME: isolated,
  TEMP: TEST_ROOT,
  TMP: TEST_ROOT,
};
for (const name of ['ELECTRON_RUN_AS_NODE', 'CLAUDE_PANEL_DEV_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_EXECUTABLE']) delete env[name];
const binary = path.join(directory, 'resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
assert.match(execFileSync(binary, ['--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 }), /Claude Code/);
await fs.access(path.join(directory, 'resources', 'app-icon.ico'));
await fs.access(path.join(directory, 'resources', 'licenses', 'manifest.json'));
let application;
const errors = [];
try {
  application = await electron.launch({ executablePath: path.join(directory, 'Claude Code Workbench.exe'), env, timeout: 30000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台' }).waitFor();
  const metadata = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, root: app.getAppPath(), userData: app.getPath('userData') }));
  assert.equal(metadata.packaged, true);
  assert.match(metadata.root, /app\.asar$/);
  assert.equal(path.relative(isolated, metadata.userData).startsWith('..'), false);
  const initial = await page.evaluate(() => window.claudePanel.getState());
  assert.equal(initial.workspaces.length, 0);
  assert.equal(initial.connection.hasCredential, false);
  await application.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, workspace);
  await page.locator('.open-folder-button').click();
  await page.getByRole('button', { name: '了解项目' }).waitFor();
  await page.getByRole('button', { name: '连接与设置', exact: true }).click();
  await page.locator('[data-settings-page="appearance"]').click();
  await page.locator('[data-theme-value="graphite"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'graphite');
  await page.locator('[data-settings-page="icons"]').click();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.appearance-asset-preview img')];
    return images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  await fs.mkdir('qa', { recursive: true });
  await page.screenshot({ path: 'qa/packaged-settings.png' });
  assert.deepEqual(errors, []);
  console.log('Packaged application passed: isolated first launch, bundled CLI, licenses, workspace, theme, and default artwork.');
} finally {
  if (application) await application.close();
}
