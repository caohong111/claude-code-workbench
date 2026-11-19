import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function insideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveWorkspacePath(root, relative = '', { allowMissing = false } = {}) {
  if (typeof relative !== 'string' || relative.includes('\0')) throw new Error('无效的文件路径。');
  const canonicalRoot = await fs.realpath(root);
  const target = path.resolve(canonicalRoot, relative);
  if (!insideDirectory(canonicalRoot, target)) throw new Error('文件不在当前工作文件夹中。');
  let canonicalTarget;
  try {
    canonicalTarget = await fs.realpath(target);
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    let ancestor = path.dirname(target);
    while (true) {
      try {
        canonicalTarget = path.join(await fs.realpath(ancestor), path.relative(ancestor, target));
        break;
      } catch (parentError) {
        if (parentError.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw parentError;
        ancestor = path.dirname(ancestor);
      }
    }
  }
  if (!insideDirectory(canonicalRoot, canonicalTarget)) throw new Error('链接目标不在当前工作文件夹中。');
  return canonicalTarget;
}

export async function listDirectory(root, relative = '') {
  const directory = await resolveWorkspacePath(root, relative);
  const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
  const entries = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (ignored.has(item.name)) continue;
    const itemPath = path.join(directory, item.name);
    let stat;
    try {
      await resolveWorkspacePath(root, path.relative(root, itemPath));
      stat = await fs.stat(itemPath);
    } catch { continue; }
    entries.push({
      name: item.name,
      path: path.relative(root, itemPath).split(path.sep).join('/'),
      type: stat.isDirectory() ? 'directory' : 'file',
      isDirectory: stat.isDirectory(),
      size: stat.size,
    });
  }
  entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN'));
  return { path: relative, entries: entries.slice(0, 1500) };
}

export async function readTextFile(root, relative, limit = 512 * 1024) {
  const file = await resolveWorkspacePath(root, relative);
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('请选择一个文件。');
    const data = Buffer.alloc(Math.min(stat.size, limit));
    await handle.read(data, 0, data.length, 0);
    if (data.includes(0)) return { path: relative, content: '该文件是二进制文件，请使用资源管理器打开。', binary: true, truncated: false };
    return { path: relative, content: data.toString('utf8'), truncated: stat.size > limit };
  } finally { await handle.close(); }
}

function recoverInterruptedSessions(data) {
  const completedAt = new Date().toISOString();
  const message = '工作台上次关闭时任务尚未完成，已保留现有内容，可以继续任务。';
  for (const session of Array.isArray(data.sessions) ? data.sessions : []) {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const runningTools = (Array.isArray(session.tools) ? session.tools : []).filter(tool => tool?.status === 'running');
    const latest = messages.at(-1);
    const latestTime = Date.parse(latest?.createdAt);
    const legacyInterrupted = session.id === data.activeSessionId && latest?.role === 'assistant'
      && latest.status == null && !latest.error && !String(latest.text || '').trim()
      && Number.isFinite(latestTime) && runningTools.some(tool => {
        const toolTime = typeof tool.createdAt === 'number' ? tool.createdAt : Date.parse(tool.createdAt);
        return Number.isFinite(toolTime) && toolTime >= latestTime;
      });
    // Persisted running operations belong to the previous process and cannot still be active.
    for (const item of messages) {
      if (item?.role !== 'assistant' || (item.status !== 'running' && !(legacyInterrupted && item === latest))) continue;
      item.status = 'interrupted';
      item.error ||= message;
      item.completedAt ||= completedAt;
      if (!item.text) item.text = '上次任务已中断，可以从当前对话继续。';
    }
    for (const tool of runningTools) {
      tool.status = 'error';
      if (!tool.output) tool.output = '工作台已重启，上次工具操作未确认完成。';
    }
  }
}

export class WorkspaceStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'workspaces.json');
    this.data = { version: 1, activeWorkspace: null, activeSessionId: null, workspaces: [], sessions: [], preferences: { model: 'default', effort: 'medium', permissionMode: 'manual', theme: 'tech-dark' } };
    this.queue = Promise.resolve();
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const loaded = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = { ...this.data, ...loaded, preferences: { ...this.data.preferences, ...loaded.preferences } };
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('工作台历史文件无法读取，请保留文件并检查 workspaces.json。'); }
    recoverInterruptedSessions(this.data);
    return this.data;
  }
  save() {
    const contents = JSON.stringify(this.data, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, contents, 'utf8');
      await fs.rename(temporary, this.file);
    });
    return this.queue;
  }
  get currentSession() { return this.data.sessions.find(item => item.id === this.data.activeSessionId) ?? null; }
  async openWorkspace(directory) {
    const resolved = await fs.realpath(directory);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('请选择文件夹。');
    const item = { path: resolved, name: path.basename(resolved) || resolved, lastOpenedAt: new Date().toISOString() };
    this.data.workspaces = [item, ...this.data.workspaces.filter(value => value.path !== resolved)].slice(0, 20);
    this.data.activeWorkspace = resolved;
    const recent = this.data.sessions.filter(session => session.workspace === resolved).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    this.data.activeSessionId = recent?.id ?? null;
    if (!recent) this.createSession();
    await this.save();
    return item;
  }
  createSession() {
    if (!this.data.activeWorkspace) throw new Error('请先打开一个工作文件夹。');
    const now = new Date().toISOString();
    const session = { id: randomUUID(), workspace: this.data.activeWorkspace, title: '新对话', createdAt: now, updatedAt: now, claudeSessionId: null, messages: [], tools: [], changes: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 } };
    this.data.sessions.unshift(session);
    this.data.activeSessionId = session.id;
    return session;
  }
}
