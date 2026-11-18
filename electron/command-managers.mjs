import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { resolveWorkspacePath } from './workspace.mjs';

export const MANAGED_COMMAND_IDS = new Set(['chrome', 'mcp', 'hooks', 'skills', 'agents', 'output-style', 'keybindings', 'statusline', 'plugin', 'ide']);
const scopes = new Set(['user', 'project', 'local']);
const hookEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Setup', 'TeammateIdle', 'TaskCompleted', 'ConfigChange', 'InstructionsLoaded', 'WorktreeCreate', 'WorktreeRemove']);
const queues = new Map();
const pendingPluginCommands = new Map();
const mask = '[已隐藏]';
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = text => createHash('sha256').update(text).digest('hex');
const redact = value => JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|api.?key|authorization/i.test(key) ? mask : typeof item === 'string' ? item.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, mask).replace(/Bearer\s+[^\s"']+/gi, `Bearer ${mask}`) : item));
const cleanText = text => String(text).replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, mask).replace(/Bearer\s+[^\s"']+/gi, `Bearer ${mask}`);

async function json(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!isObject(value)) throw new Error('object required');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`${path.basename(file)} 不是有效的 JSON 对象，原文件未修改。`);
  }
}

async function safeFile(root, relative) {
  await fs.mkdir(root, { recursive: true });
  const file = await resolveWorkspacePath(root, relative, { allowMissing: true });
  const link = await fs.lstat(path.resolve(root, relative)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (link?.isSymbolicLink()) throw new Error('配置文件是链接，请在原位置编辑。');
  return file;
}

async function backup(context, file) {
  const backupDirectory = await safeFile(context.configDirectory, 'panel-backups');
  await fs.mkdir(backupDirectory, { recursive: true });
  const target = path.join(backupDirectory, `${path.basename(file)}-${Date.now()}-${randomUUID()}.bak`);
  await fs.copyFile(file, target).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function write(context, file, content, revision) {
  const previous = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (revision && hash(previous ?? '') !== revision) throw new Error('文件已被其他程序修改，请重新打开后再保存。');
  await backup(context, file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.panel-next`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function mutateJson(context, file, update) {
  const waiting = queues.get(file) || Promise.resolve();
  const next = waiting.catch(() => {}).then(async () => {
    const before = await json(file);
    const value = update(before);
    await write(context, file, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  });
  queues.set(file, next);
  try { return await next; } finally { if (queues.get(file) === next) queues.delete(file); }
}

function scopeOf(request, fallback = 'user') {
  const scope = request.scope || fallback;
  if (!scopes.has(scope)) throw new Error('无效的配置范围。');
  return scope;
}

async function settingsFile(context, scope) {
  if (scope === 'user') return safeFile(context.configDirectory, 'settings.json');
  if (!context.workspace) throw new Error('请先打开工作文件夹。');
  return safeFile(context.workspace, `.claude/${scope === 'local' ? 'settings.local.json' : 'settings.json'}`);
}

async function globalFile(context) { return safeFile(context.configDirectory, '.claude.json'); }
function nameOf(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) throw new Error('名称只能包含字母、数字、点、下划线和短横线，且以字母或数字开头。');
  return value;
}
function textOf(value, label, maximum = 200000) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maximum) throw new Error(`请填写有效的${label}。`);
  return value;
}
function projectKey(global, workspace) {
  return Object.keys(global.projects || {}).find(key => path.resolve(key).toLocaleLowerCase() === path.resolve(workspace).toLocaleLowerCase()) || workspace;
}

async function cli(context, args, timeout = 45000, { allowFailure = false } = {}) {
  if (context.signal?.aborted) throw new Error('配置操作已取消。');
  if (context.runCli) return context.runCli(args);
  if (!context.executablePath) throw new Error('未找到 Claude Code 可执行文件。');
  const settings = await json(await settingsFile(context, 'user'));
  const environment = { ...process.env, ...Object.fromEntries(Object.entries(settings.env || {}).filter(([, value]) => typeof value === 'string')), CLAUDE_CONFIG_DIR: context.configDirectory, CLAUDE_CODE_TMPDIR: context.tempDirectory, TEMP: context.tempDirectory, TMP: context.tempDirectory, XDG_CACHE_HOME: context.cacheDirectory, DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  delete environment.CLAUDECODE;
  delete environment.CLAUDE_CODE_ENTRYPOINT;
  for (const key of Object.keys(environment)) if (environment[key] === undefined) delete environment[key];
  const secrets = Object.entries(environment).filter(([key, value]) => /token|secret|password|api.?key/i.test(key) && typeof value === 'string' && value.length > 5).map(([, value]) => value);
  const sanitize = value => secrets.reduce((result, secret) => result.split(secret).join(mask), cleanText(value));
  return new Promise((resolve, reject) => {
    const child = spawn(context.executablePath, args, { cwd: context.workspace || context.configDirectory, env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const stop = () => { child.kill(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    context.signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-1000000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-100000); });
    child.on('error', error => { cleanup(); reject(new Error(sanitize(error.message))); });
    child.on('close', code => {
      cleanup();
      if (context.signal?.aborted) return reject(new Error('配置操作已取消。'));
      if (timedOut) return reject(new Error('Claude 配置操作超时，请检查网络后重试。'));
      if (code !== 0 && !allowFailure) return reject(new Error(sanitize(stderr || stdout || `Claude 配置操作失败 (${code})`).slice(-6000)));
      resolve({ stdout, stderr, code });
    });
  });
}

const manager = (kind, values = {}) => ({ type: 'manager', kind, items: [], config: {}, changed: false, ...values });

async function chrome(context, request) {
  const file = await globalFile(context);
  let changed = false;
  if (request.action === 'toggle') {
    await mutateJson(context, file, settings => ({ ...settings, claudeInChromeDefaultEnabled: Boolean(request.enabled) }));
    changed = true;
  }
  const settings = await json(file);
  const result = manager('chrome', { changed, config: { enabled: settings.claudeInChromeDefaultEnabled === true, connected: false, authRequirement: '需要 Claude 官方付费账号通过 /login 登录，并安装 Claude in Chrome 扩展。API Key、中转站令牌不能用于此集成。' }, message: changed ? '已保存默认启用设置，下次 Claude 任务启动时生效；连接状态需检测。' : '默认启用与实际连接状态分别显示。' });
  if (request.action === 'extension') result.openUrl = 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';
  if (request.action === 'docs') result.openUrl = 'https://code.claude.com/docs/zh-CN/chrome';
  if (request.action === 'probe' && context.runtimeControl) result.runtime = await context.runtimeControl('chrome', request);
  return result;
}

async function mcp(context, request) {
  const file = await globalFile(context);
  const scope = scopeOf(request);
  if ((scope !== 'user' || ['toggle', 'probe', 'reconnect', 'approve'].includes(request.action)) && !context.workspace) throw new Error('此操作需要先打开工作文件夹。');
  let changed = false;
  let runtime;
  if (request.action === 'add') {
    const name = nameOf(request.name);
    const type = request.type || 'stdio';
    let config;
    if (type === 'stdio') {
      const command = textOf(request.command, '启动程序', 4000);
      if (!Array.isArray(request.args || []) || (request.args || []).some(arg => typeof arg !== 'string' || arg.includes('\0')) || (request.args || []).length > 100) throw new Error('启动参数格式无效。');
      config = { type, command, args: request.args || [] };
      if (request.env && Object.keys(request.env).length) config.env = stringMap(request.env);
    } else if (['http', 'sse'].includes(type)) {
      let url;
      try { url = new URL(request.url); } catch { throw new Error('请填写完整的 HTTP 地址。'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('服务器地址仅支持 HTTP/HTTPS，凭据请填入请求头。');
      config = { type, url: url.href };
      if (request.headers && Object.keys(request.headers).length) config.headers = stringMap(request.headers);
    } else throw new Error('不支持的 MCP 传输类型。');
    const global = await json(file);
    const existing = scope === 'user' ? global.mcpServers : scope === 'local' ? global.projects?.[projectKey(global, context.workspace)]?.mcpServers : (await json(await safeFile(context.workspace, '.mcp.json'))).mcpServers;
    if (existing?.[name]) throw new Error('同一范围内已存在该 MCP 名称，请先删除或使用其他名称。');
    await backup(context, file);
    if (scope === 'project') await backup(context, await safeFile(context.workspace, '.mcp.json'));
    await cli(context, ['mcp', 'add-json', '--scope', scope, name, JSON.stringify(config)]);
    changed = true;
  } else if (request.action === 'remove') {
    const name = nameOf(request.name);
    await backup(context, file);
    if (scope === 'project') await backup(context, await safeFile(context.workspace, '.mcp.json'));
    await cli(context, ['mcp', 'remove', '--scope', scope, name]);
    changed = true;
  } else if (request.action === 'toggle') {
    const name = nameOf(request.name);
    await mutateJson(context, file, global => {
      const key = projectKey(global, context.workspace);
      const project = global.projects?.[key] || {};
      const disabled = new Set(project.disabledMcpServers || []);
      request.enabled ? disabled.delete(name) : disabled.add(name);
      return { ...global, projects: { ...global.projects, [key]: { ...project, disabledMcpServers: [...disabled] } } };
    });
    changed = true;
  } else if (request.action === 'approve') {
    const name = nameOf(request.name);
    for (const rejectionScope of ['user', 'project']) {
      const settings = await json(await settingsFile(context, rejectionScope));
      if ((settings.disabledMcpjsonServers || []).includes(name)) throw new Error(`${name} 已在${rejectionScope === 'user' ? '全局' : '项目'}设置中被明确拒绝，请先在对应设置中移除拒绝；本地授权不能覆盖它。`);
    }
    await mutateJson(context, await settingsFile(context, 'local'), settings => ({ ...settings, enabledMcpjsonServers: [...new Set([...(settings.enabledMcpjsonServers || []), name])], disabledMcpjsonServers: (settings.disabledMcpjsonServers || []).filter(item => item !== name) }));
    changed = true;
  } else if (['probe', 'reconnect'].includes(request.action)) {
    if (!context.runtimeControl) throw new Error('当前没有可用的 Claude 连接检测器。');
    runtime = await context.runtimeControl('mcp', request);
  }
  const global = await json(file);
  const project = context.workspace ? global.projects?.[projectKey(global, context.workspace)] || {} : {};
  const userSettings = await json(await settingsFile(context, 'user'));
  const sharedSettings = context.workspace ? await json(await settingsFile(context, 'project')) : {};
  const localSettings = context.workspace ? await json(await settingsFile(context, 'local')) : {};
  const projectServers = context.workspace ? (await json(await safeFile(context.workspace, '.mcp.json'))).mcpServers : {};
  const rejected = new Set([userSettings, sharedSettings, localSettings].flatMap(settings => Array.isArray(settings.disabledMcpjsonServers) ? settings.disabledMcpjsonServers : []));
  const trusted = project.hasTrustDialogAccepted === true;
  const approvalSources = trusted ? [userSettings, sharedSettings, localSettings] : [userSettings];
  const approved = new Set(approvalSources.flatMap(settings => Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : []));
  const approvalSettings = Object.assign({}, ...approvalSources);
  const sources = [['user', global.mcpServers], ['project', projectServers], ['local', project.mcpServers]];
  const items = sources.flatMap(([itemScope, definitions]) => Object.entries(definitions || {}).map(([name, config]) => {
    const isRejected = itemScope === 'project' && rejected.has(name);
    const pendingApproval = itemScope === 'project' && (isRejected || (!approvalSettings.enableAllProjectMcpServers && !approved.has(name)));
    const pendingTrust = pendingApproval && !isRejected && !trusted && (localSettings.enableAllProjectMcpServers || (localSettings.enabledMcpjsonServers || []).includes(name) || sharedSettings.enableAllProjectMcpServers || (sharedSettings.enabledMcpjsonServers || []).includes(name));
    return { id: `${itemScope}:${name}`, name, scope: itemScope, type: config.type || 'stdio', command: cleanText(config.command || ''), args: redact(config.args || []), url: cleanText(config.url || ''), enabled: !isRejected && !(project.disabledMcpServers || []).includes(name), pendingApproval, rejected: isRejected, ...(isRejected ? { error: '此项目服务器已被设置中的 disabledMcpjsonServers 明确拒绝；拒绝优先于所有授权。' } : pendingTrust ? { error: '已保存项目授权，但尚未记录 Claude 对此文件夹的信任；实际连接以检测结果为准。' } : {}), hasSecrets: Boolean(config.env && Object.keys(config.env).length || config.headers && Object.keys(config.headers).length), status: 'not-checked' };
  }));
  return manager('mcp', { items, changed, runtime, message: changed ? '已更新 Claude MCP 配置。下一次任务生效；检测连接将启动已启用的服务器。' : '连接状态需手动检测；列表不会启动服务器。' });
}

function stringMap(value) {
  if (!isObject(value) || Object.entries(value).some(([key, item]) => !key || typeof item !== 'string' || key.includes('\0') || item.includes('\0')) || Object.keys(value).length > 100) throw new Error('环境变量或请求头格式无效。');
  return value;
}

async function hooks(context, request) {
  const scope = scopeOf(request);
  const file = await settingsFile(context, scope);
  let changed = false;
  if (request.action === 'toggle') {
    await mutateJson(context, file, settings => ({ ...settings, disableAllHooks: !request.enabled }));
    changed = true;
  } else if (request.action === 'add') {
    if (!hookEvents.has(request.event)) throw new Error('不支持的 Hook 事件。');
    const command = textOf(request.command, '命令', 20000);
    const timeout = request.timeout === undefined ? 600 : Number(request.timeout);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) throw new Error('超时时间需在 1 到 3600 秒之间。');
    const matcher = typeof request.matcher === 'string' ? request.matcher : '';
    if (matcher.length > 500 || matcher.includes('\0')) throw new Error('匹配条件过长或无效。');
    await mutateJson(context, file, settings => ({ ...settings, hooks: { ...settings.hooks, [request.event]: [...(settings.hooks?.[request.event] || []), { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout }] }] } }));
    changed = true;
  } else if (request.action === 'remove') {
    if (!hookEvents.has(request.event) || !Number.isInteger(request.index) || request.index < 0) throw new Error('请选择要移除的 Hook。');
    await mutateJson(context, file, settings => {
      const entries = settings.hooks?.[request.event] || [];
      if (!entries[request.index] || !request.revision || hash(JSON.stringify(entries[request.index])) !== request.revision) throw new Error('Hook 已变更或列表已过期，请刷新后重新选择。');
      return { ...settings, hooks: { ...settings.hooks, [request.event]: entries.filter((_, index) => index !== request.index) } };
    });
    changed = true;
  }
  const items = [];
  const enabledByScope = {};
  let effectiveDisabled = false;
  for (const itemScope of ['user', ...(context.workspace ? ['project', 'local'] : [])]) {
    const settings = await json(await settingsFile(context, itemScope));
    enabledByScope[itemScope] = settings.disableAllHooks !== true;
    if (typeof settings.disableAllHooks === 'boolean') effectiveDisabled = settings.disableAllHooks;
    for (const [event, entries] of Object.entries(settings.hooks || {})) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => items.push({ id: `${itemScope}:${event}:${index}`, scope: itemScope, event, index, revision: hash(JSON.stringify(entry)), matcher: cleanText(entry.matcher || '*'), command: cleanText((entry.hooks || []).map(hook => hook.command || hook.url || hook.prompt || hook.type).join('\n')), types: (entry.hooks || []).map(hook => hook.type), enabled: settings.disableAllHooks !== true }));
    }
  }
  for (const item of items) item.enabled = !effectiveDisabled;
  return manager('hooks', { items, changed, config: { enabled: enabledByScope[scope], enabledByScope, effectiveEnabled: !effectiveDisabled, events: [...hookEvents], notice: '允许钩子设置作用于所有非受管钩子；项目本地设置优先于项目和全局设置。' }, message: changed ? '已保存 Hook 配置。命令会在后续 Claude 任务的对应事件发生时执行。' : 'Hook 按事件自动执行。保存和查看不会试运行命令。' });
}

const folderOf = id => id === 'agents' ? 'agents' : id === 'output-style' ? 'output-styles' : 'skills';
const templateOf = (id, name) => id === 'agents' ? `---\nname: ${name}\ndescription: ${name} 专用代理\ntools: Read, Glob, Grep\n---\n\n在此填写代理职责与工作要求。\n` : id === 'output-style' ? `---\nname: ${name}\ndescription: 自定义输出风格\nkeep-coding-instructions: true\n---\n\n在此填写回答风格要求。\n` : `---\nname: ${name}\ndescription: 描述何时使用此技能\n---\n\n在此填写技能步骤。\n`;

function documentMetadata(content) {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)?.[1];
  if (!frontmatter) return {};
  try {
    const value = parseYaml(frontmatter, { maxAliasCount: 100, logLevel: 'silent' });
    return isObject(value) ? value : {};
  } catch { return {}; }
}

async function documents(id, context, request) {
  const folder = folderOf(id);
  let changed = false;
  let selectedPath = request.path;
  const roots = [{ scope: 'user', root: context.configDirectory, relative: folder }, ...(context.workspace ? [{ scope: 'project', root: context.workspace, relative: `.claude/${folder}` }] : [])];
  async function listing() {
    const items = [];
    for (const source of roots) {
      const directory = await safeFile(source.root, source.relative);
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code !== 'ENOENT') throw error; return []; })) {
        let relative;
        if (entry.isFile() && /\.md$/i.test(entry.name)) relative = `${source.relative}/${entry.name}`;
        else if (id === 'skills' && entry.isDirectory()) relative = `${source.relative}/${entry.name}/SKILL.md`;
        else continue;
        let file;
        try { file = await safeFile(source.root, relative); if (!(await fs.stat(file)).isFile()) continue; } catch { continue; }
        const metadata = documentMetadata(await fs.readFile(file, 'utf8'));
        const fallbackName = id === 'skills' && entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, '');
        const name = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : fallbackName;
        const restricted = id === 'skills' && (metadata['disable-model-invocation'] === true || metadata['user-invocable'] === false);
        items.push({ id: file, path: file, name, description: typeof metadata.description === 'string' ? metadata.description : '', scope: source.scope,
          ...(id === 'skills' ? { toggleable: !restricted } : {}), ...(restricted ? { error: '调用方式受技能文档限制，请编辑文档。' } : {}) });
        if (items.length >= 300) return items;
      }
    }
    return items;
  }
  if (request.action === 'create') {
    const scope = scopeOf(request);
    const source = roots.find(item => item.scope === scope);
    if (!source) throw new Error('请选择用户或项目范围。');
    const name = nameOf(request.name);
    const relative = `${source.relative}/${name}${id === 'skills' ? '/SKILL.md' : '.md'}`;
    selectedPath = await safeFile(source.root, relative);
    if (await fs.stat(selectedPath).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) throw new Error('已存在同名文件，请使用其他名称。');
    const content = request.content?.trim() ? textOf(request.content, '内容') : templateOf(id, name);
    await write(context, selectedPath, content);
    changed = true;
  } else if (['save', 'remove'].includes(request.action)) {
    const selected = (await listing()).find(item => item.path === request.path);
    if (!selected) throw new Error('请选择列表中的文件。');
    if (request.action === 'remove') {
      await backup(context, selected.path);
      await fs.unlink(selected.path);
      selectedPath = null;
    } else {
      const content = textOf(request.content, '内容');
      if (content.includes(mask)) throw new Error('包含隐藏凭据的内容不能直接保存，请使用原文件编辑。');
      await write(context, selected.path, content, request.revision);
    }
    changed = true;
  } else if (request.action === 'select' && id === 'output-style') {
    const builtins = ['Default', 'Proactive', 'Concise', 'Explanatory', 'Learning'];
    const name = request.name === 'default' ? 'Default' : request.name;
    if (!builtins.includes(name) && !(await listing()).some(item => item.name === name)) throw new Error('请选择已有输出风格。');
    await mutateJson(context, await settingsFile(context, scopeOf(request, 'local')), settings => ({ ...settings, outputStyle: name === 'Default' ? 'default' : name }));
    changed = true;
  } else if (request.action === 'toggle' && id === 'skills') {
    const items = await listing();
    const item = items.find(item => request.path ? item.path === request.path : item.name === request.name);
    if (!item) throw new Error('请选择用户或项目中的技能。插件和受管技能由来源管理。');
    const visibility = request.visibility || (request.enabled ? 'on' : 'off');
    if (!['on', 'name-only', 'user-invocable-only', 'off'].includes(visibility)) throw new Error('无效的技能可见性。');
    if (item.toggleable === false) throw new Error('此技能的可见性由文件 frontmatter 限制，请编辑文件。');
    await mutateJson(context, await settingsFile(context, scopeOf(request, context.workspace ? 'local' : 'user')), settings => ({ ...settings, skillOverrides: { ...settings.skillOverrides, [item.name]: visibility } }));
    changed = true;
  }
  const items = await listing();
  const user = await json(await settingsFile(context, 'user'));
  const project = context.workspace ? await json(await settingsFile(context, 'project')) : {};
  const local = context.workspace ? await json(await settingsFile(context, 'local')) : {};
  const overrides = { ...user.skillOverrides, ...project.skillOverrides, ...local.skillOverrides };
  const selectedStyle = local.outputStyle || project.outputStyle || user.outputStyle || 'default';
  const config = id === 'output-style' ? { selected: cleanText(selectedStyle === 'default' ? 'Default' : selectedStyle), builtins: ['Default', 'Proactive', 'Concise', 'Explanatory', 'Learning'] } : {};
  if (id === 'skills') for (const item of items) { item.visibility = overrides[item.name] || 'on'; item.enabled = item.visibility !== 'off'; }
  const publicItems = items.map(item => ({ ...item, name: cleanText(item.name), description: cleanText(item.description), ...(cleanText(item.name) !== item.name ? { readOnly: true, toggleable: false } : {}) }));
  const result = manager(id, { items: publicItems, config, changed, message: changed ? '已保存。后续 Claude 任务将重新加载配置。' : '选择已有项目，或创建用户/项目文件。' });
  if (['read', 'create', 'save'].includes(request.action) && selectedPath) {
    const item = publicItems.find(item => item.path === selectedPath);
    if (!item) throw new Error('请选择列表中的文件。');
    const content = await fs.readFile(item.path, 'utf8');
    const redactedContent = cleanText(content);
    result.document = { ...item, content: redactedContent, revision: hash(content), readOnly: redactedContent !== content };
  }
  return result;
}

async function terminalSettings(id, context, request) {
  const file = id === 'keybindings' ? await safeFile(context.configDirectory, 'keybindings.json') : await settingsFile(context, 'user');
  let changed = false;
  if (request.action === 'preset' && id === 'statusline') {
    if (!['compact', 'detailed'].includes(request.preset)) throw new Error('请选择已有状态栏样式。');
    const script = await safeFile(context.configDirectory, `panel-statusline-${request.preset}.ps1`);
    const scriptContent = `$ErrorActionPreference = 'Stop'\ntry {\n  $status = [Console]::In.ReadToEnd() | ConvertFrom-Json\n  $modelName = [string]$status.model.display_name\n  if (-not $modelName) { $modelName = [string]$status.model.id }\n  $contextPercent = $status.context_window.used_percentage\n  $parts = @($modelName)\n  if ($null -ne $contextPercent) { $parts += ('Context {0}%' -f [Math]::Round([double]$contextPercent)) }\n${request.preset === 'detailed' ? "  if ($null -ne $status.cost.total_cost_usd) { $parts += ('USD {0:F4}' -f [double]$status.cost.total_cost_usd) }\n  if ($status.workspace.current_dir) { $parts += Split-Path -Leaf ([string]$status.workspace.current_dir) }\n" : ''}  [Console]::Write(($parts -join ' | '))\n} catch { [Console]::Write('Claude Code') }\n`;
    await write(context, script, scriptContent);
    const command = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
    await mutateJson(context, file, settings => ({ ...settings, statusLine: { type: 'command', command, padding: 1 } }));
    changed = true;
  } else if (request.action === 'save') {
    if (id === 'keybindings') {
      if (!Array.isArray(request.bindings) || request.bindings.length > 100 || request.bindings.some(block => !isObject(block) || typeof block.context !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(block.context) || !isObject(block.bindings) || Object.entries(block.bindings).some(([chord, action]) => !chord || chord.length > 100 || (action !== null && (typeof action !== 'string' || !/^[a-zA-Z]+:[a-zA-Z0-9]+$/.test(action)))))) throw new Error('快捷键配置格式无效。');
      await mutateJson(context, file, settings => ({ ...settings, bindings: request.bindings }));
    } else {
      const command = textOf(request.command, '状态栏脚本命令', 20000);
      const padding = Number(request.padding || 0);
      if (!Number.isInteger(padding) || padding < 0 || padding > 20) throw new Error('状态栏留白需在 0 到 20 之间。');
      await mutateJson(context, file, settings => ({ ...settings, statusLine: { type: 'command', command, padding } }));
    }
    changed = true;
  } else if (request.action === 'remove') {
    await mutateJson(context, file, settings => { const next = { ...settings }; delete next[id === 'keybindings' ? 'bindings' : 'statusLine']; return next; });
    changed = true;
  }
  const settings = await json(file);
  return manager(id, { changed, config: redact(id === 'keybindings' ? { bindings: settings.bindings || [] } : { command: settings.statusLine?.command || '', padding: settings.statusLine?.padding || 0, presets: ['compact', 'detailed'], selectedPreset: /panel-statusline-(compact|detailed)\.ps1/.exec(settings.statusLine?.command || '')?.[1] || '' }), message: '此设置由 Claude Code 终端界面使用，工作台的按钮和状态栏独立显示。' });
}

async function plugins(context, request) {
  const action = request.action || 'list';
  const scope = scopeOf(request);
  const allowed = new Set(['install', 'enable', 'disable', 'update', 'uninstall']);
  let changed = false;
  let operation;
  let pendingCommand;
  if (allowed.has(action)) {
    const name = textOf(request.name, '插件名称', 300);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(name) || name.startsWith('-')) throw new Error('插件名称无效。');
    if (scope !== 'user' && !context.workspace) throw new Error('请先打开工作文件夹。');
    await backup(context, await settingsFile(context, scope));
    const args = ['plugin', action, name, '--scope', scope, '--json'];
    if (action === 'uninstall') args.push('--keep-data');
    const pendingKey = `${context.configDirectory}:${scope}:${name}:${action}`;
    if (request.acceptCommand) {
      const pending = pendingPluginCommands.get(pendingKey);
      if (!['install', 'update'].includes(action) || !pending || pending.sha256 !== request.acceptCommand || Date.now() - pending.created > 600000) throw new Error('安装命令确认已过期，请重新预览。');
      args.push('--accept-command', pending.sha256);
    }
    const response = await cli(context, args, 120000, { allowFailure: true });
    try { operation = parseCliJson(response.stdout); }
    catch { throw new Error(cleanText(response.stderr || response.stdout || '插件操作未返回有效结果。').slice(-4000)); }
    if (operation?.outcome === 'failed' && operation.shownCommand && ['install', 'update'].includes(action)) {
      const shown = operation.shownCommand;
      if (typeof shown.command !== 'string' || !/^[a-f0-9]{64}$/i.test(shown.sha256 || '')) throw new Error(cleanText(operation.message || '插件安装命令需要在官方工具中审核。'));
      pendingPluginCommands.set(pendingKey, { sha256: shown.sha256, created: Date.now() });
      pendingCommand = { command: cleanText(shown.command), sha256: shown.sha256, name, scope, action };
    } else {
      if (response.code || operation?.outcome === 'failed') throw new Error(cleanText(operation.message || response.stderr || '插件操作失败。'));
      pendingPluginCommands.delete(pendingKey);
      changed = true;
    }
  } else if (action === 'marketplace-add') {
    const source = textOf(request.source, '插件市场地址', 3000);
    if (source.startsWith('-') || /[\r\n]/.test(source)) throw new Error('插件市场地址无效。');
    await backup(context, await settingsFile(context, scope));
    const response = await cli(context, ['plugin', 'marketplace', 'add', source, '--scope', scope, '--json'], 120000);
    operation = parseCliJson(response.stdout);
    if (operation?.outcome === 'failed') throw new Error(cleanText(operation.message || '添加插件市场失败。'));
    changed = true;
  }
  const response = await cli(context, ['plugin', 'list', '--json']);
  const data = parseCliJson(response.stdout);
  const entries = Array.isArray(data) ? data : data?.installed || data?.plugins || [];
  const items = entries.map(item => ({ id: item.id || item.name, name: item.id || item.name, scope: item.scope || 'user', enabled: item.enabled !== false, version: item.version || '', description: cleanText(item.description || ''), installPath: item.installPath || '' }));
  return manager('plugin', { items, changed, pendingCommand, message: pendingCommand ? '此插件要求运行以下安装命令。请审核后点击确认安装。' : changed ? cleanText(operation?.message || '已完成插件操作。后续 Claude 任务会加载最新插件。') : '插件通过本机 Claude 官方 CLI 管理。卸载会保留插件数据目录。' });
}

function parseCliJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {
    for (const line of trimmed.split(/\r?\n/).reverse()) { try { return JSON.parse(line); } catch {} }
    throw new Error(cleanText(trimmed).slice(-3000) || 'Claude CLI 未返回有效结果。');
  }
}

async function ide(context, request) {
  const file = await globalFile(context);
  let changed = false;
  if (request.action === 'toggle') {
    await mutateJson(context, file, settings => ({ ...settings, autoConnectIde: Boolean(request.enabled) }));
    changed = true;
  }
  const settings = await json(file);
  return manager('ide', { changed, config: { enabled: settings.autoConnectIde === true, connected: false }, message: '自动连接设置适用于 Claude CLI 与官方 IDE 扩展。工作台直接管理当前文件夹，无需 IDE 连接。', ...(request.action === 'extension' ? { openUrl: 'https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code' } : {}), ...(request.action === 'open-vscode' && context.workspace ? { openUrl: `vscode://file/${context.workspace.replace(/\\/g, '/')}` } : {}) });
}

export async function manageCommand(id, context, request = {}) {
  if (!MANAGED_COMMAND_IDS.has(id)) throw new Error('此命令没有可用的管理面板。');
  if (!context?.configDirectory) throw new Error('缺少 Claude 配置目录。');
  let result;
  if (id === 'chrome') result = await chrome(context, request);
  else if (id === 'mcp') result = await mcp(context, request);
  else if (id === 'hooks') result = await hooks(context, request);
  else if (['skills', 'agents', 'output-style'].includes(id)) result = await documents(id, context, request);
  else if (['keybindings', 'statusline'].includes(id)) result = await terminalSettings(id, context, request);
  else if (id === 'plugin') result = await plugins(context, request);
  else result = await ide(context, request);
  const secrets = new Set();
  function collect(value, key = '') {
    if (typeof value === 'string' && /token|secret|password|api.?key|authorization/i.test(key) && value.length >= 6) secrets.add(value);
    else if (isObject(value)) for (const [name, item] of Object.entries(value)) collect(item, name);
  }
  collect(await json(await settingsFile(context, 'user')));
  collect(await json(await globalFile(context)));
  if (context.workspace) collect(await json(await safeFile(context.workspace, '.mcp.json')));
  const scrubbed = JSON.parse(JSON.stringify(result, (_key, value) => typeof value === 'string' ? [...secrets].reduce((text, secret) => text.split(secret).join(mask), value) : value));
  if (result.document && scrubbed.document.content !== result.document.content) scrubbed.document.readOnly = true;
  return scrubbed;
}
