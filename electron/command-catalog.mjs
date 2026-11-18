import fs from 'node:fs/promises';
import path from 'node:path';

export const COMMAND_CATEGORIES = [
  { id: 'session', label: '对话与历史' },
  { id: 'model', label: '模型与权限' },
  { id: 'context', label: '上下文与记忆' },
  { id: 'workspace', label: '项目与文件' },
  { id: 'tools', label: '开发与任务' },
  { id: 'extensions', label: '技能与扩展' },
  { id: 'account', label: '账户与连接' },
  { id: 'system', label: '外观与系统' },
];

// Baseline mirrors the public command reference; live SDK discovery decides availability.
const definitions = [
  ['add-dir', '添加工作目录', 'workspace', 'panel', '添加允许访问的项目目录', '<目录>'],
  ['advisor', '顾问模型', 'model', 'unavailable', '设置为主模型提供建议的第二模型', '[模型或 off]'],
  ['agents', '子代理', 'extensions', 'manager', '创建和编辑项目与用户子代理'],
  ['artifact-capabilities', '制品能力参考', 'extensions', 'sdk', '加载制品运行时能力参考'],
  ['artifact-diagramming', '图表参考', 'extensions', 'sdk', '加载制品图表设计参考'],
  ['artifacts', '制品', 'tools', 'unavailable', '查看、打开或附加账户中的制品'],
  ['auto-mode-setup', '自动权限配置', 'model', 'sdk', '根据项目生成自动权限环境配置草稿'],
  ['autocompact', '自动压缩阈值', 'context', 'panel', '设置上下文自动压缩的阈值', '[auto 或 token 数]'],
  ['autofix-pr', '自动修复 PR', 'tools', 'unavailable', '创建云任务跟进 PR 检查与审查'],
  ['background', '后台运行', 'session', 'unavailable', '把当前会话切换为后台会话', '[任务]'],
  ['batch', '批量修改', 'tools', 'sdk', '并行规划并执行跨代码库的大规模修改', '<任务>'],
  ['branch', '对话分支', 'session', 'panel', '从当前对话创建可独立继续的分支', '[名称]'],
  ['btw', '旁路提问', 'session', 'unavailable', '在不修改主对话历史的情况下提问', '[问题]'],
  ['bug', '报告问题', 'system', 'unavailable', '查看并确认要提交的问题与会话信息', '[说明]', ['feedback']],
  ['cd', '移动当前会话', 'workspace', 'unavailable', '保留当前对话并移动到新的工作目录', '<目录>'],
  ['chrome', '浏览器连接', 'extensions', 'manager', '设置默认浏览器集成并安装官方扩展'],
  ['claude-api', 'Claude API 助手', 'tools', 'sdk', '加载 Claude API 开发、迁移与优化技能', '[任务]'],
  ['claude-in-chrome', '浏览器任务', 'tools', 'sdk', '通过 Claude in Chrome 执行浏览器任务', '[任务]'],
  ['clear', '新建对话', 'session', 'panel', '开始空上下文的新对话并保留历史', '[名称]', ['new', 'reset']],
  ['code-review', '代码审查', 'tools', 'sdk', '审查当前差异、分支、路径或 PR', '[目标]', ['review']],
  ['color', '会话颜色', 'system', 'panel', '选择会话强调色', '[颜色或 default]'],
  ['compact', '压缩上下文', 'context', 'sdk', '总结当前对话以释放上下文', '[保留重点]'],
  ['config', '连接与设置', 'system', 'panel', '打开工作台设置', '[设置]', ['settings']],
  ['context', '上下文用量', 'context', 'inspect', '查看最近请求用量与会话消息数'],
  ['copy', '复制回答', 'session', 'panel', '复制第 N 条最近的 Claude 回答', '[N]'],
  ['dataviz', '数据可视化', 'tools', 'sdk', '加载图表、仪表盘与数据展示设计技能', '[需求]'],
  ['debug', '排查问题', 'tools', 'sdk', '排查 Claude Code 配置或运行问题', '[问题]'],
  ['deep-research', '深入研究', 'tools', 'sdk', '并行搜索、交叉核对并生成研究报告', '<问题>'],
  ['design', '设计画布', 'tools', 'sdk', '创建 UI、流程、网页或海报设计', '[设计需求]'],
  ['design-login', '设计系统授权', 'account', 'unavailable', '授权 Claude Design 设计系统访问'],
  ['design-sync', '同步设计系统', 'tools', 'sdk', '将仓库中的 React 设计系统同步到 Claude Design', '[提示]'],
  ['desktop', 'Claude Desktop', 'system', 'unavailable', '在官方 Claude Desktop 中继续会话', '', ['app']],
  ['diff', '文件更改', 'workspace', 'panel', '查看本次对话的文件更改'],
  ['doctor', '环境诊断', 'system', 'sdk', '检查安装、设置、扩展与项目说明', '[检查目标]'],
  ['effort', '思考强度', 'model', 'panel', '选择模型的思考强度', '[强度]'],
  ['exit', '退出工作台', 'system', 'panel', '保存会话并关闭工作台', '', ['quit']],
  ['export', '导出对话', 'session', 'panel', '将当前对话保存为文本或 Markdown', '[文件名]'],
  ['fast', '快速模式', 'model', 'panel', '切换 Claude 快速模式', '[on 或 off]'],
  ['fewer-permission-prompts', '优化权限规则', 'model', 'sdk', '分析常用只读操作并建议项目权限规则'],
  ['focus', '专注视图', 'system', 'panel', '收起侧栏并聚焦当前对话'],
  ['fork', '创建后台会话副本', 'session', 'unavailable', '复制当前会话到后台并继续当前对话', '[任务]'],
  ['goal', '持续目标', 'tools', 'unavailable', '设置跨轮次持续执行的目标', '[目标或 clear]'],
  ['heapdump', '内存快照', 'system', 'unavailable', '导出 CLI 内存诊断快照'],
  ['help', '命令中心', 'system', 'panel', '浏览和搜索全部命令'],
  ['hooks', '钩子配置', 'extensions', 'manager', '添加、编辑和移除用户与项目 Hook'],
  ['ide', '编辑器集成', 'extensions', 'manager', '设置编辑器自动连接并打开官方扩展'],
  ['import', '导入配置', 'extensions', 'unavailable', '从 Codex、Gemini 或 Cursor 导入配置', '[来源]'],
  ['init', '初始化项目', 'workspace', 'sdk', '为当前项目创建 CLAUDE.md 指南'],
  ['insights', '使用洞察', 'context', 'sdk', '分析本机近期会话并生成使用报告'],
  ['install-github-app', 'GitHub 集成', 'extensions', 'unavailable', '安装官方 GitHub App 与相关工作流'],
  ['install-slack-app', 'Slack 集成', 'extensions', 'unavailable', '在浏览器中安装官方 Slack App'],
  ['keybindings', '快捷键', 'system', 'manager', '编辑 Claude Code 终端快捷键配置'],
  ['list-agents', '可通信的代理与会话', 'tools', 'unavailable', '列出可发送消息的代理、队友和其他会话', '', ['peers']],
  ['login', '登录账户', 'account', 'unavailable', '登录 Anthropic 账户'],
  ['logout', '退出账户', 'account', 'unavailable', '退出 Anthropic 账户'],
  ['loop', '重复任务', 'tools', 'unavailable', '在会话存续期间按间隔重复执行任务', '[间隔] <任务>'],
  ['mcp', 'MCP 服务器', 'extensions', 'manager', '添加、启停和移除 MCP 服务器', '[操作]'],
  ['memory', '项目规则', 'context', 'inspect', '编辑当前项目的 CLAUDE.md；自动记忆管理尚未接入'],
  ['mobile', 'Claude 移动版', 'account', 'unavailable', '打开 Claude 移动版下载页面', '', ['ios', 'android']],
  ['model', '切换模型', 'model', 'panel', '选择当前渠道的模型', '[模型 ID]'],
  ['output-style', '输出风格', 'model', 'manager', '选择内置风格或编辑自定义输出风格', '[风格]'],
  ['passes', '分享体验', 'account', 'unavailable', '查看账户可分享的 Claude Code 体验资格'],
  ['permissions', '操作权限', 'model', 'panel', '切换工作台权限模式；沿用已有的工具权限规则'],
  ['plan', '计划模式', 'model', 'panel', '进入仅分析、先计划的模式', '[任务]'],
  ['plugin', '插件管理', 'extensions', 'manager', '安装、启停和卸载 Claude Code 插件', '[操作]', ['plugins']],
  ['plugin-authoring', '插件开发参考', 'extensions', 'sdk', '加载编写 Claude Code 插件的参考'],
  ['powerup', '功能学习', 'system', 'unavailable', '查看官方交互式功能课程'],
  ['privacy-settings', '隐私设置', 'account', 'unavailable', '查看 Anthropic 账户隐私设置'],
  ['radio', 'Claude 电台', 'system', 'unavailable', '打开 Claude FM 电台'],
  ['rate-limit-options', '用量限制选项', 'account', 'unavailable', '查看订阅用量限制后的可用选项'],
  ['recap', '会话摘要', 'context', 'sdk', '生成当前会话的简短摘要'],
  ['release-notes', '更新日志', 'system', 'inspect', '查看 Claude Code 官方更新记录'],
  ['reload-plugins', '检查插件加载', 'extensions', 'control', '在独立 Claude 查询中检查插件加载；后续对话读取新配置'],
  ['reload-skills', '重新扫描技能', 'extensions', 'control', '在独立 Claude 查询中重新扫描技能；后续对话读取磁盘变更'],
  ['remote-control', '远程控制', 'account', 'unavailable', '将会话连接到 claude.ai 远程控制', '', ['rc']],
  ['remote-env', '云环境', 'account', 'unavailable', '选择默认 Claude 云环境'],
  ['rename', '重命名对话', 'session', 'panel', '修改当前对话的名称', '<名称>'],
  ['restart', '重启工作台', 'system', 'panel', '保存并重新打开工作台', '', ['update']],
  ['resume', '历史对话', 'session', 'panel', '选择并继续已有对话', '[会话]', ['continue']],
  ['rewind', '回退检查点', 'session', 'unavailable', '选择会话或文件检查点并预览回退', '', ['checkpoint', 'undo']],
  ['run', '运行项目', 'tools', 'sdk', '运行项目并检查改动效果', '[目标]'],
  ['run-skill-generator', '生成运行技能', 'extensions', 'sdk', '为项目编写运行与验证技能'],
  ['sandbox', '沙盒设置', 'model', process.platform === 'win32' ? 'unavailable' : 'inspect', '配置受支持平台上的 Claude Code 沙盒'],
  ['schedule', '云端计划任务', 'tools', 'unavailable', '管理 Claude 云端定时任务', '[任务]', ['routines']],
  ['scroll-speed', '滚动速度', 'system', 'unavailable', '调整 CLI 全屏渲染器的滚轮速度'],
  ['security-review', '安全审查', 'tools', 'sdk', '检查当前分支的安全风险'],
  ['setup-bedrock', 'Amazon Bedrock', 'account', 'unavailable', '配置 Amazon Bedrock 身份与模型'],
  ['setup-vertex', 'Google Vertex', 'account', 'unavailable', '配置 Google 云身份与模型'],
  ['simplify', '简化代码', 'tools', 'sdk', '检查代码复用、复杂度与效率并改进', '[目标]'],
  ['skill-doctor', '技能诊断', 'extensions', 'unavailable', '统计技能的上下文开销与使用频率'],
  ['skills', '技能管理', 'extensions', 'manager', '编辑技能并设置对 Claude 与命令菜单的可见性'],
  ['slides', '创建演示文稿', 'tools', 'sdk', '创建 Claude Slides 演示文稿', '[需求]'],
  ['status', '连接状态', 'account', 'inspect', '查看版本、渠道、模型与认证状态'],
  ['statusline', 'CLI 状态栏', 'system', 'manager', '配置 Claude Code 终端状态栏脚本', '[需求]'],
  ['stickers', 'Claude 贴纸', 'account', 'unavailable', '查看官方贴纸可用情况'],
  ['stop', '停止任务', 'session', 'panel', '停止当前工作台任务'],
  ['subtask', '创建子任务', 'tools', 'unavailable', '创建继承当前上下文的后台子代理', '<任务>'],
  ['tasks', '后台任务', 'tools', 'unavailable', '查看和管理当前会话的后台工作及已完成子代理', '', ['bashes']],
  ['team-onboarding', '团队入门指南', 'tools', 'sdk', '根据近期用法生成团队配置与入门指南'],
  ['teleport', '拉取云会话', 'session', 'unavailable', '拉取云端会话的分支与历史', '', ['tp']],
  ['terminal-setup', '终端配置', 'system', 'unavailable', '配置终端的多行输入与系统集成'],
  ['theme', '界面主题', 'system', 'panel', '切换工作台界面主题'],
  ['tui', '终端渲染器', 'system', 'unavailable', '切换 CLI 普通或全屏渲染模式', '[default 或 fullscreen]'],
  ['ultrareview', '云端深度审查', 'tools', 'unavailable', '在 Claude 云端进行多代理代码审查', '[PR 或分支]'],
  ['update-config', '配置修改助手', 'extensions', 'sdk', '根据需求修改 Claude 配置', '[设置需求]'],
  ['upgrade', '升级订阅', 'account', 'unavailable', '打开 Claude 订阅升级页面'],
  ['usage', '用量与费用', 'account', 'inspect', '查看当前会话用量与估算费用', '', ['cost', 'stats']],
  ['usage-credits', '额外用量', 'account', 'unavailable', '管理 Anthropic 账户的额外用量额度', '', ['extra-usage']],
  ['verify', '验证项目', 'tools', 'sdk', '构建、运行并检查代码改动效果', '[目标]'],
  ['voice', '语音输入', 'system', 'unavailable', '切换官方 Claude 语音听写', '[hold、tap 或 off]'],
  ['web-setup', '云端 GitHub 连接', 'account', 'unavailable', '为 Claude 云端会话授权 GitHub'],
  ['workflow-authoring', '工作流开发参考', 'extensions', 'sdk', '加载动态工作流脚本开发参考'],
  ['workflows', '工作流', 'tools', 'unavailable', '查看、暂停、恢复或保存动态工作流'],
];

const unavailableReasons = {
  advisor: '当前工作台尚未接入顾问模型的会话控制。',
  artifacts: '需要支持制品的官方账户与制品运行时，当前工作台未接入。',
  'autofix-pr': '需要 Anthropic 云任务与 GitHub 授权，当前工作台未接入。',
  background: '当前工作台尚未接入 Claude 后台会话的附加与分离控制。',
  btw: '当前工作台尚未接入不修改主历史的旁路会话。',
  cd: '尚未接入保留原生会话上下文的目录迁移；右上角“打开文件夹”管理的是独立工作区。',
  bug: '当前工作台尚未接入官方问题报告与会话上传流程。',
  'design-login': '需要 Claude Design 的官方账户授权流程。',
  desktop: '此操作会将会话交给官方 Claude Desktop；当前工作台不提供该转移流程。',
  fork: '尚未接入原生后台会话。若要切换到独立对话副本，请使用“创建对话分支”。',
  goal: '当前工作台尚未接入跨轮次持续目标。',
  heapdump: '此命令用于 CLI 进程内存诊断，当前桌面会话未提供导出接口。',
  import: '当前工作台尚未实现配置导入与冲突预览。',
  'install-github-app': '需要 GitHub App 授权与仓库工作流配置，当前工作台未接入。',
  'install-slack-app': '需要官方 Slack App 的安装与工作区授权流程。',
  login: '当前工作台使用 CC Switch 配置；尚未接入 Anthropic 官方 OAuth 登录。',
  logout: '当前工作台尚未接入 Anthropic OAuth 账户管理。',
  'list-agents': '尚未接入 Claude 跨会话通信与可通信代理列表。工具操作记录不代表代理列表。',
  loop: '当前工作台尚未接入会话内的定时任务调度。',
  passes: '需要具备分享资格的 claude.ai 订阅账户。',
  'privacy-settings': '需要 Anthropic 官方账户的隐私设置接口。',
  'rate-limit-options': '需要 claude.ai 订阅与官方用量限制处理流程。',
  'remote-control': '需要 claude.ai 订阅登录及官方远程控制会话，当前工作台未接入。',
  'remote-env': '需要官方云会话与云环境管理。',
  rewind: '当前工作台尚未保存可预览并还原的 Claude 文件检查点。',
  sandbox: '原生 Windows 不支持 Claude Code 沙盒。官方支持 macOS、Linux 和 WSL2；当前进程未运行在 WSL2 中。',
  schedule: '需要支持云定时任务的官方账户、GitHub 授权与云环境。',
  'scroll-speed': '此设置仅用于 CLI 的全屏终端渲染器。',
  'setup-bedrock': '当前工作台尚未接入 Amazon Bedrock 身份、区域和模型配置向导。',
  'setup-vertex': '当前工作台尚未接入 Google Cloud 身份、项目和区域配置向导。',
  'skill-doctor': '尚未接入 Claude 技能开销与使用频率报告；本地文件列表不能替代该诊断。',
  subtask: '当前工作台尚未接入继承完整会话的后台分叉子代理。',
  tasks: '尚未接入 Claude 后台任务的查看、停止和管理。工作台“操作记录”仅记录本次工具调用。',
  teleport: '需要 claude.ai 订阅与官方云会话恢复流程。',
  'terminal-setup': '此操作配置外部终端；工作台输入框已直接支持多行输入。',
  tui: '此设置仅用于 CLI 的普通与全屏终端渲染器。',
  ultrareview: '需要 Anthropic 云端代码审查与具备资格的官方账户。',
  voice: '需要 Claude.ai 账户与官方语音听写集成，当前工作台未接入。',
  'web-setup': '需要本机 gh 授权与 Claude 官方云会话。',
  workflows: '当前工作台尚未接入动态工作流的监视、暂停和恢复接口。',
};
const managerCommandsWithoutWorkspace = new Set(['agents', 'chrome', 'hooks', 'keybindings', 'mcp', 'output-style', 'plugin', 'skills', 'statusline', 'reload-plugins', 'reload-skills']);
const implementationNotes = {
  'add-dir': '保存到 Claude 的全局可访问目录；GPT 文件工具仍只访问当前工作文件夹。',
  branch: '复制工作台中可见的对话历史，不复制 CLI 隐藏上下文或原生后台任务。',
  context: '仅提供最近请求的用量，不是 Claude 原生上下文组成分析。',
  diff: '仅显示工作台捕获的本次文件修改，不包含完整 Git 工作树差异。',
  permissions: '此页调整权限模式，尚未提供允许、询问、拒绝规则的编辑器。',
  model: '模型选择保存在工作台偏好中，不修改外部终端的默认模型。',
  effort: '思考强度保存在工作台偏好中；尚未提供原生 auto 和 ultracode 选项。',
  memory: '此页编辑项目规则，尚未提供自动记忆开关和条目管理。',
  usage: '仅提供工作台记录的请求用量；套餐限制和费用请以渠道账单为准。',
  export: '导出工作台中可见的对话内容，不包含 CLI 隐藏上下文。',
  theme: '更改工作台主题，不更改外部终端的 Claude Code 配色。',
  focus: '收起工作台侧栏，不修改 Claude Code 终端的 viewMode。',
  restart: '仅重启工作台并恢复历史，不安装或更新 Claude Code。',
};
const documentationPages = { agents: 'sub-agents', chrome: 'chrome', hooks: 'hooks', ide: 'vs-code', keybindings: 'keybindings', mcp: 'mcp', memory: 'memory', 'output-style': 'output-styles', plugin: 'plugins/overview', 'reload-plugins': 'plugins/cli-reference', 'reload-skills': 'skills', sandbox: 'sandboxing', skills: 'skills', statusline: 'statusline', autocompact: 'model-config' };
const clean = (value, length = 1000) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, length) : '';
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);

export const BUILTIN_COMMANDS = definitions.map(([id, label, category, execution, description, argumentHint = '', aliases = []]) => ({
  id, command: `/${id}`, label, category, execution, action: id, description, argumentHint, aliases,
  requiresWorkspace: !['system', 'account'].includes(category) && !managerCommandsWithoutWorkspace.has(id),
  documentationUrl: `https://code.claude.com/docs/zh-CN/${documentationPages[id] || 'commands'}`,
  builtin: true,
  ...(implementationNotes[id] ? { implementationNote: implementationNotes[id] } : {}),
  ...(execution === 'unavailable' ? { availabilityReason: unavailableReasons[id] || '此功能尚未接入当前工作台。' } : {}),
}));

export function buildCommandCatalog({ supportedCommands = [], discovered = false } = {}) {
  const supported = new Map();
  for (const row of supportedCommands) {
    if (!validName(row?.name)) continue;
    if (!supported.has(row.name) || supported.get(row.name).builtin === true && row.builtin !== true) supported.set(row.name, row);
  }
  const rows = BUILTIN_COMMANDS.map(baseline => {
    const runtime = supported.get(baseline.id);
    const overridden = runtime && runtime.builtin !== true;
    const available = baseline.execution !== 'unavailable' && (baseline.execution !== 'sdk' || Boolean(runtime) && !overridden);
    return { ...baseline, aliases: [...baseline.aliases], available,
      ...(runtime && !overridden ? { argumentHint: clean(runtime.argumentHint, 300) || baseline.argumentHint, runtimeAvailable: true } : {}),
      ...(overridden && baseline.execution === 'sdk' ? { overriddenBySkill: true, availabilityReason: '此命令已被同名自定义技能覆盖，请选择对应的“自定义技能”项目。' } : {}),
      ...(overridden && baseline.execution !== 'sdk' ? { implementationNote: `${baseline.implementationNote ? `${baseline.implementationNote} ` : ''}当前命令名已被自定义技能覆盖；此按钮执行工作台操作。运行技能请选择对应的“自定义技能”项目。` } : {}),
      ...(baseline.execution === 'sdk' && !runtime ? { availabilityReason: discovered ? '当前 Claude Code 未提供此技能或命令。' : '正在读取当前项目的命令。' } : {}),
    };
  });
  const known = new Set(rows.map(row => row.id));
  const reserved = new Set([...known, ...supported.keys()]);
  for (const [name, row] of supported) {
    const builtin = row.builtin === true;
    const collision = known.has(name);
    if (collision && builtin) continue;
    let id = name;
    if (collision) { do { id = `skill:${id}`; } while (reserved.has(id)); }
    reserved.add(id);
    rows.push({ id, command: `/${name}`, label: collision ? `自定义技能：${clean(name, 160)}` : clean(name, 160), description: clean(row.description),
      category: 'extensions', execution: builtin ? 'unavailable' : 'sdk', action: name,
      argumentHint: clean(row.argumentHint, 300), aliases: Array.isArray(row.aliases) ? row.aliases.filter(validName) : [],
      builtin, runtimeAvailable: true, available: !builtin, requiresWorkspace: true,
      ...(collision ? { overridesCommand: name } : {}),
      ...(builtin ? { availabilityReason: '当前工作台尚未接入此命令的可视化操作。' } : {}),
    });
  }
  return rows;
}

export async function discoverSupportedCommands({ cwd, executablePath, configDirectory, tempDirectory, cacheDirectory, signal, queryFactory }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 12000);
  let query;
  try {
    if (signal?.aborted) return [];
    let settings = {};
    try { settings = JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8')); } catch {}
    const settingsEnv = Object.fromEntries(Object.entries(settings.env || {}).filter(([, value]) => typeof value === 'string'));
    if (controller.signal.aborted) return [];
    const env = { ...process.env, ...settingsEnv, CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_TMPDIR: tempDirectory,
      TEMP: tempDirectory, TMP: tempDirectory, XDG_CACHE_HOME: cacheDirectory,
      DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const input = async function* () {
      if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    };
    const createQuery = queryFactory || (await import('@anthropic-ai/claude-agent-sdk')).query;
    query = createQuery({ prompt: input(), options: { cwd, env, pathToClaudeCodeExecutable: executablePath,
      persistSession: false, settingSources: ['user', 'project', 'local'], permissionMode: 'plan',
      abortController: controller, stderr: () => {} } });
    const cancelled = controller.signal.aborted ? Promise.resolve([]) : new Promise(resolve => controller.signal.addEventListener('abort', () => resolve([]), { once: true }));
    const commands = await Promise.race([query.supportedCommands(), cancelled]);
    return Array.isArray(commands) ? commands.filter(row => validName(row?.name)).map(row => ({ name: row.name,
      description: clean(row.description), argumentHint: clean(row.argumentHint, 300), builtin: row.builtin === true,
      aliases: Array.isArray(row.aliases) ? row.aliases.filter(validName) : [] })) : [];
  } catch { return []; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    try { query?.close(); } catch { /* A CLI that failed at startup may already be closed. */ }
  }
}
