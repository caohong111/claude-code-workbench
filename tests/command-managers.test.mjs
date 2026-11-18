import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { manageCommand } from '../electron/command-managers.mjs';
import { TEST_ROOT } from './test-paths.mjs';

const { locateClaude } = createRequire(import.meta.url)('../electron/runtime-paths.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(TEST_ROOT, 'command-manager-'));
  const configDirectory = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(configDirectory);
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { configDirectory, workspace };
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('Chrome and IDE default flags write native global config while preserving auth and settings', async t => {
  const context = await fixture(t);
  const file = path.join(context.configDirectory, '.claude.json');
  await fs.writeFile(file, JSON.stringify({ oauthAccount: { accountUuid: 'preserved' }, projects: {} }));
  await fs.writeFile(path.join(context.configDirectory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-secret-value' } }));
  const result = await manageCommand('chrome', context, { action: 'toggle', enabled: true });
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.connected, false);
  assert.match(result.config.authRequirement, /中转站/);
  await manageCommand('ide', context, { action: 'toggle', enabled: true });
  const saved = await read(file);
  assert.equal(saved.claudeInChromeDefaultEnabled, true);
  assert.equal(saved.autoConnectIde, true);
  assert.equal(saved.oauthAccount.accountUuid, 'preserved');
  assert.equal((await read(path.join(context.configDirectory, 'settings.json'))).env.ANTHROPIC_AUTH_TOKEN, 'fixture-secret-value');
  assert.equal((await fs.readdir(path.join(context.configDirectory, 'panel-backups'))).length, 2);
});

test('MCP list does not start a process, shows native scopes and never returns stored credentials', async t => {
  const context = await fixture(t);
  context.runCli = async () => { throw new Error('list must not start servers'); };
  await fs.writeFile(path.join(context.configDirectory, '.claude.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://fixture.invalid', headers: { Authorization: 'Bearer fixture-secret-value' } } }, projects: { [context.workspace]: { mcpServers: { local: { command: 'fixture' } }, disabledMcpServers: ['remote'] } } }));
  const result = await manageCommand('mcp', context);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find(item => item.name === 'remote').enabled, false);
  assert.equal(result.items.find(item => item.name === 'local').scope, 'local');
  assert.equal(JSON.stringify(result).includes('fixture-secret-value'), false);
  await manageCommand('mcp', context, { action: 'toggle', name: 'remote', enabled: true });
  const saved = await read(path.join(context.configDirectory, '.claude.json'));
  assert.deepEqual(saved.projects[context.workspace].disabledMcpServers, []);
  assert.equal(saved.mcpServers.remote.headers.Authorization, 'Bearer fixture-secret-value');
});

test('MCP add/remove use official CLI and validate transports before executing', async t => {
  const context = await fixture(t);
  const calls = [];
  context.runCli = async args => { calls.push(args); return { stdout: 'OK', code: 0 }; };
  await manageCommand('mcp', context, { action: 'add', name: 'fixture', scope: 'project', type: 'stdio', command: 'node', args: ['D:\\test server\\server.js'], env: { API_KEY: 'fixture-secret-value' } });
  assert.deepEqual(calls[0].slice(0, 5), ['mcp', 'add-json', '--scope', 'project', 'fixture']);
  assert.deepEqual(JSON.parse(calls[0][5]).args, ['D:\\test server\\server.js']);
  await manageCommand('mcp', context, { action: 'remove', name: 'fixture', scope: 'project' });
  assert.deepEqual(calls[1], ['mcp', 'remove', '--scope', 'project', 'fixture']);
  await assert.rejects(manageCommand('mcp', context, { action: 'add', name: 'fixture', type: 'http', url: 'file:///C:/private' }), /HTTP/);
  assert.equal(calls.length, 2);
});

test('project MCP rejection overrides explicit and blanket approval from every settings scope', async t => {
  const context = await fixture(t);
  await fs.mkdir(path.join(context.workspace, '.claude'));
  await fs.writeFile(path.join(context.workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://fixture.invalid' } } }));
  await fs.writeFile(path.join(context.configDirectory, '.claude.json'), JSON.stringify({ projects: { [context.workspace]: { hasTrustDialogAccepted: true } } }));
  await fs.writeFile(path.join(context.configDirectory, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ['fixture'] }));
  await fs.writeFile(path.join(context.workspace, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ['fixture'], disabledMcpjsonServers: ['fixture'] }));
  let result = await manageCommand('mcp', context);
  assert.equal(result.items[0].enabled, false);
  assert.equal(result.items[0].rejected, true);
  assert.equal(result.items[0].pendingApproval, true);
  assert.match(result.items[0].error, /明确拒绝/);
  await manageCommand('mcp', context, { action: 'approve', name: 'fixture', scope: 'project' });
  result = await manageCommand('mcp', context);
  assert.equal(result.items[0].rejected, false);
  assert.equal(result.items[0].pendingApproval, false);
  await fs.writeFile(path.join(context.workspace, '.claude', 'settings.json'), JSON.stringify({ disabledMcpjsonServers: ['fixture'] }));
  result = await manageCommand('mcp', context);
  assert.equal(result.items[0].enabled, false);
  await assert.rejects(manageCommand('mcp', context, { action: 'approve', name: 'fixture', scope: 'project' }), /本地授权不能覆盖/);
});

test('hooks add and removal preserve unrelated config without running hook commands', async t => {
  const context = await fixture(t);
  const file = path.join(context.configDirectory, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-secret-value' }, permissions: { allow: ['Read'] } }));
  const result = await manageCommand('hooks', context, { action: 'add', scope: 'user', event: 'PostToolUse', matcher: 'Write|Edit', command: 'node lint.js', timeout: 30 });
  assert.equal(result.items[0].command, 'node lint.js');
  await manageCommand('hooks', context, { action: 'toggle', enabled: false });
  let saved = await read(file);
  assert.equal(saved.disableAllHooks, true);
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, 'fixture-secret-value');
  assert.equal(saved.hooks.PostToolUse[0].hooks[0].timeout, 30);
  await manageCommand('hooks', context, { action: 'remove', scope: 'user', event: 'PostToolUse', index: 0, revision: result.items[0].revision });
  saved = await read(file);
  assert.deepEqual(saved.hooks.PostToolUse, []);
  assert.deepEqual(saved.permissions, { allow: ['Read'] });
});

test('hook deletion refuses a stale list after an external reorder', async t => {
  const context = await fixture(t);
  await manageCommand('hooks', context, { action: 'add', event: 'PostToolUse', command: 'first command' });
  const result = await manageCommand('hooks', context, { action: 'add', event: 'PostToolUse', command: 'second command' });
  const file = path.join(context.configDirectory, 'settings.json');
  const saved = await read(file);
  saved.hooks.PostToolUse.reverse();
  await fs.writeFile(file, JSON.stringify(saved));
  await assert.rejects(manageCommand('hooks', context, { action: 'remove', event: 'PostToolUse', index: 0, revision: result.items[0].revision }), /Hook 已变更/);
  assert.equal((await read(file)).hooks.PostToolUse.length, 2);
});

test('document manager creates native skill, detects external edits, and backs up removals', async t => {
  const context = await fixture(t);
  const result = await manageCommand('skills', context, { action: 'create', name: 'fixture-skill', scope: 'project' });
  assert.equal(result.document.path, path.join(context.workspace, '.claude', 'skills', 'fixture-skill', 'SKILL.md'));
  assert.match(result.document.content, /description:/);
  await fs.appendFile(result.document.path, '\nExternal edit\n');
  await assert.rejects(manageCommand('skills', context, { action: 'save', path: result.document.path, revision: result.document.revision, content: 'replace' }), /其他程序修改/);
  await manageCommand('skills', context, { action: 'toggle', path: result.document.path, enabled: false });
  assert.equal((await read(path.join(context.workspace, '.claude', 'settings.local.json'))).skillOverrides['fixture-skill'], 'off');
  await manageCommand('skills', context, { action: 'remove', path: result.document.path });
  assert.equal(await fs.stat(result.document.path).then(() => true, () => false), false);
  assert.ok((await fs.readdir(path.join(context.configDirectory, 'panel-backups'))).some(name => name.startsWith('SKILL.md-')));
});

test('manager mutations reject malformed config and document traversal', async t => {
  const context = await fixture(t);
  await fs.writeFile(path.join(context.configDirectory, '.claude.json'), '{broken');
  await assert.rejects(manageCommand('chrome', context, { action: 'toggle', enabled: true }), /原文件未修改/);
  assert.equal(await fs.readFile(path.join(context.configDirectory, '.claude.json'), 'utf8'), '{broken');
  await fs.unlink(path.join(context.configDirectory, '.claude.json'));
  await assert.rejects(manageCommand('agents', context, { action: 'create', name: '../outside', scope: 'project' }), /名称/);
  await assert.rejects(manageCommand('agents', context, { action: 'save', path: path.join(context.workspace, 'outside.md'), content: 'text' }), /列表中的文件/);
});

test('external skill metadata supplies its native identity while body examples do not restrict visibility', async t => {
  const context = await fixture(t);
  const file = path.join(context.workspace, '.claude', 'skills', 'old-folder', 'SKILL.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = '\uFEFF---\r\nname: "metadata-skill"\r\ndescription: >-\r\n  A folded\r\n  description\r\n---\r\n\r\nExample configuration:\r\ndisable-model-invocation: true\r\nuser-invocable: false\r\n';
  await fs.writeFile(file, content);
  const listed = await manageCommand('skills', context);
  assert.equal(listed.items[0].name, 'metadata-skill');
  assert.equal(listed.items[0].description, 'A folded description');
  assert.equal(listed.items[0].toggleable, true);
  const document = await manageCommand('skills', context, { action: 'read', path: file });
  assert.equal(document.document.path, file);
  assert.equal(document.document.name, 'metadata-skill');
  assert.equal(document.document.content, content);
  assert.match(document.document.revision, /^[a-f0-9]{64}$/);
  await manageCommand('skills', context, { action: 'toggle', path: file, name: 'old-folder', visibility: 'name-only' });
  const saved = await read(path.join(context.workspace, '.claude', 'settings.local.json'));
  assert.deepEqual(saved.skillOverrides, { 'metadata-skill': 'name-only' });
  assert.equal((await manageCommand('skills', context)).items[0].visibility, 'name-only');
  assert.equal(await fs.readFile(file, 'utf8'), content);
});

test('skill restrictions use parsed frontmatter at the exact selected path and legacy files remain editable', async t => {
  const context = await fixture(t);
  const userFile = path.join(context.configDirectory, 'skills', 'unrestricted', 'SKILL.md');
  const projectFile = path.join(context.workspace, '.claude', 'skills', 'restricted', 'SKILL.md');
  await fs.mkdir(path.dirname(userFile), { recursive: true });
  await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.writeFile(userFile, '---\nname: shared-name\n---\nUser skill\n');
  await fs.writeFile(projectFile, '---\nname: shared-name\n"disable-model-invocation": true # manual only\n---\nProject skill\n');
  const listed = await manageCommand('skills', context);
  assert.equal(listed.items.find(item => item.path === projectFile).toggleable, false);
  await assert.rejects(manageCommand('skills', context, { action: 'toggle', path: projectFile, name: 'shared-name', visibility: 'on' }), /frontmatter/);
  await fs.writeFile(projectFile, '---\nname: shared-name\n"user-invocable": false # background knowledge\n---\nProject skill\n');
  await assert.rejects(manageCommand('skills', context, { action: 'toggle', path: projectFile, visibility: 'off' }), /frontmatter/);

  await fs.writeFile(projectFile, '# Written by another editor\n\nuser-invocable: false\n');
  const legacy = await manageCommand('skills', context, { action: 'read', path: projectFile });
  assert.equal(legacy.document.name, 'restricted');
  assert.equal(legacy.document.readOnly, false);
  await manageCommand('skills', context, { action: 'toggle', path: projectFile, visibility: 'off' });
  assert.equal((await read(path.join(context.workspace, '.claude', 'settings.local.json'))).skillOverrides.restricted, 'off');
  await fs.writeFile(projectFile, '---\nname: [broken yaml\n---\nBody\n');
  const malformed = await manageCommand('skills', context);
  assert.equal(malformed.items.find(item => item.path === projectFile).name, 'restricted');
});

test('external output styles select frontmatter names and redact metadata without changing source', async t => {
  const context = await fixture(t);
  const file = path.join(context.configDirectory, 'output-styles', 'old-filename.md');
  await fs.mkdir(path.dirname(file));
  const secret = 'sk-fixturemetadata123456789';
  const content = `---\nname: "Diagrams first"\ndescription: "Uses ${secret}"\nkeep-coding-instructions: true\n---\nLead with a diagram.\n`;
  await fs.writeFile(file, content);
  const listed = await manageCommand('output-style', context);
  assert.equal(listed.items[0].name, 'Diagrams first');
  assert.equal(listed.items[0].description, 'Uses [已隐藏]');
  assert.equal(JSON.stringify(listed).includes(secret), false);
  const selected = await manageCommand('output-style', context, { action: 'select', name: 'Diagrams first', scope: 'local' });
  assert.equal(selected.config.selected, 'Diagrams first');
  assert.equal((await read(path.join(context.workspace, '.claude', 'settings.local.json'))).outputStyle, 'Diagrams first');
  await assert.rejects(manageCommand('output-style', context, { action: 'select', name: 'old-filename', scope: 'local' }), /已有输出风格/);
  const document = await manageCommand('output-style', context, { action: 'read', path: file });
  assert.equal(document.document.name, 'Diagrams first');
  assert.equal(document.document.readOnly, true);
  assert.equal(JSON.stringify(document).includes(secret), false);
  assert.equal(await fs.readFile(file, 'utf8'), content);
});

test('local default output style overrides inherited styles and preserves every scope', async t => {
  const context = await fixture(t);
  const userFile = path.join(context.configDirectory, 'settings.json');
  const projectFile = path.join(context.workspace, '.claude', 'settings.json');
  const localFile = path.join(context.workspace, '.claude', 'settings.local.json');
  const user = { outputStyle: 'Concise', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-secret-value' } };
  const project = { outputStyle: 'Explanatory', permissions: { allow: ['Read'] } };
  const local = { fixtureLocal: { keep: true }, enabledMcpjsonServers: ['fixture'] };
  await fs.mkdir(path.dirname(projectFile));
  await fs.writeFile(userFile, JSON.stringify(user));
  await fs.writeFile(projectFile, JSON.stringify(project));
  await fs.writeFile(localFile, JSON.stringify(local));
  assert.equal((await manageCommand('output-style', context)).config.selected, 'Explanatory');

  const selected = await manageCommand('output-style', context, { action: 'select', name: 'Default', scope: 'local' });
  assert.equal(selected.config.selected, 'Default');
  assert.deepEqual(await read(localFile), { ...local, outputStyle: 'default' });
  assert.deepEqual(await read(userFile), user);
  assert.deepEqual(await read(projectFile), project);
  assert.equal((await manageCommand('output-style', context)).config.selected, 'Default');

  await fs.unlink(localFile);
  await fs.unlink(projectFile);
  assert.equal((await manageCommand('output-style', context)).config.selected, 'Concise');
  await manageCommand('output-style', context, { action: 'select', name: 'default', scope: 'local' });
  assert.equal((await read(localFile)).outputStyle, 'default');
  assert.equal((await manageCommand('output-style', context)).config.selected, 'Default');
  assert.deepEqual(await read(userFile), user);
});

test('output style and terminal settings write supported schemas without executing scripts', async t => {
  const context = await fixture(t);
  await manageCommand('output-style', context, { action: 'select', name: 'Concise', scope: 'user' });
  assert.equal((await read(path.join(context.configDirectory, 'settings.json'))).outputStyle, 'Concise');
  await manageCommand('statusline', context, { action: 'save', command: 'node D:\\AI\\status.js', padding: 2 });
  assert.deepEqual((await read(path.join(context.configDirectory, 'settings.json'))).statusLine, { type: 'command', command: 'node D:\\AI\\status.js', padding: 2 });
  await manageCommand('keybindings', context, { action: 'save', bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', 'ctrl+s': null } }] });
  assert.equal((await read(path.join(context.configDirectory, 'keybindings.json'))).bindings[0].bindings['ctrl+s'], null);
  const preset = await manageCommand('statusline', context, { action: 'preset', preset: 'detailed' });
  assert.equal(preset.config.selectedPreset, 'detailed');
  assert.match(preset.config.command, /powershell\.exe.*panel-statusline-detailed\.ps1/);
  const script = await fs.readFile(path.join(context.configDirectory, 'panel-statusline-detailed.ps1'), 'utf8');
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /total_cost_usd/);
  if (process.platform === 'win32') {
    const rendered = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(context.configDirectory, 'panel-statusline-detailed.ps1')], { input: JSON.stringify({ model: { display_name: 'Fixture model' }, context_window: { used_percentage: 27.4 }, cost: { total_cost_usd: 0.0123 }, workspace: { current_dir: context.workspace } }), encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, /Fixture model \| Context 27% \| USD 0.0123 \| workspace/);
  }
});

test('plugin install requires review of exact marketplace command and preserves uninstall data', async t => {
  const context = await fixture(t);
  const sha256 = 'a'.repeat(64);
  const calls = [];
  context.runCli = async args => {
    calls.push(args);
    if (args[1] === 'list') return { stdout: JSON.stringify([{ id: 'fixture@market', version: '1.0.0', scope: 'user', enabled: true }]), code: 0 };
    if (args[1] === 'install' && !args.includes('--accept-command')) return { stdout: JSON.stringify({ outcome: 'failed', message: 'Review install command', shownCommand: { command: 'node installer.js', sha256 } }), code: 1 };
    return { stdout: JSON.stringify({ outcome: 'success', message: 'Installed' }), code: 0 };
  };
  const result = await manageCommand('plugin', context, { action: 'install', name: 'fixture@market' });
  assert.equal(result.changed, false);
  assert.equal(result.pendingCommand.command, 'node installer.js');
  await assert.rejects(manageCommand('plugin', context, { action: 'install', name: 'fixture@market', acceptCommand: 'b'.repeat(64) }), /确认已过期/);
  const confirmed = await manageCommand('plugin', context, { action: 'install', name: 'fixture@market', acceptCommand: sha256 });
  assert.equal(confirmed.changed, true);
  assert.ok(calls.some(args => args.includes('--accept-command') && args.includes(sha256)));
  assert.equal(calls.some(args => args.includes('--yes')), false);
  await manageCommand('plugin', context, { action: 'uninstall', name: 'fixture@market' });
  assert.ok(calls.at(-2).includes('--keep-data'));
});

test('installed native CLI writes and removes MCP configurations in the isolated config', async t => {
  const { executablePath } = locateClaude();
  if (process.platform !== 'win32' || !executablePath) return t.skip('Native Windows Claude CLI or SDK binary unavailable');
  const context = { ...await fixture(t), executablePath };
  context.tempDirectory = path.join(context.configDirectory, 'temp');
  context.cacheDirectory = path.join(context.configDirectory, 'cache');
  await fs.mkdir(context.tempDirectory);
  await fs.mkdir(context.cacheDirectory);
  const added = await manageCommand('mcp', context, { action: 'add', name: 'panel-native-fixture', scope: 'user', type: 'http', url: 'https://fixture.invalid/mcp' });
  assert.equal(added.items.find(item => item.name === 'panel-native-fixture').url, 'https://fixture.invalid/mcp');
  assert.equal((await read(path.join(context.configDirectory, '.claude.json'))).mcpServers['panel-native-fixture'].type, 'http');
  const removed = await manageCommand('mcp', context, { action: 'remove', name: 'panel-native-fixture', scope: 'user' });
  assert.equal(removed.items.some(item => item.name === 'panel-native-fixture'), false);
  const pluginList = await manageCommand('plugin', context);
  assert.deepEqual(pluginList.items, []);
});
