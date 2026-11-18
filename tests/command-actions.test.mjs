import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { inspectCommand, updateClaudeSettings } from '../electron/command-actions.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(TEST_ROOT, 'command-actions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('changing a CLI option preserves provider credentials and backs up the original settings', async t => {
  const root = await fixture(t);
  const original = { env: { ANTHROPIC_AUTH_TOKEN: 'fixture-private-key', ANTHROPIC_BASE_URL: 'https://fixture.invalid' }, permissions: { allow: ['Read'] } };
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify(original));
  await updateClaudeSettings(root, settings => ({ ...settings, fastMode: true }));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.env, original.env);
  assert.deepEqual(saved.permissions, original.permissions);
  const backups = await fs.readdir(path.join(root, 'panel-backups'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'panel-backups', backups[0]), 'utf8')), original);
});

test('malformed settings cannot be overwritten by a visual command', async t => {
  const root = await fixture(t);
  const original = '{ invalid settings';
  await fs.writeFile(path.join(root, 'settings.json'), original);
  await assert.rejects(updateClaudeSettings(root, settings => ({ ...settings, fastMode: true })), /原文件未修改/);
  assert.equal(await fs.readFile(path.join(root, 'settings.json'), 'utf8'), original);
});

test('concurrent visual option writes preserve both changes and unrelated provider settings', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-private-key' } }));
  await Promise.all([
    updateClaudeSettings(root, settings => ({ ...settings, fastMode: true })),
    updateClaudeSettings(root, settings => ({ ...settings, autoCompactWindow: 500000 })),
  ]);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(saved.fastMode, true);
  assert.equal(saved.autoCompactWindow, 500000);
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, 'fixture-private-key');
  assert.equal((await fs.readdir(root)).some(name => name.includes('panel-next')), false);
});

test('MCP inspection redacts credential fields before they reach the renderer', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ mcpServers: { fixture: { command: 'fixture-tool', env: { API_KEY: 'fixture-private-key' }, headers: { Authorization: 'Bearer fixture-private-key' } } } }));
  const result = await inspectCommand('mcp', { configDirectory: root, preferences: {} });
  assert.equal(JSON.stringify(result).includes('fixture-private-key'), false);
  assert.equal(result.content.user.fixture.command, 'fixture-tool');
});
