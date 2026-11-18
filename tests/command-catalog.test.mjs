import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { BUILTIN_COMMANDS, COMMAND_CATEGORIES, buildCommandCatalog, discoverSupportedCommands } from '../electron/command-catalog.mjs';

test('keeps command identities unique and every command in an actual category', () => {
  const categories = new Set(COMMAND_CATEGORIES.map(row => row.id));
  assert.equal(new Set(BUILTIN_COMMANDS.map(row => row.id)).size, BUILTIN_COMMANDS.length);
  assert.ok(BUILTIN_COMMANDS.length >= 80);
  for (const row of BUILTIN_COMMANDS) {
    assert.ok(categories.has(row.category));
    assert.equal(row.command, `/${row.id}`);
    assert.ok(row.label && row.description);
  }
  assert.ok(BUILTIN_COMMANDS.find(row => row.id === 'usage').aliases.includes('cost'));
});

test('only enables SDK commands after runtime discovery and does not pretend new builtins are skills', () => {
  const initial = buildCommandCatalog();
  assert.equal(initial.find(row => row.id === 'compact').available, false);
  assert.equal(initial.find(row => row.id === 'theme').available, true);
  const commands = buildCommandCatalog({ discovered: true, supportedCommands: [
    { name: 'compact', builtin: true, description: 'Compact', argumentHint: '[focus]' },
    { name: 'my-project-skill', description: 'Project skill' },
    { name: 'future-native-command', builtin: true },
    { name: '../unsafe', description: 'invalid identity' },
  ] });
  assert.equal(commands.find(row => row.id === 'compact').available, true);
  assert.equal(commands.find(row => row.id === 'compact').argumentHint, '[focus]');
  assert.equal(commands.find(row => row.id === 'my-project-skill').execution, 'sdk');
  assert.equal(commands.find(row => row.id === 'future-native-command').available, false);
  assert.equal(commands.some(row => row.id === '../unsafe'), false);
});

test('runtime custom skills override duplicate builtin names without disguising native actions', () => {
  const commands = buildCommandCatalog({ supportedCommands: [
    { name: 'compact', description: 'user skill', argumentHint: 'user' },
    { name: 'compact', builtin: true, argumentHint: 'official' },
    { name: 'project-skill', description: `Unsafe\0${'x'.repeat(2000)}`, argumentHint: 'ok\nnext', aliases: ['good', '../bad'] },
  ] });
  assert.equal(commands.find(row => row.id === 'compact').available, false);
  assert.match(commands.find(row => row.id === 'compact').availabilityReason, /同名自定义技能/);
  const collision = commands.find(row => row.id === 'skill:compact');
  assert.equal(collision.command, '/compact');
  assert.equal(collision.label, '自定义技能：compact');
  assert.equal(collision.execution, 'sdk');
  assert.equal(collision.available, true);
  assert.equal(collision.argumentHint, 'user');
  const custom = commands.find(row => row.id === 'project-skill');
  assert.ok(custom.description.length <= 1000);
  assert.doesNotMatch(custom.description, /\0/);
  assert.deepEqual(custom.aliases, ['good']);
});

test('custom collisions preserve independent GUI settings and have unique execution identities', () => {
  const commands = buildCommandCatalog({ supportedCommands: [
    { name: 'model', builtin: true },
    { name: 'model', builtin: false, description: 'A project model skill' },
    { name: 'compact', builtin: false },
    { name: 'skill:compact', builtin: false },
  ] });
  const setting = commands.find(row => row.id === 'model');
  assert.equal(setting.execution, 'panel');
  assert.equal(setting.available, true);
  assert.match(setting.implementationNote, /工作台操作/);
  assert.equal(commands.find(row => row.id === 'skill:model').execution, 'sdk');
  assert.equal(commands.find(row => row.id === 'skill:model').command, '/model');
  assert.equal(commands.find(row => row.id === 'skill:compact').command, '/skill:compact');
  assert.equal(commands.find(row => row.id === 'skill:skill:compact').command, '/compact');
  assert.equal(new Set(commands.map(row => row.id)).size, commands.length);
});

test('configuration commands open actionable managers and reloads use SDK control requests', () => {
  const commands = buildCommandCatalog({ discovered: true });
  for (const id of ['agents', 'chrome', 'hooks', 'ide', 'keybindings', 'mcp', 'output-style', 'plugin', 'skills', 'statusline']) {
    const row = commands.find(command => command.id === id);
    assert.equal(row.execution, 'manager', id);
    assert.equal(row.available, true, id);
    assert.match(row.documentationUrl, /^https:\/\/code\.claude\.com\/docs\/zh-CN\//);
  }
  for (const id of ['reload-skills', 'reload-plugins']) {
    const row = commands.find(command => command.id === id);
    assert.equal(row.execution, 'control', id);
    assert.equal(row.available, true, id);
    assert.equal(row.requiresWorkspace, false, id);
  }
  assert.equal(commands.find(row => row.id === 'chrome').requiresWorkspace, false);
  assert.equal(commands.find(row => row.id === 'ide').requiresWorkspace, true);
});

test('unsupported diagnostics and platform integrations do not advertise a successful substitute', () => {
  const commands = buildCommandCatalog();
  const skillDoctor = commands.find(row => row.id === 'skill-doctor');
  assert.equal(skillDoctor.available, false);
  assert.match(skillDoctor.availabilityReason, /开销.*使用频率/);
  if (process.platform === 'win32') {
    const sandbox = commands.find(row => row.id === 'sandbox');
    assert.equal(sandbox.available, false);
    assert.match(sandbox.availabilityReason, /原生 Windows.*WSL2/);
  }
  assert.notEqual(commands.find(row => row.id === 'login').availabilityReason, commands.find(row => row.id === 'rewind').availabilityReason);
  assert.match(commands.find(row => row.id === 'context').description, /最近请求/);
});

test('native background and cross-session commands cannot be replaced with local history or tool logs', () => {
  const ids = ['fork', 'cd', 'tasks', 'list-agents'];
  const commands = buildCommandCatalog({ discovered: true, supportedCommands: ids.map(name => ({ name, builtin: true })) });
  for (const id of ids) {
    const command = commands.find(row => row.id === id);
    assert.equal(command.execution, 'unavailable', id);
    assert.equal(command.available, false, id);
    assert.ok(command.availabilityReason, id);
  }
  assert.match(commands.find(row => row.id === 'fork').description, /后台/);
  assert.match(commands.find(row => row.id === 'list-agents').description, /发送消息/);
  assert.match(commands.find(row => row.id === 'diff').implementationNote, /完整 Git/);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, 'command-catalog-'));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-private-key', ANTHROPIC_BASE_URL: 'https://fixture.invalid' } }));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, options: { cwd: directory, executablePath: path.join(directory, 'claude.exe'), configDirectory: directory, tempDirectory: directory, cacheDirectory: directory } };
}

test('discovery never yields a model prompt and closes its SDK query after metadata arrives', async t => {
  const f = await fixture(t);
  let closed = false;
  let iterator;
  let queryOptions;
  const result = await discoverSupportedCommands({ ...f.options, queryFactory: ({ prompt, options }) => {
    iterator = prompt[Symbol.asyncIterator]();
    queryOptions = options;
    return { supportedCommands: async () => [{ name: 'example', description: 'hello', argumentHint: '', builtin: false }], close: () => { closed = true; } };
  } });
  assert.equal(result[0].name, 'example');
  assert.equal(queryOptions.persistSession, false);
  assert.equal(queryOptions.permissionMode, 'plan');
  assert.equal(queryOptions.env.ANTHROPIC_AUTH_TOKEN, 'fixture-private-key');
  assert.equal(JSON.stringify(result).includes('fixture-private-key'), false);
  assert.equal(closed, true);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test('discovery cancellation closes a stalled query and does not expose errors', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let closed = false;
  const pending = discoverSupportedCommands({ ...f.options, signal: controller.signal, queryFactory: () => {
    started();
    return { supportedCommands: () => new Promise(() => {}), close: () => { closed = true; } };
  } });
  await ready;
  controller.abort();
  assert.deepEqual(await pending, []);
  assert.equal(closed, true);
  const failure = await discoverSupportedCommands({ ...f.options, queryFactory: () => { throw new Error('fixture-private-key'); } });
  assert.deepEqual(failure, []);
});
