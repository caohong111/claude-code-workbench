import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspacePath } from './workspace.mjs';
export { manageCommand, MANAGED_COMMAND_IDS } from './command-managers.mjs';

const redacted = value => JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|api.?key|authorization/i.test(key) ? '[已隐藏]' : typeof item === 'string' ? item.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏]') : item));
const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; } };
const settingsWrites = new Map();

export async function updateClaudeSettings(directory, update) {
  const file = path.join(directory, 'settings.json');
  const previous = settingsWrites.get(file) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const original = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    let settings = {};
    try { if (original !== null) settings = JSON.parse(original); if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('object required'); }
    catch { throw new Error('Claude 配置不是有效 JSON，请先修复，原文件未修改。'); }
    const next = update(settings);
    await fs.mkdir(path.join(directory, 'panel-backups'), { recursive: true });
    if (original !== null) await fs.writeFile(path.join(directory, 'panel-backups', `settings-${Date.now()}-${randomUUID()}.json`), original, { encoding: 'utf8', flag: 'wx' });
    const temporary = path.join(directory, `settings.${randomUUID()}.panel-next.json`);
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
      const current = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (current !== original) throw new Error('Claude 配置已被 CC Switch 或其他程序修改，请刷新后重试，原文件未覆盖。');
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  });
  settingsWrites.set(file, task);
  try { await task; } finally { if (settingsWrites.get(file) === task) settingsWrites.delete(file); }
}

async function listDocuments(directories, pattern) {
  const items = [];
  for (const directory of directories) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && pattern.test(entry.name)) items.push({ name: entry.name, path: path.join(directory, entry.name) });
      if (entry.isDirectory() && pattern.test('SKILL.md')) {
        const file = path.join(directory, entry.name, 'SKILL.md');
        if (await fs.stat(file).then(stat => stat.isFile(), () => false)) items.push({ name: entry.name, path: file });
      }
      if (items.length >= 300) return items;
    }
  }
  return items;
}

export async function inspectCommand(id, { workspace, configDirectory, session, connection, preferences }, request = {}) {
  const user = await readJson(path.join(configDirectory, 'settings.json'));
  const project = workspace ? await readJson(path.join(workspace, '.claude', 'settings.json')) : {};
  const local = workspace ? await readJson(path.join(workspace, '.claude', 'settings.local.json')) : {};
  const base = { type: 'json', content: {} };
  const roots = folder => [path.join(configDirectory, folder), ...(workspace ? [path.join(workspace, '.claude', folder)] : [])];
  if (['skills', 'reload-skills', 'skill-doctor', 'agents', 'output-style'].includes(id)) {
    const folder = id === 'agents' ? 'agents' : id === 'output-style' ? 'output-styles' : 'skills';
    const items = await listDocuments(roots(folder), /\.md$/i);
    if (request.action === 'read' && typeof request.path === 'string') {
      const item = items.find(item => item.path === request.path);
      if (!item) throw new Error('请选择列表中的文件。');
      const contents = await fs.readFile(item.path, 'utf8');
      return { type: 'text', title: item.name, content: redacted(contents.slice(0, 100000)) };
    }
    return { type: 'files', items, message: items.length ? `${items.length} 项` : '当前未安装对应扩展。' };
  }
  if (id === 'memory') {
    if (!workspace) throw new Error('请先打开工作文件夹。');
    const file = await resolveWorkspacePath(workspace, 'CLAUDE.md', { allowMissing: true });
    if (request.action === 'save') {
      if (typeof request.content !== 'string' || request.content.length > 200000) throw new Error('记忆内容过长。');
      const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (stat?.isSymbolicLink()) throw new Error('项目记忆是链接，请在原位置编辑。');
      await fs.writeFile(file, request.content, 'utf8');
    }
    return { type: 'editor', path: 'CLAUDE.md', content: await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }) };
  }
  if (id === 'mcp') {
    const mcp = workspace ? await readJson(path.join(workspace, '.mcp.json')) : {};
    base.content = { user: user.mcpServers || {}, project: mcp.mcpServers || {}, disabled: local.disabledMcpjsonServers || [], enabled: local.enabledMcpjsonServers || [] };
  } else if (id === 'hooks') base.content = { user: user.hooks || {}, project: project.hooks || {}, local: local.hooks || {} };
  else if (['plugin', 'reload-plugins'].includes(id)) base.content = { user: user.enabledPlugins || {}, project: project.enabledPlugins || {}, marketplaces: user.extraKnownMarketplaces || {} };
  else if (id === 'sandbox') base.content = { user: user.sandbox || {}, project: project.sandbox || {}, permissionMode: preferences.permissionMode };
  else if (id === 'keybindings') base.content = await readJson(path.join(configDirectory, 'keybindings.json'));
  else if (id === 'statusline') base.content = { statusLine: user.statusLine || null };
  else if (id === 'chrome') base.content = { enabled: user.claudeInChromeDefaultEnabled === true, plugins: Object.keys(user.enabledPlugins || {}).filter(name => /chrome/i.test(name)) };
  else if (id === 'ide') base.content = { enabled: user.ide || project.ide || null, workingDirectory: workspace };
  else if (id === 'context') base.content = { inputTokens: session?.usage?.inputTokens ?? null, outputTokens: session?.usage?.outputTokens ?? null, messages: session?.messages?.length || 0, note: '最近一次请求的用量；不代表当前上下文的完整组成。' };
  else if (id === 'usage') base.content = { ...(session?.usage || {}), source: session?.lastEngine === 'responses' ? 'Responses' : 'Claude Code', cost: '费用以中转站账单为准' };
  else if (id === 'release-notes') return { type: 'text', content: `Claude Code ${connection.claudeVersion}\nhttps://code.claude.com/docs/en/changelog` };
  else base.content = { version: connection.claudeVersion, provider: connection.providerName, endpoint: connection.baseUrl, configured: connection.hasCredential, model: preferences.model, effort: preferences.effort, permissionMode: preferences.permissionMode, workspace, configDirectory };
  return { ...base, content: redacted(base.content) };
}
