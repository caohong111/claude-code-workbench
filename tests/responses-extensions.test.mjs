import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { createResponsesExtensions } from '../electron/responses-extensions.mjs';

async function fixture(t) {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, 'responses-extensions-'));
  const cwd = path.join(directory, 'workspace');
  const configDirectory = path.join(directory, 'config');
  await fs.mkdir(cwd); await fs.mkdir(configDirectory);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  async function write(relative, text, scope = 'project') {
    const file = path.join(scope === 'user' ? configDirectory : cwd, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  }
  const events = [];
  const create = options => createResponsesExtensions({ cwd, configDirectory, onEvent: event => events.push(structuredClone(event)), ...options });
  return { directory, cwd, configDirectory, write, create, events };
}

test('discovers real user and project skills and loads their instructions and bounded resources', async t => {
  const f = await fixture(t);
  await f.write('.claude/skills/research/SKILL.md', '---\nname: evidence-review\ndescription: Review sources before research claims\n---\nRead references/rules.md and research $ARGUMENTS. Root: ${CLAUDE_SKILL_DIR}\n');
  await f.write('.claude/skills/research/references/rules.md', 'Never invent evidence.\n');
  await f.write('skills/personal/SKILL.md', '---\ndescription: Personal review rules\n---\nInspect before changing.\n', 'user');
  const tools = await f.create();
  assert.deepEqual(tools.definitions.map(item => item.name), ['Skill', 'ReadSkillResource']);
  assert.match(tools.instructions, /evidence-review/); assert.match(tools.instructions, /Personal review rules/);
  assert.equal((await tools.execute('ReadSkillResource', { skill: 'research', path: 'references/rules.md' })).isError, true);
  const loaded = await tools.execute('Skill', { skill: 'research', args: 'a product market' }, { toolUseId: 'skill-load-1' });
  assert.equal(loaded.isError, false); assert.match(loaded.output, /research a product market/);
  assert.match(loaded.output, /references\/rules.md/); assert.doesNotMatch(loaded.output, /\$ARGUMENTS|\$\{CLAUDE_SKILL_DIR\}/);
  const resource = await tools.execute('ReadSkillResource', { skill: 'evidence-review', path: 'references/rules.md' });
  assert.deepEqual(resource, { output: 'Never invent evidence.\n', isError: false });
  assert.equal(f.events.filter(event => event.type === 'tool' && event.tool.id === 'skill-load-1').at(-1).tool.status, 'done');
});

test('personal skill precedence, legacy command identities and metadata are resolved without loading arbitrary files', async t => {
  const f = await fixture(t);
  await f.write('skills/review/SKILL.md', '---\ndescription: Personal takes precedence\n---\nUSER_BODY', 'user');
  await f.write('.claude/skills/review/SKILL.md', '---\ndescription: Project shadowed\n---\nPROJECT_BODY');
  await f.write('.claude/commands/frontend/check.md', '---\nname: ignored-command-name\ndescription: Frontend check\n---\nLegacy task $ARGUMENTS');
  const tools = await f.create();
  const review = await tools.execute('Skill', { skill: 'review' });
  assert.match(review.output, /USER_BODY/); assert.doesNotMatch(review.output, /PROJECT_BODY/);
  assert.match(tools.instructions, /frontend:check/); assert.doesNotMatch(tools.instructions, /ignored-command-name/);
  assert.match((await tools.execute('Skill', { skill: 'frontend:check', args: 'files' })).output, /Legacy task files/);
  assert.equal((await tools.execute('Skill', { skill: '../config/settings.json' })).isError, true);
});

test('native invocation flags and layered visibility settings distinguish manual and automatic invocation', async t => {
  const f = await fixture(t);
  for (const [name, fields] of [['ordinary', ''], ['manual-only', 'disable-model-invocation: true\n'], ['automatic-only', 'user-invocable: false\n'], ['hidden', ''], ['collapsed', ''], ['user-choice', '']]) {
    await f.write(`.claude/skills/${name}/SKILL.md`, `---\ndescription: Description for ${name}\n${fields}---\n${name} body`);
  }
  await f.write('settings.json', JSON.stringify({ skillOverrides: { hidden: 'on', collapsed: 'on' }, env: { ANTHROPIC_AUTH_TOKEN: 'fixture-config-value-never-sent' } }), 'user');
  await f.write('.claude/settings.json', JSON.stringify({ skillOverrides: { hidden: 'off', collapsed: 'name-only', 'user-choice': 'user-invocable-only' } }));
  const automatic = await f.create();
  assert.match(automatic.instructions, /ordinary|automatic-only|collapsed/);
  assert.doesNotMatch(automatic.instructions, /manual-only|"hidden"|user-choice|Description for collapsed|fixture-config-value-never-sent/);
  assert.equal((await automatic.execute('Skill', { skill: 'manual-only' })).isError, true);
  assert.equal((await automatic.execute('Skill', { skill: 'hidden' })).isError, true);
  assert.equal((await (await f.create({ prompt: '/manual-only run now' })).execute('Skill', { skill: 'manual-only' })).isError, false);
  assert.equal((await (await f.create({ prompt: '/user-choice run now' })).execute('Skill', { skill: 'user-choice' })).isError, false);
  const automaticOnlyRequest = await f.create({ prompt: '/automatic-only now' });
  assert.match(automaticOnlyRequest.instructions, /cannot run here/);
  assert.equal((await automaticOnlyRequest.execute('Skill', { skill: 'automatic-only' })).isError, true);
  await f.write('.claude/settings.local.json', JSON.stringify({ skillOverrides: { hidden: 'on' } }));
  assert.equal((await (await f.create()).execute('Skill', { skill: 'hidden' })).isError, false);
});

test('loading a skill cannot silently run native agents, hooks, shell injection or model overrides', async t => {
  const f = await fixture(t);
  for (const [name, fields, body] of [
    ['forked', 'context: fork\n', 'Work independently'], ['hooks', 'hooks: { PreToolUse: [] }\n', 'Run hooks'],
    ['model', 'model: sonnet\n', 'Use another model'], ['scoped', 'paths: ["src/**"]\n', 'Only scoped files'],
    ['dynamic', '', 'Output: !`Get-Content secrets.json`'], ['positional', '', 'Analyze $ARGUMENTS[0]'],
  ]) await f.write(`.claude/skills/${name}/SKILL.md`, `---\ndescription: Unsupported native skill\n${fields}---\n${body}`);
  const tools = await f.create();
  assert.deepEqual(tools.definitions, []);
  const manual = await f.create({ prompt: '/forked' });
  assert.match(manual.instructions, /原生子代理/); assert.deepEqual(manual.definitions, []);
  assert.equal((await manual.execute('Skill', { skill: 'forked' })).isError, true);
});

test('native Skill deny rules override visibility and remain effective after a skill was loaded', async t => {
  const f = await fixture(t);
  await f.write('.claude/skills/review/SKILL.md', '---\ndescription: Review safely\n---\nRead refs.md');
  await f.write('.claude/skills/review/refs.md', 'Safe reference');
  const tools = await f.create();
  assert.equal((await tools.execute('Skill', { skill: 'review' })).isError, false);
  await f.write('settings.json', JSON.stringify({ permissions: { deny: ['Skill(rev*)'] } }), 'user');
  assert.equal((await tools.execute('ReadSkillResource', { skill: 'review', path: 'refs.md' })).isError, true);
  const hidden = await f.create({ prompt: '/review' });
  assert.deepEqual(hidden.definitions, []); assert.match(hidden.instructions, /cannot run here/);
  await f.write('settings.json', JSON.stringify({ permissions: { deny: ['Skill'] } }), 'user');
  assert.deepEqual((await f.create()).definitions, []);
});

test('skill reads reject traversal, external junctions and late policy or resource changes', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'rules.md'), 'OUTSIDE_MUST_NOT_READ');
  await f.write('.claude/skills/safe/SKILL.md', '---\ndescription: Safe documents\n---\nRead rules.md');
  const resource = await f.write('.claude/skills/safe/refs/rules.md', 'Allowed');
  await fs.symlink(outside, path.join(f.cwd, '.claude', 'skills', 'linked'), 'junction');
  const tools = await f.create();
  assert.doesNotMatch(tools.instructions, /linked/);
  assert.equal((await tools.execute('Skill', { skill: 'safe' })).isError, false);
  for (const relative of ['../../settings.json', path.join(outside, 'rules.md'), 'not-listed.md']) assert.equal((await tools.execute('ReadSkillResource', { skill: 'safe', path: relative })).isError, true);
  await fs.rename(path.dirname(resource), path.join(f.directory, 'original-refs'));
  await fs.symlink(outside, path.dirname(resource), 'junction');
  assert.equal((await tools.execute('ReadSkillResource', { skill: 'safe', path: 'refs/rules.md' })).isError, true);
  await f.write('.claude/settings.local.json', JSON.stringify({ skillOverrides: { safe: 'off' } }));
  assert.equal((await tools.execute('Skill', { skill: 'safe' })).isError, true);
  assert.equal((await tools.execute('ReadSkillResource', { skill: 'safe', path: 'refs/rules.md' })).isError, true);
});

test('user instructions and skill outputs are redacted without sharing settings or running scripts', async t => {
  const f = await fixture(t);
  await f.write('CLAUDE.md', 'User rules: PRIVATE_VALUE\n', 'user');
  await f.write('.claude/skills/helper/SKILL.md', '---\ndescription: Use PRIVATE_VALUE safely\nallowed-tools: Bash(*)\n---\nRead PRIVATE_VALUE from instructions, never claim execution.');
  await f.write('.claude/skills/helper/helper.py', 'print("PRIVATE_VALUE")');
  const tools = await f.create({ permissionMode: 'plan', redact: text => text.replaceAll('PRIVATE_VALUE', '[hidden]') });
  assert.doesNotMatch(tools.instructions, /PRIVATE_VALUE/); assert.match(tools.instructions, /User rules: \[hidden\]/);
  assert.match(tools.instructions, /Plan mode remains read-only/);
  const loaded = await tools.execute('Skill', { skill: 'helper', args: 'PRIVATE_VALUE' });
  assert.equal(loaded.isError, false); assert.doesNotMatch(loaded.output, /PRIVATE_VALUE/);
  assert.match(loaded.output, /Native allowed-tools grants are not applied/);
  const resource = await tools.execute('ReadSkillResource', { skill: 'helper', path: 'helper.py' });
  assert.equal(resource.output, 'print("[hidden]")');
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_VALUE/);
});

test('empty directories, malformed settings, oversized/binary documents and cancellation fail without fake capabilities', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.create()).definitions, []);
  await f.write('.claude/skills/oversized/SKILL.md', 'x'.repeat(256 * 1024 + 1));
  await f.write('.claude/skills/binary/SKILL.md', 'abc\0def');
  await f.write('.claude/skills/valid/SKILL.md', '---\ndescription: ordinary\n---\nValid');
  const basic = await f.create();
  assert.equal(basic.summary.availableSkills, 1); assert.doesNotMatch(basic.instructions, /oversized|binary/);
  await f.write('.claude/settings.local.json', '{malformed');
  const broken = await f.create();
  assert.deepEqual(broken.definitions, []); assert.match(broken.instructions, /暂停本次技能加载/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.create({ signal: controller.signal }), /已停止/);
});

test('enabled installed plugin skills are namespaced, use the manifest and ignore standalone skill overrides', async t => {
  const f = await fixture(t);
  const installPath = path.join(f.configDirectory, 'plugins', 'cache', 'market', 'entry', '1.0.0');
  const pluginBase = 'plugins/cache/market/entry/1.0.0';
  await f.write(`${pluginBase}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'actual-plugin', skills: ['./extra', './standalone'], commands: './tasks' }), 'user');
  await f.write(`${pluginBase}/skills/review/SKILL.md`, '---\nname: evidence\ndescription: Plugin review\n---\nUse ${CLAUDE_PLUGIN_ROOT}; read refs.md for $ARGUMENTS.', 'user');
  await f.write(`${pluginBase}/skills/review/refs.md`, 'Plugin reference', 'user');
  await f.write(`${pluginBase}/extra/design/SKILL.md`, '---\ndescription: Plugin design\n---\nDesign carefully.', 'user');
  await f.write(`${pluginBase}/standalone/SKILL.md`, 'Standalone instructions', 'user');
  await f.write(`${pluginBase}/tasks/check.md`, 'Plugin legacy command', 'user');
  await f.write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'entry@market': [{ scope: 'user', installPath }] } }), 'user');
  await f.write('settings.json', JSON.stringify({ enabledPlugins: { 'entry@market': true }, skillOverrides: { 'actual-plugin:evidence': 'off' } }), 'user');
  const tools = await f.create();
  assert.equal(tools.summary.availablePluginSkills, 4);
  assert.match(tools.instructions, /actual-plugin:evidence|actual-plugin:review|actual-plugin:design|actual-plugin:standalone|actual-plugin:check/);
  const loaded = await tools.execute('Skill', { skill: 'actual-plugin:review', args: 'a feature' });
  assert.equal(loaded.isError, false); assert.match(loaded.output, /a feature/); assert.doesNotMatch(loaded.output, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.deepEqual(await tools.execute('ReadSkillResource', { skill: 'actual-plugin:evidence', path: 'refs.md' }), { output: 'Plugin reference', isError: false });
  assert.equal((await tools.execute('Skill', { skill: 'review' })).isError, true);
  await f.write('.claude/settings.local.json', JSON.stringify({ permissions: { deny: ['Skill(actual-plugin:*)'] } }));
  assert.equal((await tools.execute('ReadSkillResource', { skill: 'actual-plugin:review', path: 'refs.md' })).isError, true);
});

test('plugin enablement and project scope are required, with cache isolation and late disablement enforced', async t => {
  const f = await fixture(t);
  const installPath = path.join(f.configDirectory, 'plugins', 'cache', 'market', 'helper', '1');
  await f.write('plugins/cache/market/helper/1/skills/check/SKILL.md', 'Plugin checks', 'user');
  await f.write('plugins/cache/market/helper/1/skills/check/refs.md', 'Checks reference', 'user');
  await f.write('settings.json', JSON.stringify({ enabledPlugins: { 'helper@market': true } }), 'user');
  const registry = records => f.write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'helper@market': records } }), 'user');
  await registry([{ scope: 'project', projectPath: f.directory, installPath }]);
  assert.equal((await f.create()).summary.availablePluginSkills, 0);
  await registry([{ scope: 'project', projectPath: f.cwd, installPath }]);
  const tools = await f.create();
  assert.equal(tools.summary.availablePluginSkills, 1);
  assert.equal((await tools.execute('Skill', { skill: 'helper:check' })).isError, false);
  await f.write('.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'helper@market': false } }));
  assert.equal((await tools.execute('ReadSkillResource', { skill: 'helper:check', path: 'refs.md' })).isError, true);
  assert.equal((await f.create()).summary.availablePluginSkills, 0);
  await f.write('.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'helper@market': true } }));
  await registry([{ scope: 'user', installPath: f.cwd }]);
  assert.equal((await f.create()).summary.availablePluginSkills, 0);
  await fs.symlink(f.cwd, path.join(f.configDirectory, 'plugins', 'cache', 'escaped'), 'junction');
  await registry([{ scope: 'user', installPath: path.join(f.configDirectory, 'plugins', 'cache', 'escaped') }]);
  assert.equal((await f.create()).summary.availablePluginSkills, 0);
});

test('plugins require explicit enabled registration and reject changed manifests and native plugin data variables', async t => {
  const f = await fixture(t);
  const pluginBase = 'plugins/cache/market/helper/1';
  const installPath = path.join(f.configDirectory, pluginBase);
  await f.write(`${pluginBase}/skills/check/SKILL.md`, 'Ordinary plugin checks', 'user');
  await f.write(`${pluginBase}/skills/data/SKILL.md`, 'Use ${CLAUDE_PLUGIN_DATA}/state.json', 'user');
  await f.write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'helper@market': [{ scope: 'user', installPath }] } }), 'user');
  assert.equal((await f.create()).summary.availablePluginSkills, 0);
  await f.write('settings.json', JSON.stringify({ enabledPlugins: { 'helper@market': true } }), 'user');
  const tools = await f.create();
  assert.equal(tools.summary.availablePluginSkills, 1); assert.doesNotMatch(tools.instructions, /helper:data/);
  await f.write(`${pluginBase}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'renamed' }), 'user');
  assert.equal((await tools.execute('Skill', { skill: 'helper:check' })).isError, true);
  await f.write('plugins/installed_plugins.json', '{broken', 'user');
  const broken = await f.create();
  assert.equal(broken.summary.availablePluginSkills, 0); assert.match(broken.instructions, /插件清单无法安全读取/);
});
