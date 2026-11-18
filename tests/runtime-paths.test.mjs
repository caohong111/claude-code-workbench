import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TEST_ROOT } from './test-paths.mjs';

const require = createRequire(import.meta.url);
const { isWorkbenchShortcut, locateClaude, resolveRuntimePaths } = require('../electron/runtime-paths.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(root, 'tests', '.fixture-home');
const missing = () => { throw new Error('not installed'); };

test('public defaults separate read-only app files from writable user data and native Claude configuration', () => {
  const appRoot = path.join(root, 'Program Files', 'resources', 'app.asar');
  const runtime = resolveRuntimePaths({ appRoot, homeDirectory: home, platform: 'win32', environment: {}, resolveModule: missing, exists: () => false });
  assert.equal(runtime.appRoot, appRoot);
  assert.equal(runtime.homeDirectory, path.join(home, 'AppData', 'Local', 'ClaudeCodeWorkbench'));
  assert.equal(runtime.configDirectory, path.join(home, '.claude'));
  assert.equal(runtime.dataRoot, path.join(runtime.homeDirectory, 'data'));
  assert.equal(runtime.tempDirectory, path.join(runtime.homeDirectory, 'temp'));
  assert.equal(runtime.cacheDirectory, path.join(runtime.homeDirectory, 'cache'));
  assert.equal(runtime.executablePath, null);
  assert.equal(runtime.source, 'missing');
});

test('custom installation home and existing Claude configuration are respected without modifying either', () => {
  const chosenHome = path.join(root, 'custom-install-data');
  const configDirectory = path.join(root, 'existing-claude-config');
  const runtime = resolveRuntimePaths({ appRoot: root, homeDirectory: home, environment: { CLAUDE_WORKBENCH_HOME: chosenHome, CLAUDE_CONFIG_DIR: configDirectory }, resolveModule: missing, exists: () => false });
  assert.equal(runtime.homeDirectory, chosenHome);
  assert.equal(runtime.configDirectory, configDirectory);
  assert.equal(runtime.dataRoot, path.join(chosenHome, 'data'));
});

test('desktop fixture environment keeps configuration, histories and temporary files isolated', () => {
  const fixtureRoot = path.join(root, 'tests', 'isolated');
  const runtime = resolveRuntimePaths({ appRoot: root, homeDirectory: home, environment: {
    CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_DATA_DIR: path.join(fixtureRoot, 'state'),
    CLAUDE_PANEL_TEST_CONFIG_DIR: path.join(fixtureRoot, 'config'), CLAUDE_CONFIG_DIR: path.join(home, 'private-config'),
    CLAUDE_WORKBENCH_HOME: path.join(home, 'private-workbench-data'),
  }, resolveModule: missing, exists: () => false });
  assert.equal(runtime.homeDirectory, fixtureRoot);
  assert.equal(runtime.dataRoot, path.join(fixtureRoot, 'state'));
  assert.equal(runtime.configDirectory, path.join(fixtureRoot, 'config'));
  assert.equal(runtime.tempDirectory, path.join(fixtureRoot, 'temp'));
});

test('native installed Claude and an explicit binary override take precedence over SDK binaries', () => {
  const native = path.join(home, '.local', 'bin', 'claude.exe');
  const custom = path.join(root, 'custom-cli', 'claude.exe');
  const exists = file => [native, custom].includes(file);
  assert.equal(locateClaude({ environment: {}, homeDirectory: home, platform: 'win32', exists, resolveModule: missing }).executablePath, native);
  assert.equal(locateClaude({ environment: { CLAUDE_CODE_EXECUTABLE: custom }, homeDirectory: home, platform: 'win32', exists, resolveModule: missing }).executablePath, custom);
  assert.throws(() => locateClaude({ environment: { CLAUDE_CODE_EXECUTABLE: 'relative.exe' }, homeDirectory: home, exists, resolveModule: missing }), /CLAUDE_CODE_EXECUTABLE/);
});

test('PATH discovery accepts a native executable without spawning a shell', () => {
  const bin = path.join(root, 'public-bin');
  const executable = path.join(bin, 'claude.exe');
  const result = locateClaude({ environment: { PATH: bin }, homeDirectory: home, platform: 'win32', exists: file => file === executable, resolveModule: missing });
  assert.equal(result.executablePath, executable);
  assert.equal(result.source, 'installed');
});

test('SDK fallback uses the unpacked native binary and reports the Claude version rather than SDK version', async t => {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, 'runtime-paths-'));
  t.after(async () => { assert.equal(path.dirname(directory), TEST_ROOT); await fs.rm(directory, { recursive: true, force: true }); });
  const sdkDirectory = path.join(directory, 'sdk');
  await fs.mkdir(sdkDirectory, { recursive: true });
  await fs.writeFile(path.join(sdkDirectory, 'package.json'), JSON.stringify({ version: '0.3.326', claudeCodeVersion: '2.1.326' }));
  const binaryPackage = path.join(directory, 'app.asar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'package.json');
  const executable = path.join(path.dirname(binaryPackage), 'claude.exe').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const result = locateClaude({ environment: {}, homeDirectory: home, platform: 'win32', arch: 'x64', exists: file => file === executable, resolveModule: id => id.endsWith('/package.json') ? binaryPackage : path.join(sdkDirectory, 'sdk.mjs') });
  assert.equal(result.executablePath, executable);
  assert.equal(result.claudeVersion, '2.1.326');
  assert.equal(result.source, 'sdk');
});

test('icon updates recognize only this source or installed application shortcut', () => {
  const executablePath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const source = { appRoot: root, executablePath, isPackaged: false };
  assert.equal(isWorkbenchShortcut({ target: executablePath, args: `"${root}"` }, source), true);
  assert.equal(isWorkbenchShortcut({ target: path.join(root, 'System32', 'wscript.exe'), args: `//nologo "${path.join(root, 'launch.vbs')}" "${home}"` }, source), true);
  assert.equal(isWorkbenchShortcut({ target: executablePath, args: `"${path.join(root, 'another-app')}"` }, source), false);
  assert.equal(isWorkbenchShortcut({ target: executablePath, args: `"${root}-another-app"` }, source), false);
  assert.equal(isWorkbenchShortcut({ target: path.join(root, 'unrelated.exe'), args: `"${path.join(root, 'launch.vbs')}"` }, source), false);
  const installed = { appRoot: path.join(root, 'resources', 'app.asar'), executablePath: path.join(root, 'Claude Code Workbench.exe'), isPackaged: true };
  assert.equal(isWorkbenchShortcut({ target: installed.executablePath, args: '' }, installed), true);
  assert.equal(isWorkbenchShortcut({ target: executablePath, args: `"${root}"` }, installed), false);
});
