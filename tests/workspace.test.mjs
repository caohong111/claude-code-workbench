import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore, resolveWorkspacePath, listDirectory, readTextFile } from '../electron/workspace.mjs';

const testRoot = path.join(TEST_ROOT, `workspace-tests-${randomUUID()}`);
await fs.mkdir(testRoot, { recursive: true });

test('workspace paths reject parent traversal and external junctions', async () => {
  const root = path.join(testRoot, 'project');
  const external = path.join(testRoot, 'external');
  await fs.mkdir(root); await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'private.txt'), 'private');
  await assert.rejects(resolveWorkspacePath(root, '../external/private.txt'), /工作文件夹/);
  await fs.symlink(external, path.join(root, 'external-link'), 'junction');
  await assert.rejects(resolveWorkspacePath(root, 'external-link/private.txt'), /链接目标/);
  await assert.rejects(resolveWorkspacePath(root, 'external-link/not-created.txt', { allowMissing: true }), /链接目标/);
  assert.equal(await resolveWorkspacePath(root, 'new/folder/file.txt', { allowMissing: true }), path.join(root, 'new', 'folder', 'file.txt'));
});

test('file preview stays bounded and directory list excludes external links', async () => {
  const root = path.join(testRoot, 'project');
  await fs.writeFile(path.join(root, 'large.txt'), 'a'.repeat(2000));
  const preview = await readTextFile(root, 'large.txt', 100);
  assert.equal(preview.content.length, 100);
  assert.equal(preview.truncated, true);
  const listing = await listDirectory(root);
  assert.equal(listing.entries.some(item => item.name === 'external-link'), false);
});

test('workspace sessions and preferences survive restart without storing credentials', async () => {
  const storeRoot = path.join(testRoot, 'state');
  const first = new WorkspaceStore(storeRoot);
  await first.load();
  await first.openWorkspace(path.join(testRoot, 'project'));
  first.currentSession.messages.push({ role: 'user', text: 'test' });
  first.currentSession.claudeSessionId = 'native-session-id';
  first.data.preferences.model = 'sonnet';
  await first.save();
  const second = new WorkspaceStore(storeRoot);
  await second.load();
  assert.equal(second.currentSession.messages[0].text, 'test');
  assert.equal(second.currentSession.claudeSessionId, 'native-session-id');
  assert.equal(second.data.preferences.model, 'sonnet');
  assert.equal(JSON.stringify(second.data).includes('ANTHROPIC_AUTH_TOKEN'), false);
});
