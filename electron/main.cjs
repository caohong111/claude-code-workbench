const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { resolveRuntimePaths, isWorkbenchShortcut } = require('./runtime-paths.cjs');
const runtime = resolveRuntimePaths({ appRoot: app.getAppPath() });
const { appRoot: panelRoot, homeDirectory: installRoot, dataRoot, configDirectory, executablePath, tempDirectory } = runtime;
const appId = 'io.github.claude-code-workbench';
const defaultIconPath = app.isPackaged ? path.join(process.resourcesPath, 'app-icon.ico') : path.join(panelRoot, 'assets', 'app-icon.ico');
process.env.TEMP = tempDirectory;
process.env.TMP = process.env.TEMP;
app.setPath('userData', path.join(dataRoot, 'electron'));
app.setPath('sessionData', path.join(installRoot, 'cache', 'desktop'));
app.setPath('crashDumps', path.join(dataRoot, 'crashes'));
app.setAppLogsPath(path.join(dataRoot, 'logs'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(installRoot, 'cache', 'desktop', 'http'));
app.commandLine.appendSwitch('disable-http-cache');
app.setName('Claude 工作台');
app.setAppUserModelId(appId);
nativeTheme.themeSource = 'dark';

let window;
let store;
let service;
let claudeService;
let responsesService;
let appearanceAssets;
let chatAttachments;
let chatAssets;
let appearance = {};
let applicationIconPath = defaultIconPath;
let workspaceApi;
let connectionService;
let pendingProviderReset = false;
let connection = { baseUrl: '', hasCredential: false, configDirectory, claudeVersion: '' };
let run = null;
let permission = null;
const permissionQueue = [];
let sendInitializing = false;
let sendInitializationDone = Promise.resolve();
let runTask = null;
let shuttingDown = false;
let shutdownComplete = false;
let errorMessage = null;
let commandApi;
let commandActions;
let commandControl;
let commandTask = null;
let commandCatalog = { categories: [], commands: [], loading: false };
let commandWorkspace = null;
let commandLoadedAt = 0;
let commandDiscovery;
let emitTimer;
let persistTimer;
const baselines = new Map();
const chosenAttachments = new Map();
const themes = require('../themes.json');
const themeBackgrounds = Object.fromEntries(themes.map(theme => [theme.value, theme.surface]));

function applyNativeTheme() {
  const theme = store?.data.preferences.theme || 'tech-dark';
  nativeTheme.themeSource = themes.find(item => item.value === theme)?.scheme || 'dark';
  if (window && !window.isDestroyed()) window.setBackgroundColor(themeBackgrounds[theme] || themeBackgrounds['tech-dark']);
}

async function applyApplicationIcon(updateShortcuts = false) {
  applicationIconPath = await appearanceAssets.getApplicationIconPath();
  if (window && !window.isDestroyed()) {
    window.setIcon(applicationIconPath);
    if (process.platform === 'win32') window.setAppDetails({ appId, appIconPath: applicationIconPath, appIconIndex: 0 });
  }
  if (!updateShortcuts || process.platform !== 'win32' || process.env.CLAUDE_PANEL_TEST) return;
  const pinned = path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const shortcutNames = ['Claude 工作台.lnk', 'Claude Code Workbench (Source).lnk', 'Claude Code Workbench(Source).lnk', 'Claude Code Workbench.lnk'];
  const files = [
    ...[app.getPath('desktop'), programs].flatMap(directory => shortcutNames.map(name => path.join(directory, name))),
    ...(await fs.readdir(pinned).catch(() => [])).filter(name => /\.lnk$/i.test(name)).map(name => path.join(pinned, name)),
  ];
  for (const file of files) {
    let current;
    try { current = shell.readShortcutLink(file); } catch { continue; }
    if (!isWorkbenchShortcut(current, { appRoot: panelRoot, executablePath: process.execPath, isPackaged: app.isPackaged })) continue;
    const backup = path.join(dataRoot, 'appearance', 'shortcut-backups', `${Date.now()}-${randomUUID()}.lnk`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(file, backup);
    if (!shell.writeShortcutLink(file, 'update', { icon: applicationIconPath, iconIndex: 0, appUserModelId: appId })) throw new Error('应用图标已更新，桌面快捷方式更新失败。');
  }
}

function errorText(error) {
  return String(error?.message || error || '发生未知错误。').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]');
}
function currentWorkspace() {
  const value = store.data.activeWorkspace;
  return value ? store.data.workspaces.find(item => item.path === value) ?? { path: value, name: path.basename(value) } : null;
}
function snapshot() {
  const workspace = currentWorkspace();
  return {
    workspaces: store.data.workspaces,
    recentWorkspaces: store.data.workspaces,
    workspace,
    sessions: store.data.sessions.filter(item => !workspace || item.workspace === workspace.path).map(({ id, title, workspace, updatedAt }) => ({ id, title, workspace, updatedAt })),
    session: store.currentSession,
    preferences: store.data.preferences,
    connection,
    appearance,
    commandCatalog,
    run,
    permission,
    error: errorMessage,
  };
}
function emit(immediate = false) {
  if (immediate) {
    clearTimeout(emitTimer);
    emitTimer = null;
    if (window && !window.isDestroyed()) window.webContents.send('panel:state', snapshot());
  } else if (!emitTimer) emitTimer = setTimeout(() => emit(true), 45);
}
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => store.save().catch(error => { errorMessage = errorText(error); emit(true); }), 350);
}
function assertIdle() {
  if (shuttingDown) throw new Error('工作台正在关闭。');
  if (commandTask) throw new Error('请等待当前配置操作完成。');
  if (run || runTask || sendInitializing) throw new Error('请先停止当前任务，再切换工作文件夹或对话。');
}
function requireWorkspace() { const item = currentWorkspace(); if (!item) throw new Error('请先打开工作文件夹。'); return item; }
function syncPermission() {
  permission = permissionQueue[0] ?? null;
  if (run && run.status !== 'stopping') run.status = permission ? 'waiting' : 'running';
}
function clearPermissions() { permissionQueue.length = 0; syncPermission(); }

function alignProviderSelection(allowInitializing = false) {
  if (!store || !connection.sourceId || run || runTask || (sendInitializing && !allowInitializing)) return;
  if (pendingProviderReset || store.data.preferences.modelSourceId !== connection.sourceId) {
    store.data.preferences.model = 'default';
    store.data.preferences.modelSourceId = connection.sourceId;
    pendingProviderReset = false;
    persistSoon();
  }
}
async function refreshConnection() {
  connection = await connectionService.refresh();
  alignProviderSelection();
  return connection;
}

function loadCommands(force = false) {
  const cwd = currentWorkspace()?.path || panelRoot;
  if (!force && commandWorkspace === cwd && Date.now() - commandLoadedAt < 30000) return;
  commandDiscovery?.abort();
  const controller = commandDiscovery = new AbortController();
  commandWorkspace = cwd;
  commandLoadedAt = Date.now();
  commandCatalog = { categories: commandApi.COMMAND_CATEGORIES, commands: commandApi.buildCommandCatalog(), loading: true };
  commandApi.discoverSupportedCommands({ cwd, executablePath, configDirectory, tempDirectory: path.join(installRoot, 'temp'), cacheDirectory: path.join(installRoot, 'cache', 'xdg'), signal: controller.signal }).then(commands => {
    if (controller.signal.aborted) return;
    commandCatalog = { categories: commandApi.COMMAND_CATEGORIES, commands: commandApi.buildCommandCatalog({ supportedCommands: commands, discovered: true }), loading: false };
    emit(true);
  }).catch(() => { if (!controller.signal.aborted) { commandCatalog = { ...commandCatalog, loading: false }; emit(true); } });
}

async function captureBefore(event) {
  const session = store.currentSession;
  const root = requireWorkspace().path;
  const input = event.input || {};
  const filePath = input.file_path || input.notebook_path;
  if (!filePath || !['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(event.toolName)) return;
  try {
    const file = await workspaceApi.resolveWorkspacePath(root, filePath, { allowMissing: true });
    const relative = path.relative(root, file).split(path.sep).join('/');
    const key = `${session.id}:${relative}`;
    if (baselines.has(key)) return;
    const previous = session.changes.find(change => change.path === relative);
    if (previous) { baselines.set(key, previous.status === 'added' ? null : previous.before); return; }
    let before = null;
    try { before = (await workspaceApi.readTextFile(root, relative, 1024 * 1024)).content; } catch (error) { if (error.code !== 'ENOENT') return; }
    baselines.set(key, before);
  } catch {}
}
async function refreshChanges() {
  const session = store.currentSession;
  const root = currentWorkspace()?.path;
  if (!session || !root) return;
  const { createPatch } = await import('diff');
  for (const [key, before] of baselines) {
    if (!key.startsWith(`${session.id}:`)) continue;
    const relative = key.slice(session.id.length + 1);
    let after = null;
    try { after = (await workspaceApi.readTextFile(root, relative, 1024 * 1024)).content; } catch (error) { if (error.code !== 'ENOENT') continue; }
    const index = session.changes.findIndex(change => change.path === relative);
    if (before === after) { if (index >= 0) session.changes.splice(index, 1); continue; }
    const change = { path: relative, status: before === null ? 'added' : after === null ? 'deleted' : 'modified', kind: before === null ? 'added' : after === null ? 'deleted' : 'modified', before: before ?? '', after: after ?? '', diff: createPatch(relative, before ?? '', after ?? '') };
    if (index >= 0) session.changes[index] = change; else session.changes.push(change);
  }
}

async function onServiceEvent(event) {
  if (!run || (event.runId && run.id !== event.runId)) return;
  const session = store.currentSession;
  const assistant = session.messages.find(message => message.id === run.assistantMessageId);
  switch (event.type) {
    case 'session': if (event.engine === 'responses') session.directResponsesSessionId = event.sessionId; else session.claudeSessionId = event.sessionId; break;
    case 'text': if (assistant) assistant.text += event.text || ''; break;
    case 'tool': {
      const item = event.tool;
      const index = session.tools.findIndex(tool => tool.id === item.id);
      if (index >= 0) session.tools[index] = { ...session.tools[index], ...item }; else session.tools.push(item);
      break;
    }
    case 'permission': {
      if (shuttingDown || run.status === 'stopping') {
        service.respondPermission({ id: event.permission.id, decision: 'deny' });
        break;
      }
      const index = permissionQueue.findIndex(item => item.id === event.permission.id);
      if (index >= 0) permissionQueue[index] = event.permission; else permissionQueue.push(event.permission);
      syncPermission(); emit(true); break;
    }
    case 'usage': session.usage = event.usage; break;
    case 'beforeTool': await captureBefore(event); break;
    case 'afterTool': await refreshChanges(); break;
    case 'error': errorMessage = errorText(event.error); if (assistant) assistant.error = errorMessage; break;
  }
  session.updatedAt = new Date().toISOString();
  emit();
  persistSoon();
}

function handle(channel, callback) {
  ipcMain.handle(`panel:${channel}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的窗口请求。');
    try { return await callback(...args); }
    catch (error) {
      const message = errorText(error);
      if (channel !== 'command') { errorMessage = message; emit(true); }
      throw new Error(message);
    }
  });
}

function registerHandlers() {
  handle('state', async () => { await refreshConnection(); return snapshot(); });
  handle('connection', refreshConnection);
  handle('models', async () => { await connectionService.refresh({ forceModels: true }); return snapshot(); });
  handle('commands', async force => { loadCommands(force === true); emit(true); return commandCatalog; });
  handle('command', async request => {
    const command = commandCatalog.commands.find(item => item.id === request?.id);
    if (!command?.available || command.execution === 'unavailable') throw new Error(command?.availabilityReason || '当前命令不可用。');
    const values = request.values || {};
    if (command.id === 'stop') { service?.stop(); if (run) run.status = 'stopping'; emit(true); return { type: 'text', content: '正在停止任务。' }; }
    assertIdle();
    const session = store.currentSession;
    const done = async message => { await store.save(); emit(true); return { type: 'text', content: message }; };
    if (command.id === 'clear') { store.createSession(); return done('已新建对话，原对话保留在历史中。'); }
    if (command.id === 'rename') {
      if (!session || typeof values.name !== 'string' || !values.name.trim()) throw new Error('请输入对话名称。');
      session.title = values.name.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, 200);
      if (!session.title) throw new Error('请输入有效的对话名称。');
      return done('对话已重命名。');
    }
    if (command.id === 'color') {
      if (!session || !['default', '#67d5df', '#54d99a', '#70a7ff', '#ed8e96', '#ddc56f'].includes(values.color)) throw new Error('请选择会话颜色。');
      session.color = values.color === 'default' ? null : values.color; return done('会话颜色已更新。');
    }
    if (command.id === 'branch') {
      if (!session) throw new Error('请选择对话。');
      const next = store.createSession();
      next.title = String(values.name || `${session.title} · 分支`).slice(0, 200);
      next.messages = structuredClone(session.messages); next.branchOf = session.id;
      return done('已创建独立对话分支。');
    }
    if (command.id === 'resume') {
      const selected = store.data.sessions.find(item => item.id === values.sessionId);
      if (!selected) throw new Error('请选择历史对话。');
      store.data.activeWorkspace = selected.workspace; store.data.activeSessionId = selected.id;
      await done('已恢复对话。'); return { close: true };
    }
    if (command.id === 'copy') {
      const number = Number(values.number || 1);
      if (!Number.isInteger(number) || number < 1) throw new Error('请选择回答序号。');
      const message = session?.messages.filter(item => item.role === 'assistant' && item.text).at(-number);
      if (!message) throw new Error('没有对应的回答。');
      await clipboard.writeText(message.text); return { type: 'text', content: '回答已复制。' };
    }
    if (command.id === 'export') {
      if (!session) throw new Error('请选择对话。');
      const json = values.format === 'json';
      const selected = await dialog.showSaveDialog(window, { title: '导出对话', defaultPath: path.join(requireWorkspace().path, `${session.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)}.${json ? 'json' : 'md'}`), filters: [{ name: json ? 'JSON' : 'Markdown', extensions: [json ? 'json' : 'md'] }] });
      if (selected.canceled || !selected.filePath) return { type: 'text', content: '已取消导出。' };
      const content = json ? JSON.stringify({ title: session.title, messages: session.messages }, null, 2) : `# ${session.title}\n\n${session.messages.map(item => `## ${item.role === 'user' ? '你' : 'Claude'}\n\n${item.text}`).join('\n\n')}`;
      await fs.writeFile(selected.filePath, content, 'utf8'); return { type: 'text', content: `已导出：${selected.filePath}` };
    }
    if (['model', 'effort', 'permissions', 'plan'].includes(command.id)) {
      const key = command.id === 'permissions' || command.id === 'plan' ? 'permissionMode' : command.id;
      const value = command.id === 'plan' ? 'plan' : values[key];
      if (key === 'model' && (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value))) throw new Error('请选择有效模型。');
      if (key === 'effort' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('请选择思考强度。');
      if (key === 'permissionMode' && !['manual', 'acceptEdits', 'auto', 'plan'].includes(value)) throw new Error('请选择权限模式。');
      store.data.preferences[key] = value;
      if (key === 'model') store.data.preferences.modelSourceId = connection.sourceId;
      return done('设置已应用。');
    }
    if (command.id === 'fast' || command.id === 'autocompact') {
      if (command.id === 'fast' && typeof values.enabled !== 'boolean') throw new Error('请选择是否请求快速模式。');
      if (command.id === 'autocompact' && values.window !== 'auto' && !(Number.isInteger(Number(values.window)) && Number(values.window) >= 100000 && Number(values.window) <= 1000000)) throw new Error('压缩窗口须为自动或 100000 到 1000000 个 token。');
      const scope = values.scope || 'all';
      if (command.id === 'autocompact' && !['model', 'all'].includes(scope)) throw new Error('请选择当前模型或所有模型。');
      const { canonicalClaudeModel, claudeModelAliases, hasAutoCompactEnvironmentOverride } = await import(pathToFileURL(path.join(__dirname, 'provider-config.mjs')).href);
      await commandActions.updateClaudeSettings(configDirectory, settings => {
        if (command.id === 'fast') {
          const next = { ...settings };
          if (values.enabled) next.fastMode = true;
          else delete next.fastMode;
          return next;
        }
        const environmentWindow = typeof settings.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW === 'string' ? settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW : process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        if (hasAutoCompactEnvironmentOverride(environmentWindow)) throw new Error('CLAUDE_CODE_AUTO_COMPACT_WINDOW 环境变量正在覆盖压缩窗口，请先调整该变量。');
        const next = { ...settings };
        if (scope === 'model') {
          const model = canonicalClaudeModel(values.model, claudeModelAliases({ ...process.env, ...settings.env }));
          if (!model) throw new Error('请先选择具体 Claude 模型；未确定模型时可设置所有模型的默认窗口。');
          if (settings.modelSettings !== undefined && (!settings.modelSettings || typeof settings.modelSettings !== 'object' || Array.isArray(settings.modelSettings))) throw new Error('modelSettings 格式无效，请先修复，原配置未修改。');
          const entry = settings.modelSettings?.[model];
          if (entry !== undefined && (!entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error('当前模型配置格式无效，请先修复，原配置未修改。');
          next.modelSettings = { ...settings.modelSettings, [model]: { ...entry, autoCompactWindow: values.window === 'auto' ? 'auto' : Number(values.window) } };
        } else if (values.window === 'auto') delete next.autoCompactWindow;
        else next.autoCompactWindow = Number(values.window);
        return next;
      });
      if (command.id === 'fast') store.data.preferences.fastMode = Boolean(values.enabled);
      await refreshConnection();
      return done(command.id === 'fast' ? '快速模式偏好已保存；下次 Claude 任务将请求该模式，是否可用取决于模型、账户和策略。' : `${scope === 'model' ? '当前模型的自动压缩窗口' : '所有模型的默认压缩窗口'}已保存，下次 Claude 任务生效。`);
    }
    if (command.id === 'add-dir') {
      const selected = await dialog.showOpenDialog(window, { title: '添加可访问目录', properties: ['openDirectory'] });
      if (selected.canceled) return { type: 'text', content: '已取消。' };
      const directory = await fs.realpath(selected.filePaths[0]);
      await commandActions.updateClaudeSettings(configDirectory, settings => ({ ...settings, permissions: { ...settings.permissions, additionalDirectories: [...new Set([...(settings.permissions?.additionalDirectories || []), directory])] } }));
      return { type: 'text', content: `已添加目录：${directory}` };
    }
    if (command.id === 'exit' || command.id === 'restart') {
      await store.save(); setTimeout(() => { if (command.id === 'restart') app.relaunch(); app.quit(); }, 100); return { close: true };
    }
    if (command.execution === 'manager' || command.execution === 'control') {
      const controller = new AbortController();
      const context = { workspace: currentWorkspace()?.path, configDirectory, session, connection, preferences: store.data.preferences,
        executablePath, tempDirectory: path.join(installRoot, 'temp'), cacheDirectory: path.join(installRoot, 'cache', 'xdg'), signal: controller.signal };
      const runtimeControl = (id, request = {}) => commandControl.runClaudeControl({ ...context, cwd: context.workspace || panelRoot, ...request, id, signal: controller.signal });
      const operation = async () => {
        const result = command.execution === 'manager'
          ? await commandActions.manageCommand(command.id, { ...context, runtimeControl }, values)
          : await runtimeControl(command.id, values);
        if (result.openUrl) {
          const url = new URL(result.openUrl);
          const allowed = url.protocol === 'https:' && ['code.claude.com', 'claude.ai', 'chromewebstore.google.com', 'marketplace.visualstudio.com', 'plugins.jetbrains.com'].includes(url.hostname)
            || url.protocol === 'vscode:' && url.hostname === 'file' && Boolean(context.workspace) && decodeURIComponent(url.pathname).replace(/^\//, '').replace(/\//g, '\\').toLowerCase() === context.workspace.replace(/\//g, '\\').toLowerCase();
          if (!allowed) throw new Error('不支持的外部链接。');
          await shell.openExternal(url.href);
        }
        if (result.changed || command.execution === 'control') { await refreshConnection(); loadCommands(true); emit(true); }
        return result;
      };
      const task = commandTask = { controller, promise: null };
      task.promise = operation();
      try { return await task.promise; }
      finally { if (commandTask === task) commandTask = null; }
    }
    if (command.execution === 'inspect') {
      return commandActions.inspectCommand(command.id, { workspace: currentWorkspace()?.path, configDirectory, session, connection, preferences: store.data.preferences }, values);
    }
    throw new Error('此操作由命令中心直接处理。');
  });
  handle('appearance-pick', async slot => {
    if (!['appIcon', 'claudeAvatar', 'userAvatar'].includes(slot)) throw new Error('无效的图标类型。');
    const selected = await dialog.showOpenDialog(window, { title: '选择图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico'] }] });
    if (selected.canceled || !selected.filePaths[0]) return snapshot();
    appearance = await appearanceAssets.importAsset(slot, selected.filePaths[0]);
    if (slot === 'appIcon') await applyApplicationIcon(true);
    emit(true); return snapshot();
  });
  handle('appearance-reset', async slot => {
    appearance = await appearanceAssets.resetAsset(slot);
    if (slot === 'appIcon') await applyApplicationIcon(true);
    emit(true); return snapshot();
  });
  handle('open-workspace', async requestedPath => {
    assertIdle();
    let directory = requestedPath;
    if (!directory) {
      const result = await dialog.showOpenDialog(window, { title: '打开工作文件夹', properties: ['openDirectory'], defaultPath: currentWorkspace()?.path });
      if (result.canceled) return snapshot();
      directory = result.filePaths[0];
    } else if (!store.data.workspaces.some(item => item.path === directory)) throw new Error('请使用“打开文件夹”选择新的工作目录。');
    await store.openWorkspace(directory);
    chosenAttachments.clear(); errorMessage = null; emit(true);
    return snapshot();
  });
  handle('new-session', async () => { assertIdle(); store.createSession(); errorMessage = null; await store.save(); emit(true); return snapshot(); });
  handle('select-session', async id => {
    assertIdle(); const session = store.data.sessions.find(item => item.id === id);
    if (!session) throw new Error('对话不存在。');
    store.data.activeWorkspace = session.workspace;
    store.data.activeSessionId = id; errorMessage = null; await store.save(); emit(true); return snapshot();
  });
  handle('delete-session', async id => {
    assertIdle(); store.data.sessions = store.data.sessions.filter(item => item.id !== id);
    if (store.data.activeSessionId === id) { store.data.activeSessionId = store.data.sessions.find(item => item.workspace === store.data.activeWorkspace)?.id ?? null; if (!store.data.activeSessionId && store.data.activeWorkspace) store.createSession(); }
    await store.save(); emit(true); return snapshot();
  });
  handle('list-sessions', () => snapshot().sessions);
  handle('list-directory', relative => workspaceApi.listDirectory(requireWorkspace().path, relative));
  handle('read-file', relative => workspaceApi.readTextFile(requireWorkspace().path, relative));
  handle('attachments', async () => {
    requireWorkspace(); const result = await dialog.showOpenDialog(window, { title: '选择附件', properties: ['openFile', 'multiSelections'], defaultPath: currentWorkspace().path });
    if (result.canceled) return [];
    const attachments = [];
    for (const file of result.filePaths) {
      const attachment = await chatAttachments.importFile(file);
      chosenAttachments.set(attachment.path, attachment);
      attachments.push(attachment);
    }
    return attachments;
  });
  handle('paste-image', async payload => {
    requireWorkspace();
    let bytes = payload?.bytes;
    if (!(bytes instanceof Uint8Array)) {
      const item = (await clipboard.read()).find(item => item.types.some(type => type.startsWith('image/')));
      if (!item) throw new Error('剪贴板中没有图片。');
      const blob = await item.getType(item.types.find(type => type.startsWith('image/')));
      if (blob.size > 10 * 1024 * 1024) throw new Error('图片超过 10 MB。');
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    const attachment = await chatAttachments.importBytes(bytes, payload?.name || '截图.png');
    chosenAttachments.set(attachment.path, attachment);
    return attachment;
  });
  const assetOptions = { allowedRoots: [path.join(dataRoot, 'attachments')] };
  handle('chat-asset', request => chatAssets.readChatAsset(requireWorkspace().path, request?.href, assetOptions));
  handle('open-chat-asset', async request => {
    const asset = await chatAssets.resolveChatAsset(requireWorkspace().path, request?.href, assetOptions);
    if (asset.openMode === 'reveal') shell.showItemInFolder(asset.path);
    else { const error = await shell.openPath(asset.path); if (error) throw new Error(error); }
    return { opened: true };
  });
  handle('save-chat-asset', async request => {
    const asset = await chatAssets.resolveChatAsset(requireWorkspace().path, request?.href, assetOptions);
    const selection = await dialog.showSaveDialog(window, { title: '保存原文件', defaultPath: asset.path });
    if (selection.canceled || !selection.filePath) return { saved: false };
    if (path.resolve(selection.filePath).toLowerCase() !== path.resolve(asset.path).toLowerCase()) await fs.copyFile(asset.path, selection.filePath);
    return { saved: true, path: selection.filePath };
  });
  handle('reveal-file', async relative => {
    const root = requireWorkspace().path;
    if (relative) shell.showItemInFolder(await workspaceApi.resolveWorkspacePath(root, relative));
    else { const result = await shell.openPath(root); if (result) throw new Error(result); }
  });
  handle('open-config', async () => { const result = await shell.openPath(configDirectory); if (result) throw new Error(result); });
  handle('preferences', async preferences => {
    if (!preferences || typeof preferences !== 'object') throw new Error('无效的设置。');
    const allowedModes = new Set(['manual', 'acceptEdits', 'plan', 'auto']);
    const allowedEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    if (preferences.theme && !Object.hasOwn(themeBackgrounds, preferences.theme)) throw new Error('不支持该界面主题。');
    if (preferences.permissionMode && !allowedModes.has(preferences.permissionMode)) throw new Error('不支持该权限模式。');
    if (preferences.effort && !allowedEfforts.has(preferences.effort)) throw new Error('不支持该思考强度。');
    if (preferences.model && (typeof preferences.model !== 'string' || preferences.model.length > 200 || /[\r\n\0]/.test(preferences.model))) throw new Error('无效的模型名称。');
    if (preferences.model && preferences.sourceId && preferences.sourceId !== connection.sourceId) throw new Error('渠道已切换，请从当前渠道的列表重新选择模型。');
    for (const key of ['model', 'effort', 'permissionMode', 'theme']) if (preferences[key]) store.data.preferences[key] = preferences[key];
    if (preferences.model) store.data.preferences.modelSourceId = connection.sourceId;
    await store.save(); applyNativeTheme(); emit(true); return snapshot();
  });
  handle('send-message', async request => {
    assertIdle();
    sendInitializing = true;
    let releaseInitialization;
    sendInitializationDone = new Promise(resolve => { releaseInitialization = resolve; });
    let initializedRunId = null;
    try {
    const workspace = requireWorkspace(); await refreshConnection(); alignProviderSelection(true);
    const expectedProviderKey = connectionService.requestKey;
    if (shuttingDown) throw new Error('工作台正在关闭。');
    if (!request || typeof request.text !== 'string') throw new Error('请输入任务。');
    if (request.text.length > 200000) throw new Error('消息过长，请把内容保存为文件后添加附件。');
    const attachments = Array.isArray(request.attachments) ? [...new Set(request.attachments.filter(item => item && chosenAttachments.has(item.path)).map(item => item.path))].map(file => chosenAttachments.get(file)) : [];
    if (!request.text.trim() && !attachments.length) throw new Error('请输入任务。');
    const inputImages = await chatAttachments.inputImages(attachments);
    const preferences = { ...store.data.preferences };
    if (request.model && (!request.sourceId || request.sourceId === connection.sourceId)) preferences.model = request.model;
    if (request.effort) preferences.effort = request.effort;
    if (request.permissionMode) preferences.permissionMode = request.permissionMode;
    if (!['manual', 'acceptEdits', 'plan', 'auto'].includes(preferences.permissionMode)) throw new Error('无效的权限模式。');
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(preferences.effort)) throw new Error('无效的思考强度。');
    if (typeof preferences.model !== 'string' || preferences.model.length > 200 || /[\r\n\0]/.test(preferences.model)) throw new Error('无效的模型名称。');
    let resolvedModel = preferences.model === 'default' ? connection.configuredModel : preferences.model;
    const imageGeneration = request.imageGeneration === true;
    if (imageGeneration && !/^(?:gpt-|o\d|codex-)/i.test(resolvedModel || '')) {
      resolvedModel = connection.catalog?.models?.find(item => /^gpt-6\.1-sol$/i.test(item.id))?.id
        || connection.catalog?.models?.find(item => /^gpt-(?!image-|.*(?:audio|realtime))/i.test(item.id))?.id;
      if (!resolvedModel) throw new Error('当前渠道未提供支持图片生成的 Responses 对话模型，请在 CC Switch 切换到支持生图的渠道。');
    }
    if (!resolvedModel && connection.catalog?.status === 'ready' && connection.catalog.models.some(item => /^(?:gpt-|o\d|codex-)/i.test(item.id)) && !connection.catalog.models.some(item => /^claude/i.test(item.id))) throw new Error('当前渠道没有配置默认模型，请先在输入框下方选择一个对话模型。');
    const useResponses = /^(?:gpt-|o\d|codex-)/i.test(resolvedModel || '');
    if (/^(?:gpt-image-|.*(?:audio|realtime))/i.test(resolvedModel || '')) throw new Error('这个模型用于图片、音频或实时任务，请选择代码对话模型。');
    store.data.preferences = preferences;
    const session = store.currentSession || store.createSession();
    const createdAt = new Date().toISOString();
    const user = { id: randomUUID(), role: 'user', text: request.text.trim() || '请查看这张图片。', createdAt, attachments, ...(imageGeneration ? { imageGeneration: true } : {}) };
    const assistant = { id: randomUUID(), role: 'assistant', text: '', createdAt };
    session.messages.push(user, assistant);
    if (session.title === '新对话') session.title = user.text.slice(0, 32);
    session.updatedAt = createdAt;
    run = { id: randomUUID(), status: 'running', startedAt: createdAt, assistantMessageId: assistant.id };
    initializedRunId = run.id;
    clearPermissions(); errorMessage = null;
    await store.save(); emit(true);
    if (shuttingDown) throw new Error('工作台正在关闭。');
    const runId = run.id;
    let prompt = attachments.length ? `${user.text}\n\n用户明确选择了以下附件，可按任务需要读取：\n${attachments.map(item => JSON.stringify(item.path)).join('\n')}` : user.text;
    let historyContext;
    service = useResponses ? responsesService : claudeService;
    run.engine = useResponses ? 'responses' : 'claude';
    const engine = useResponses ? 'responses' : 'claude';
    const switchingEngine = session.lastEngine && session.lastEngine !== engine;
    if (switchingEngine) { if (useResponses) session.directResponsesSessionId = null; else session.claudeSessionId = null; }
    const resumeSessionId = useResponses ? session.directResponsesSessionId : session.claudeSessionId;
    if (!resumeSessionId && session.messages.length > 2) {
      const history = session.messages.slice(0, -2).slice(-20).filter(item => item.text && !item.error && !/^(?:API Error:|Failed to authenticate)/.test(item.text)).map(item => `${item.role}: ${item.text}`).join('\n\n').slice(-40000);
      if (history) {
        const context = `以下是此对话之前的记录，供继续任务参考：\n${history}`;
        if (!useResponses && /^\/[\w:-]+(?:\s|$)/.test(user.text)) historyContext = context;
        else prompt = `${context}\n\n当前任务：\n${prompt}`;
      }
    }
    session.lastEngine = engine;
    const task = service.run({ runId, cwd: workspace.path, prompt, historyContext, inputImages, imageGeneration, model: useResponses ? resolvedModel : preferences.model, effort: preferences.effort, permissionMode: preferences.permissionMode, resumeSessionId, expectedProviderKey }).catch(error => {
      if (run?.status !== 'stopping') { errorMessage = errorText(error); assistant.error = errorMessage; }
    }).finally(async () => {
      if (run?.id !== runId) { if (runTask === task) runTask = null; return; }
      await refreshChanges().catch(() => {});
      const stopped = run.status === 'stopping';
      if (!assistant.text) assistant.text = stopped ? '任务已停止。' : errorMessage ? `本次请求失败：${errorMessage}` : '本次任务未返回文本。请查看操作记录。';
      for (const tool of session.tools) if (tool.status === 'running') tool.status = stopped ? 'error' : 'done';
      run = null; clearPermissions(); session.updatedAt = new Date().toISOString();
      await store.save().catch(error => { errorMessage = errorText(error); });
      if (runTask === task) runTask = null;
      alignProviderSelection();
      emit(true);
    });
    runTask = task;
    return snapshot();
    } catch (error) {
      if (initializedRunId && run?.id === initializedRunId && !runTask) { run = null; clearPermissions(); }
      throw error;
    } finally {
      sendInitializing = false;
      releaseInitialization();
      alignProviderSelection();
    }
  });
  handle('permission', async response => {
    if (!permission || response?.id !== permission.id) throw new Error('该确认请求已结束。');
    if (!['allow', 'deny'].includes(response.decision)) throw new Error('无效的确认操作。');
    permissionQueue.shift(); syncPermission();
    const accepted = service.respondPermission(response);
    emit(true);
    if (!accepted) throw new Error('该确认请求已结束。');
    return snapshot();
  });
  handle('stop', async () => { if (run) { run.status = 'stopping'; service.stop(); clearPermissions(); emit(true); } return snapshot(); });
  handle('clear-error', () => { errorMessage = null; emit(true); return snapshot(); });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 800, minHeight: 620,
    title: 'Claude 工作台', backgroundColor: themeBackgrounds[store.data.preferences.theme] || themeBackgrounds['tech-dark'],
    icon: applicationIconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    show: false,
  });
  if (process.platform === 'win32') window.setAppDetails({
    appId,
    appIconPath: applicationIconPath,
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${panelRoot}"`,
    relaunchDisplayName: 'Claude 工作台',
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:4317; object-src 'none'; base-uri 'self'"] } }));
  window.once('ready-to-show', () => window.show());
  window.on('focus', () => refreshConnection().catch(error => { errorMessage = errorText(error); emit(true); }));
  if (process.env.CLAUDE_PANEL_DEV_URL) await window.loadURL(process.env.CLAUDE_PANEL_DEV_URL);
  else await window.loadFile(path.join(panelRoot, 'dist', 'index.html'));
  window.on('closed', () => { window = null; service?.stop(); });
}

const singleInstance = process.env.CLAUDE_PANEL_TEST ? true : app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    await Promise.all([dataRoot, configDirectory, tempDirectory].map(directory => fs.mkdir(directory, { recursive: true })));
    workspaceApi = await import(pathToFileURL(path.join(__dirname, 'workspace.mjs')).href);
    chatAssets = await import(pathToFileURL(path.join(__dirname, 'local-assets.mjs')).href);
    const { ChatAttachments } = await import(pathToFileURL(path.join(__dirname, 'chat-attachments.mjs')).href);
    chatAttachments = new ChatAttachments({ directory: path.join(dataRoot, 'attachments'), nativeImage });
    store = new workspaceApi.WorkspaceStore(dataRoot);
    await store.load();
    const { AppearanceAssets } = await import(pathToFileURL(path.join(__dirname, 'appearance-assets.mjs')).href);
    appearanceAssets = new AppearanceAssets({ directory: path.join(dataRoot, 'appearance'), nativeImage, defaults: { appIcon: path.join(panelRoot, 'assets', 'app-icon.png'), claudeAvatar: path.join(panelRoot, 'assets', 'assistant-avatar.png'), userAvatar: path.join(panelRoot, 'assets', 'user-avatar.png'), appIconIco: defaultIconPath } });
    appearance = await appearanceAssets.getAppearance();
    applicationIconPath = await appearanceAssets.getApplicationIconPath();
    commandApi = await import(pathToFileURL(path.join(__dirname, 'command-catalog.mjs')).href);
    commandActions = await import(pathToFileURL(path.join(__dirname, 'command-actions.mjs')).href);
    commandControl = await import(pathToFileURL(path.join(__dirname, 'claude-control.mjs')).href);
    commandCatalog = { categories: commandApi.COMMAND_CATEGORIES, commands: commandApi.buildCommandCatalog(), loading: false };
    applyNativeTheme();
    if (store.data.activeWorkspace) { try { await fs.access(store.data.activeWorkspace); } catch { store.data.activeWorkspace = null; store.data.activeSessionId = null; } }
    const { ConnectionService } = await import(pathToFileURL(path.join(__dirname, 'connection-service.mjs')).href);
    connectionService = new ConnectionService({
      configDirectory,
      ...(process.env.CLAUDE_PANEL_TEST_CONFIG_DIR && process.env.CLAUDE_PANEL_TEST ? { metadataDirectory: path.join(configDirectory, 'no-ccswitch') } : {}),
      packageFile: null,
      onChange(next, { providerChanged }) { const hadSource = Boolean(connection.sourceId); connection = next; if (providerChanged && hadSource) pendingProviderReset = true; alignProviderSelection(); emit(true); },
      onError(error) { errorMessage = errorText(error); emit(true); },
    });
    connectionService.connection.claudeVersion = runtime.claudeVersion;
    await refreshConnection();
    connectionService.start();
    const { ClaudeService } = await import(pathToFileURL(path.join(__dirname, 'claude-service.mjs')).href);
    claudeService = new ClaudeService({ executablePath, configDirectory, tempDirectory: path.join(installRoot, 'temp'), cacheDirectory: path.join(installRoot, 'cache', 'xdg'), onEvent: onServiceEvent });
    const { ResponsesService } = await import(pathToFileURL(path.join(__dirname, 'responses-service.mjs')).href);
    responsesService = new ResponsesService({ configDirectory, tempDirectory: path.join(installRoot, 'temp'), cacheDirectory: path.join(dataRoot, 'responses'), onEvent: onServiceEvent });
    service = claudeService;
    registerHandlers();
    await createWindow();
  }).catch(error => { dialog.showErrorBox('Claude 工作台启动失败', errorText(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    connectionService?.stop();
    commandDiscovery?.abort();
    commandTask?.controller.abort();
    if (run) run.status = 'stopping';
    service?.stop(); clearPermissions(); clearTimeout(persistTimer);
    (async () => {
      try {
        await sendInitializationDone;
        if (runTask) await runTask;
        if (commandTask?.promise) await commandTask.promise.catch(() => {});
        clearTimeout(persistTimer);
        if (store) await store.save();
      } catch (error) { errorMessage = errorText(error); }
      finally { shutdownComplete = true; app.quit(); }
    })();
  });
}
