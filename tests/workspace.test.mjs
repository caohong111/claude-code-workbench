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

test('cold restart interrupts only persisted running replies and tools while preserving resumable work', async () => {
  const storeRoot = path.join(testRoot, 'crashed-state');
  const first = new WorkspaceStore(storeRoot);
  await first.load();
  await first.openWorkspace(path.join(testRoot, 'project'));
  const session = first.currentSession;
  const attachment = { path: path.join(testRoot, 'fixture.png'), name: 'fixture.png', mimeType: 'image/png', size: 128 };
  const completedReply = { id: 'completed', role: 'assistant', text: 'Earlier verified result.', status: 'completed', createdAt: '2026-01-01T00:00:01.000Z' };
  const completedTool = { id: 'old-tool', runId: 'old-run', name: 'Read', status: 'done', output: 'Earlier read result.', createdAt: Date.parse(completedReply.createdAt) };
  session.messages.push(
    { id: 'old-user', role: 'user', text: 'Earlier task.' }, completedReply,
    { id: 'current-user', role: 'user', text: 'Continue editing this file.', attachments: [attachment] },
    { id: 'crashed-reply', role: 'assistant', text: 'Partial answer: the first file is already saved.', status: 'running', createdAt: '2026-01-01T00:00:02.000Z' },
  );
  session.tools.push(completedTool, { id: 'current-tool', runId: 'crashed-run', name: 'Write', status: 'running', output: 'Partial operation output.', createdAt: Date.parse('2026-01-01T00:00:03.000Z') });
  session.claudeSessionId = 'native-resume-fixture';
  session.directResponsesSessionId = 'responses-resume-fixture';
  session.lastEngine = 'responses';
  session.usage = { inputTokens: 120, outputTokens: 42, costUsd: 0.01, durationMs: 1000 };
  session.changes.push({ path: 'saved.txt', status: 'added', before: '', after: 'Already saved.' });
  const before = structuredClone(session);
  await first.save();

  const restarted = new WorkspaceStore(storeRoot);
  await restarted.load();
  const recovered = restarted.currentSession;
  assert.equal(recovered.id, before.id);
  assert.equal(recovered.messages.at(-1).status, 'interrupted');
  assert.match(recovered.messages.at(-1).error, /上次关闭.*继续任务/);
  assert.equal(recovered.messages.at(-1).text, before.messages.at(-1).text);
  assert.ok(Number.isFinite(Date.parse(recovered.messages.at(-1).completedAt)));
  assert.deepEqual(recovered.messages[1], completedReply);
  assert.deepEqual(recovered.messages.at(-2).attachments, [attachment]);
  for (const field of ['claudeSessionId', 'directResponsesSessionId', 'lastEngine', 'usage', 'changes', 'updatedAt']) assert.deepEqual(recovered[field], before[field]);
  assert.deepEqual(recovered.tools[0], completedTool);
  assert.equal(recovered.tools[1].status, 'error');
  assert.equal(recovered.tools[1].output, before.tools[1].output);
  assert.equal(recovered.tools[1].runId, 'crashed-run');

  await restarted.save();
  const nextRestart = new WorkspaceStore(storeRoot);
  await nextRestart.load();
  assert.deepEqual(nextRestart.currentSession, recovered, 'A saved recovery must remain stable across later restarts');
});

test('legacy recovery uses the active latest empty reply and matching tool time without guessing other replies failed', async () => {
  const storeRoot = path.join(testRoot, 'legacy-crashed-state');
  const first = new WorkspaceStore(storeRoot);
  await first.load();
  await first.openWorkspace(path.join(testRoot, 'project'));
  const active = first.currentSession;
  const createdAt = '2026-01-02T00:00:00.000Z';
  active.messages.push({ id: 'legacy-user', role: 'user', text: 'Legacy task.' }, { id: 'legacy-assistant', role: 'assistant', text: '', createdAt });
  active.tools.push({ id: 'legacy-running', name: 'Write', status: 'running', output: '', createdAt: Date.parse(createdAt) + 10 });
  const inactiveReply = { id: 'inactive-assistant', role: 'assistant', text: '', createdAt };
  const finishedReply = { id: 'finished-assistant', role: 'assistant', text: 'A historical result with no status field.', createdAt };
  first.data.sessions.push(
    { id: 'inactive', messages: [{ role: 'user', text: 'Old task.' }, inactiveReply], tools: [{ id: 'inactive-tool', status: 'running', createdAt: Date.parse(createdAt) + 20 }] },
    { id: 'finished', messages: [finishedReply], tools: [] },
  );
  await first.save();

  const restarted = new WorkspaceStore(storeRoot);
  await restarted.load();
  assert.equal(restarted.currentSession.messages.at(-1).status, 'interrupted');
  assert.match(restarted.currentSession.messages.at(-1).text, /中断.*继续/);
  assert.equal(restarted.currentSession.tools[0].status, 'error');
  assert.match(restarted.currentSession.tools[0].output, /未确认完成/);
  assert.deepEqual(restarted.data.sessions.find(item => item.id === 'inactive').messages.at(-1), inactiveReply);
  assert.deepEqual(restarted.data.sessions.find(item => item.id === 'finished').messages[0], finishedReply);
});

test('legacy blank replies require current-turn running-tool evidence before being marked interrupted', async () => {
  const storeRoot = path.join(testRoot, 'ambiguous-legacy-state');
  const store = new WorkspaceStore(storeRoot);
  await store.load();
  await store.openWorkspace(path.join(testRoot, 'project'));
  const session = store.currentSession;
  const emptyReply = { id: 'empty-reply', role: 'assistant', text: '', createdAt: '2026-01-03T00:00:00.000Z' };
  session.messages.push(emptyReply);
  session.tools.push({ id: 'older-running-tool', status: 'running', createdAt: Date.parse(emptyReply.createdAt) - 1000 });
  await store.save();

  const restarted = new WorkspaceStore(storeRoot);
  await restarted.load();
  assert.deepEqual(restarted.currentSession.messages[0], emptyReply);
  assert.equal(restarted.currentSession.tools[0].status, 'error');
});
