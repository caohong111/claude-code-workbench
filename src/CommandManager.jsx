import React, { useEffect, useRef, useState } from 'react';
import { Check, Chrome, CircleAlert, Code2, ExternalLink, FileText, LoaderCircle, Pencil, PlugZap, Plus, RefreshCw, Save, Settings2, ShieldCheck, Trash2, Workflow, X } from 'lucide-react';
import './command-manager.css';

const DOCUMENT_KINDS = new Set(['skills', 'agents', 'output-style']);
const SCOPES = [['user', '全局'], ['project', '当前项目']];
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact', 'Setup', 'TeammateIdle', 'TaskCompleted', 'ConfigChange', 'InstructionsLoaded', 'WorktreeCreate', 'WorktreeRemove'];
const HOOK_LABELS = { PreToolUse: '执行操作之前', PostToolUse: '操作完成之后', PostToolUseFailure: '操作失败时', PermissionRequest: '请求权限时', PermissionDenied: '权限被拒绝时', UserPromptSubmit: '发送消息时', Notification: '收到通知时', Stop: '回答结束时', SubagentStart: '代理开始工作时', SubagentStop: '代理结束工作时', SessionStart: '开始对话时', SessionEnd: '结束对话时', PreCompact: '压缩对话之前', PostCompact: '压缩对话之后', Setup: '初始化项目时', TeammateIdle: '协作者空闲时', TaskCompleted: '任务完成时', ConfigChange: '配置发生变化时', InstructionsLoaded: '项目规则加载后', WorktreeCreate: '创建工作副本时', WorktreeRemove: '移除工作副本时' };
const CONTEXT_LABELS = { Chat: '聊天输入', Global: '全局', Autocomplete: '输入建议', Settings: '设置', Confirmation: '确认窗口', Tabs: '标签页', Help: '帮助', Transcript: '会话记录', HistorySearch: '历史搜索', Task: '任务', ThemePicker: '主题选择', Attachments: '附件', Footer: '底部工具栏', MessageSelector: '消息选择', DiffDialog: '更改对话框', DiffPanel: '更改面板', ModelPicker: '模型选择', EffortSlider: '思考强度', Select: '选择菜单', Plugin: '插件', AbovePrompt: '输入框上方工具', AbovePromptInput: '工具输入框', AbovePromptSelect: '工具选项', Pane: '窗格', PaneField: '窗格字段', Agents: '代理', Scroll: '滚动' };
const STYLE_LABELS = { Default: '默认', Proactive: '主动协作', Concise: '简洁', Explanatory: '详细解释', Learning: '边做边学' };
const BINDING_CONTEXTS = ['Chat', 'Global', 'Autocomplete', 'Settings', 'Confirmation', 'Tabs', 'Help', 'Transcript', 'HistorySearch', 'Task', 'ThemePicker', 'Attachments', 'Footer', 'MessageSelector', 'DiffDialog', 'DiffPanel', 'ModelPicker', 'EffortSlider', 'Select', 'Plugin', 'AbovePrompt', 'AbovePromptInput', 'AbovePromptSelect', 'Pane', 'PaneField', 'Agents', 'Scroll'];
const BINDING_ACTIONS = [['', '取消此快捷键'], ['chat:submit', '发送消息'], ['chat:newline', '换行'], ['chat:cycleMode', '切换权限模式'], ['chat:modelPicker', '选择模型'], ['chat:fastMode', '切换快速模式'], ['chat:thinkingToggle', '切换扩展思考'], ['chat:externalEditor', '外部编辑器'], ['chat:stash', '暂存输入'], ['chat:imagePaste', '粘贴图片'], ['chat:cancel', '取消输入'], ['chat:queueSubmit', '加入发送队列'], ['chat:sendNow', '立即发送'], ['app:interrupt', '中断操作'], ['app:toggleTodos', '切换待办清单'], ['app:toggleTranscript', '切换会话记录'], ['history:search', '搜索历史'], ['confirm:yes', '确认'], ['confirm:no', '取消'], ['select:cancel', '关闭选择框'], ['command:compact', '压缩上下文'], ['command:model', '打开模型菜单'], ['command:permissions', '打开权限菜单']];
const EXTRA_BINDING_ACTIONS = {
  Autocomplete: [['autocomplete:accept', '接受建议'], ['autocomplete:dismiss', '关闭菜单'], ['autocomplete:previous', '上一项'], ['autocomplete:next', '下一项']],
  Settings: [['settings:search', '搜索设置'], ['settings:retry', '重试加载用量'], ['select:accept', '打开或更改设置'], ['confirm:no', '关闭设置']],
  Tabs: [['tabs:next', '下一个标签页'], ['tabs:previous', '上一个标签页']],
  Help: [['help:dismiss', '关闭帮助']],
  Transcript: [['transcript:toggleShowAll', '切换显示全部'], ['transcript:exit', '关闭记录']],
  HistorySearch: [['historySearch:next', '下一个匹配'], ['historySearch:accept', '接受选择'], ['historySearch:cancel', '取消搜索'], ['historySearch:execute', '执行所选项'], ['historySearch:cycleScope', '切换搜索范围']],
  Task: [['task:background', '转到后台']],
  ThemePicker: [['theme:toggleSyntaxHighlighting', '切换语法高亮']],
  Attachments: [['attachments:next', '下一个附件'], ['attachments:previous', '上一个附件'], ['attachments:remove', '移除附件'], ['attachments:exit', '退出附件导航']],
  Footer: [['footer:next', '下一项'], ['footer:previous', '上一项'], ['footer:openSelected', '打开所选项'], ['footer:clearSelection', '取消选择'], ['footer:close', '停止或移除任务']],
  DiffDialog: [['diff:dismiss', '返回或关闭'], ['diff:previousSource', '上一个来源'], ['diff:nextSource', '下一个来源'], ['diff:previousFile', '上一个文件'], ['diff:nextFile', '下一个文件']],
  DiffPanel: [['app:cycleDiffBase', '切换比较基准'], ['app:toggleDiffNoiseFilter', '过滤测试与生成文件'], ['app:toggleDiffPreSession', '切换会话前更改']],
  ModelPicker: [['modelPicker:decreaseEffort', '降低思考强度'], ['modelPicker:increaseEffort', '提高思考强度'], ['modelPicker:thisSessionOnly', '仅用于当前会话']],
  EffortSlider: [['effortSlider:decreaseEffort', '降低思考强度'], ['effortSlider:increaseEffort', '提高思考强度'], ['effortSlider:thisSessionOnly', '仅用于当前会话']],
  Select: [['select:next', '下一项'], ['select:previous', '上一项'], ['select:first', '第一项'], ['select:last', '最后一项'], ['select:accept', '确认选择'], ['select:cancel', '取消选择']],
  Plugin: [['plugin:toggle', '切换选择'], ['plugin:install', '安装插件'], ['plugin:favorite', '收藏插件']],
  AbovePrompt: [['abovePrompt:toggle', '折叠或展开'], ['abovePrompt:focus', '切换区域焦点'], ['abovePrompt:next', '下一个控件'], ['abovePrompt:previous', '上一个控件'], ['abovePrompt:press', '触发控件'], ['abovePrompt:leave', '返回输入框']],
  Pane: [['pane:scrollUp', '向上滚动'], ['pane:scrollDown', '向下滚动'], ['pane:grow', '扩大窗格'], ['pane:shrink', '缩小窗格'], ['pane:close', '关闭窗格']],
  Agents: [['agents:switchView', '切换分组'], ['agents:togglePin', '置顶或取消置顶'], ['agents:find', '查找会话'], ['agents:rename', '重命名会话']],
  Scroll: [['scroll:lineUp', '向上滚动'], ['scroll:lineDown', '向下滚动'], ['scroll:pageUp', '上一页'], ['scroll:pageDown', '下一页'], ['scroll:top', '回到顶部'], ['scroll:bottom', '回到底部']],
};
function bindingActions(context) {
  if (EXTRA_BINDING_ACTIONS[context]) return [BINDING_ACTIONS[0], ...EXTRA_BINDING_ACTIONS[context]];
  const prefixes = context === 'Global' ? ['app:'] : context === 'Chat' ? ['chat:', 'history:', 'command:'] : context === 'Confirmation' ? ['confirm:'] : [];
  return BINDING_ACTIONS.filter(([action]) => !action || prefixes.some(prefix => action.startsWith(prefix)));
}
const TEMPLATES = {
  skills: '---\nname: my-skill\ndescription: 描述何时使用这个技能\n---\n\n',
  agents: '---\nname: my-agent\ndescription: 描述这个代理的职责\ntools: Read, Glob, Grep\n---\n\n',
  'output-style': '---\nname: my-style\ndescription: 描述回答的风格\nkeep-coding-instructions: true\n---\n\n',
};

function Field({ label, children, ...props }) {
  const control = React.isValidElement(children) && !children.props['aria-label'] && !children.props['aria-labelledby']
    ? React.cloneElement(children, { 'aria-label': label }) : children;
  return <label className="manager-field" {...props}><span>{label}</span>{control}</label>;
}

function Options({ label, value, options, onChange, disabled }) {
  return <fieldset className="manager-options"><legend>{label}</legend><div>{options.map(([id, name]) => <label key={id} className={value === id ? 'selected' : ''}><input type="radio" name={`manager-${label}`} value={id} checked={value === id} disabled={disabled} onChange={() => onChange(id)} /><span>{name}</span></label>)}</div></fieldset>;
}

function Switch({ label, checked, disabled, onChange }) {
  return <label className="command-switch manager-switch"><span>{label}</span><input type="checkbox" role="switch" checked={Boolean(checked)} disabled={disabled} onChange={event => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}

function SettingRow({ icon: Icon, title, description, children }) {
  return <div className="manager-setting-row">{Icon && <Icon className="manager-setting-icon" size={22} />}<div className="manager-setting-copy"><strong>{title}</strong>{description && <p>{description}</p>}</div><div className="manager-setting-control">{children}</div></div>;
}

function documentContent(id, form) {
  if (form.customContent) return form.content;
  const frontmatter = [`name: ${JSON.stringify(form.name || '')}`, `description: ${JSON.stringify(form.description || '')}`];
  if (id === 'agents') frontmatter.push('tools: Read, Glob, Grep');
  if (id === 'output-style') frontmatter.push('keep-coding-instructions: true');
  return `---\n${frontmatter.join('\n')}\n---\n\n${form.instructions || ''}\n`;
}

function documentParts(content) {
  const header = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content || '')?.[0] || '';
  return { header, body: (content || '').slice(header.length) };
}

function ToolButton({ label, icon: Icon, children, ...props }) {
  return <button type="button" className={children ? 'button manager-button' : 'icon-button manager-icon'} title={label} aria-label={label} {...props}><Icon size={14} />{children}</button>;
}

function linesToObject(value) {
  return Object.fromEntries(String(value || '').split('\n').filter(line => line.trim()).map(line => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('变量和请求头请每行填写 名称=值。');
    return [line.slice(0, index).trim(), line.slice(index + 1)];
  }));
}

function flattenBindings(value) {
  return (Array.isArray(value) ? value : []).flatMap(group => Object.entries(group.bindings || {}).map(([key, action]) => ({ context: group.context || 'Chat', key, action: action === null ? '' : action })));
}

export default function CommandManager({ id, onAction, disabled: externallyDisabled, workspace }) {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState(null);
  const [document, setDocument] = useState(null);
  const [removeId, setRemoveId] = useState(null);
  const [bindings, setBindings] = useState([]);
  const [statusLine, setStatusLine] = useState({ command: '', padding: 0 });
  const [dirty, setDirty] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const actionRef = useRef(onAction);
  const mounted = useRef(true);
  const pendingRef = useRef(false);
  const editorRef = useRef(null);
  actionRef.current = onAction;
  const disabled = externallyDisabled || pending;
  const config = data?.config || {};
  const items = data?.items || [];
  const workspacePath = typeof workspace === 'string' ? workspace : workspace?.path;
  const formOpen = Boolean(form);
  const documentOpen = Boolean(document);
  const editing = formOpen || documentOpen;

  async function act(values = { action: 'list' }) {
    if (pendingRef.current || externallyDisabled) return null;
    pendingRef.current = true;
    setPending(true); setError(''); setMessage('');
    try {
      const next = await actionRef.current(values);
      if (!mounted.current) return null;
      if (next?.type === 'manager') {
        setData(next);
        if (next.document) { setDocument(next.document); setDirty(false); }
        if (id === 'keybindings') { setBindings(flattenBindings(next.config?.bindings || next.bindings || [])); setDirty(false); }
        if (id === 'statusline') { setStatusLine({ command: next.config?.command || next.config?.statusLine?.command || '', padding: next.config?.padding ?? next.config?.statusLine?.padding ?? 0 }); setDirty(false); }
      }
      setMessage(next?.changed ? ({ create: '已创建', save: '已保存', remove: '已删除', uninstall: '已卸载', install: '已安装', select: '已应用', toggle: '已更新', preset: '已应用', approve: '授权设置已保存' }[values.action] || '已完成') : '');
      return next;
    } catch (failure) {
      if (mounted.current) setError(failure.message || '操作失败，请重试。');
      return null;
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    // Opening settings can briefly block requests; load once that block clears.
    if (!externallyDisabled && !data && !error && !pendingRef.current) act({ action: 'list' });
  }, [externallyDisabled, data, error]);

  useEffect(() => {
    if (!formOpen && !documentOpen) return;
    const editor = editorRef.current;
    editor?.querySelector('header')?.scrollIntoView({ block: 'nearest' });
    editor?.querySelector('input:not([type="radio"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)')?.focus({ preventScroll: true });
  }, [formOpen, documentOpen]);

  function change(key, value) {
    setForm(previous => ({ ...previous, [key]: value }));
  }
  function changeBinding(index, key, value) {
    setBindings(previous => previous.map((row, i) => i === index ? { ...row, [key]: value, ...(key === 'context' && !bindingActions(value).some(([action]) => action === row.action) ? { action: bindingActions(value)[1]?.[0] || '' } : {}) } : row)); setDirty(true);
  }
  function beginForm() {
    setDocument(null); setRemoveId(null); setError('');
    setForm({ scope: 'user', type: 'http', name: '', description: '', instructions: '', customContent: false, command: '', args: '', url: '', env: '', headers: '', event: 'PreToolUse', matcher: '', timeout: 60, source: '', content: TEMPLATES[id] || '' });
  }

  async function submit(event) {
    event.preventDefault();
    let values = { ...form, action: id === 'plugin' ? 'install' : DOCUMENT_KINDS.has(id) ? 'create' : 'add' };
    try {
      if (id === 'mcp') values = { ...values, args: form.args.split('\n').filter(line => line.length), env: linesToObject(form.env), headers: linesToObject(form.headers) };
      if (DOCUMENT_KINDS.has(id)) values.content = documentContent(id, form);
      const next = await act(values);
      if (next) setForm(null);
    } catch (failure) { setError(failure.message); }
  }

  function scopeField() {
    return <Options label="保存位置" value={form.scope} options={SCOPES.filter(([scope]) => scope !== 'project' || workspacePath)} onChange={value => change('scope', value)} disabled={disabled} />;
  }

  function deleteButton(item, payload) {
    const key = item.id || item.path || `${item.scope}-${item.name || item.event}-${item.index}`;
    return removeId === key ? <div className="manager-delete-confirm"><button type="button" disabled={disabled} onClick={async () => { if (await act({ action: 'remove', ...payload })) setRemoveId(null); }}>确认删除</button><ToolButton label="取消删除" icon={X} onClick={() => setRemoveId(null)} disabled={disabled} /></div>
      : <ToolButton label={`删除 ${item.name || item.event || ''}`} icon={Trash2} disabled={disabled || item.readOnly} onClick={() => setRemoveId(key)} />;
  }

  function managerList() {
    if (!items.length) return <p className="manager-empty">{({ skills: '尚未添加技能', agents: '尚未添加代理', 'output-style': '尚未添加自定义风格', mcp: '尚未连接工具', hooks: '尚未添加自动化规则', plugin: '尚未安装插件' })[id] || '暂无项目'}</p>;
    return <div className="manager-list">{items.map((item, index) => <div className="manager-row" key={item.id || item.path || `${item.scope}-${item.name || item.event}-${index}`}>
      <div className="manager-row-main"><strong>{item.name || HOOK_LABELS[item.event] || item.event || item.id}</strong><span>{[item.scope === 'project' ? '当前项目' : item.scope === 'local' ? '项目本地' : item.scope === 'user' ? '所有项目' : item.scope, id === 'mcp' ? item.type === 'stdio' ? '本地程序' : '网络服务' : item.version].filter(Boolean).join(' · ')}</span>
        {item.description && <small>{item.description}</small>}
        {(item.url || item.command) && <details className="manager-item-details"><summary>{id === 'hooks' ? '执行内容' : '连接详情'}</summary><code>{item.url || item.command}</code>{id === 'hooks' && item.matcher && item.matcher !== '*' && <p>匹配范围：{item.matcher}</p>}</details>}
        {item.pendingApproval && <small className="manager-pending">需要授权</small>}{item.hasSecrets && <small>已保存访问凭据</small>}{item.visibility && item.visibility !== 'on' && <small>{({ off: '已关闭', 'name-only': '按名称自动识别，也可手动使用', 'user-invocable-only': '仅手动使用' })[item.visibility] || item.visibility}</small>}
        {item.error && <small className="manager-error">{item.error}</small>}
      </div>
      <div className="manager-row-actions">
        {id === 'mcp' && <><Switch label={`${item.name} 启用`} checked={item.enabled !== false} disabled={disabled || !workspace} onChange={enabled => act({ action: 'toggle', name: item.name, scope: item.scope, enabled })} />{item.pendingApproval && <ToolButton label={`授权 ${item.name}`} icon={Check} disabled={disabled} onClick={() => act({ action: 'approve', name: item.name, scope: item.scope })} />}<ToolButton label={`重新连接 ${item.name}`} icon={PlugZap} disabled={disabled || !workspace || item.enabled === false || item.pendingApproval} onClick={() => act({ action: 'reconnect', name: item.name, scope: item.scope })} /></>}
        {DOCUMENT_KINDS.has(id) && <><ToolButton label={`编辑 ${item.name}`} icon={Pencil} disabled={disabled} onClick={() => { setForm(null); act({ action: 'read', path: item.path }); }}>编辑</ToolButton>
          {id === 'output-style' && <ToolButton label={`使用 ${item.name}`} icon={Check} disabled={disabled || config.selected === item.name} onClick={() => act({ action: 'select', name: item.name, scope: workspace ? 'local' : 'user' })} />}
          {typeof item.enabled === 'boolean' && id === 'skills' && <select className="manager-visibility" aria-label={`${item.name} 调用方式`} value={item.visibility || (item.enabled ? 'on' : 'off')} disabled={disabled || item.readOnly || item.toggleable === false} onChange={event => act({ action: 'toggle', name: item.name, path: item.path, visibility: event.target.value })}><option value="on">自动或手动使用</option><option value="name-only">自动识别名称</option><option value="user-invocable-only">仅手动使用</option><option value="off">关闭</option></select>}</>}
        {id === 'plugin' ? <><Switch label={`${item.name} 启用`} checked={item.enabled !== false} disabled={disabled} onChange={enabled => act({ action: enabled ? 'enable' : 'disable', name: item.name || item.id, scope: item.scope || 'user' })} /><ToolButton label={`更新 ${item.name}`} icon={RefreshCw} disabled={disabled} onClick={() => act({ action: 'update', name: item.name || item.id, scope: item.scope || 'user' })} /><ToolButton label={`卸载 ${item.name}`} icon={Trash2} disabled={disabled} onClick={() => setRemoveId(item.id || item.name)} /></>
          : deleteButton(item, DOCUMENT_KINDS.has(id) ? { path: item.path } : id === 'mcp' ? { name: item.name, scope: item.scope } : { scope: item.scope, event: item.event, index: item.index, revision: item.revision })}
      </div>
      {id === 'plugin' && removeId === (item.id || item.name) && <div className="manager-inline-confirm"><span>卸载 {item.name || item.id}？</span><button type="button" className="button" disabled={disabled} onClick={async () => { if (await act({ action: 'uninstall', name: item.name || item.id, scope: item.scope || 'user' })) setRemoveId(null); }}>卸载</button><ToolButton label="取消卸载" icon={X} disabled={disabled} onClick={() => setRemoveId(null)} /></div>}
    </div>)}</div>;
  }

  function addForm() {
    if (!form) return null;
    return <form className="manager-form" ref={editorRef} onSubmit={submit}>
      <header><strong>{({ plugin: '安装插件', mcp: '连接工具', hooks: '添加自动化规则', skills: '新建技能', agents: '新建代理', 'output-style': '新建回答风格' })[id] || '新建'}</strong><ToolButton label="关闭表单" icon={X} onClick={() => setForm(null)} disabled={disabled} /></header>
      {scopeField()}
      {id !== 'hooks' && <Field label={id === 'plugin' ? '插件名称' : DOCUMENT_KINDS.has(id) ? '名称（英文或数字）' : '名称'}><input aria-label={id === 'plugin' ? '插件名称' : '名称'} required value={form.name} onChange={event => change('name', event.target.value)} disabled={disabled} placeholder={id === 'plugin' ? 'name@marketplace' : undefined} maxLength={100} /></Field>}
      {id === 'mcp' && <><Options label="连接方式" value={form.type} options={[["http", '网络服务'], ['stdio', '本地程序'], ['sse', '旧版网络服务']]} onChange={value => change('type', value)} disabled={disabled} />
        {form.type === 'stdio' ? <><Field label="启动程序"><input required value={form.command} onChange={event => change('command', event.target.value)} disabled={disabled} /></Field><details className="manager-advanced"><summary>启动选项</summary><Field label="启动参数（每行一个）"><textarea rows={3} value={form.args} onChange={event => change('args', event.target.value)} disabled={disabled} /></Field><Field label="环境变量（每行 名称=值）"><textarea className="manager-secret-input" rows={2} value={form.env} onChange={event => change('env', event.target.value)} disabled={disabled} autoComplete="off" spellCheck={false} /></Field></details></>
          : <><Field label="服务地址"><input aria-label="服务器 URL" required type="url" value={form.url} onChange={event => change('url', event.target.value)} disabled={disabled} placeholder="https://" /></Field><details className="manager-advanced"><summary>访问凭据与请求头</summary><Field label="请求头（每行 名称=值）"><textarea className="manager-secret-input" rows={2} value={form.headers} onChange={event => change('headers', event.target.value)} disabled={disabled} autoComplete="off" spellCheck={false} /></Field></details></>}
      </>}
      {id === 'hooks' && <><Field label="触发时机"><select aria-label="触发事件" value={form.event} onChange={event => change('event', event.target.value)} disabled={disabled}>{(config.events || HOOK_EVENTS).map(event => <option key={event} value={event}>{HOOK_LABELS[event] || event}</option>)}</select></Field><Field label="执行的脚本或命令"><textarea aria-label="执行命令" required rows={3} value={form.command} onChange={event => change('command', event.target.value)} disabled={disabled} /></Field><details className="manager-advanced"><summary>更多选项</summary><Field label="匹配规则"><input value={form.matcher} onChange={event => change('matcher', event.target.value)} disabled={disabled} placeholder="Read|Write|Edit" /></Field><Field label="超时（秒）"><input type="number" min={1} max={3600} value={form.timeout} onChange={event => change('timeout', event.target.valueAsNumber)} disabled={disabled} /></Field></details></>}
      {DOCUMENT_KINDS.has(id) && <><Field label={id === 'skills' ? '什么时候使用' : id === 'agents' ? '擅长的任务' : '风格描述'}><input aria-label="用途说明" required={!form.customContent} value={form.description} onChange={event => change('description', event.target.value)} disabled={disabled || form.customContent} maxLength={2000} /></Field><Field label={id === 'output-style' ? '回答要求' : '操作要求'}><textarea aria-label="操作要求" required={!form.customContent} rows={6} value={form.instructions} onChange={event => change('instructions', event.target.value)} disabled={disabled || form.customContent} /></Field><details className="manager-advanced"><summary>高级编辑</summary><Field label="完整文档"><textarea aria-label="内容" className="manager-code" rows={10} value={documentContent(id, form)} onChange={event => setForm(previous => ({ ...previous, content: event.target.value, customContent: true }))} disabled={disabled} spellCheck={false} /></Field></details></>}
      <div className="manager-form-actions"><button type="submit" className="button primary" disabled={disabled}><Plus size={14} />{id === 'plugin' ? '安装' : '创建'}</button></div>
    </form>;
  }

  function documentEditor() {
    if (!document) return null;
    const parts = documentParts(document.content);
    return <div className="manager-document" ref={editorRef}><header><FileText size={18} /><strong>{document.name || '编辑要求'}</strong><ToolButton label="关闭编辑器" icon={X} disabled={disabled} onClick={() => setDocument(null)} /></header>
      {document.readOnly && <p className="manager-note">此文件含敏感内容或由扩展管理，当前只读。</p>}
      <Field label={id === 'output-style' ? '回答要求' : '操作要求'}><textarea rows={9} aria-label="编辑操作要求" value={parts.body} onChange={event => { const body = event.target.value; setDocument(previous => ({ ...previous, content: documentParts(previous.content).header + body })); setDirty(true); }} disabled={disabled || document.readOnly} /></Field>
      <details className="manager-advanced"><summary>高级编辑</summary><span className="manager-path">{document.path}</span><textarea className="manager-code" rows={12} aria-label="编辑文档内容" value={document.content || ''} onChange={event => { setDocument(previous => ({ ...previous, content: event.target.value })); setDirty(true); }} disabled={disabled || document.readOnly} spellCheck={false} /></details>
      <div className="manager-form-actions"><button type="button" className="button primary" disabled={disabled || !dirty || document.readOnly} onClick={() => act({ action: 'save', path: document.path, name: document.name, scope: document.scope, content: document.content, revision: document.revision })}><Save size={14} />保存</button></div>
    </div>;
  }

  function settings() {
    if (id === 'chrome') {
      const status = data.runtime?.statuses?.[0]?.status;
      return <><div className="manager-setting-group"><SettingRow icon={Chrome} title="浏览器控制" description="通过 Claude 官方扩展连接 Chrome"><Switch label="默认启用 Chrome 集成" checked={config.enabled} disabled={disabled} onChange={enabled => act({ action: 'toggle', enabled })} /></SettingRow><SettingRow title="连接状态" description={status ? '本次检测结果' : config.enabled ? '已开启，尚未检测连接' : '尚未开启'}><span className={`manager-state ${status === 'connected' ? 'is-connected' : ''}`}>{({ connected: '检测通过', failed: '连接失败', 'needs-auth': '需要登录', pending: '等待连接', disabled: '已关闭' })[status] || '未检测'}</span><button type="button" className="button" disabled={disabled || !workspacePath || !config.enabled} onClick={() => act({ action: 'probe' })}><PlugZap size={16} />检测连接</button></SettingRow><SettingRow title="Chrome 扩展" description="需要在 Chrome 中安装 Claude 官方扩展"><button type="button" className="button" disabled={disabled} onClick={() => act({ action: 'extension' })}><ExternalLink size={16} />安装扩展</button></SettingRow></div><p className="manager-requirement"><ShieldCheck size={17} /><span>需要 Claude 官方付费账户。API Key 和中转站令牌不支持浏览器连接。</span></p><details className="manager-advanced"><summary>连接帮助</summary>{config.authRequirement && <p className="manager-note">{config.authRequirement}</p>}<button type="button" className="button" disabled={disabled} onClick={() => act({ action: 'docs' })}><ExternalLink size={15} />查看官方连接说明</button></details></>;
    }
    if (id === 'ide') return <><div className="manager-setting-group"><SettingRow icon={Code2} title="自动连接编辑器" description="使用 Claude 官方扩展连接当前项目"><Switch label="自动连接 IDE" checked={config.enabled} disabled={disabled} onChange={enabled => act({ action: 'toggle', enabled })} /></SettingRow><SettingRow title="在 VS Code 中打开" description={workspacePath || '尚未选择工作文件夹'}><button type="button" className="button" disabled={disabled || !workspacePath} onClick={() => act({ action: 'open-vscode' })}><ExternalLink size={16} />打开</button></SettingRow><SettingRow title="编辑器扩展" description="Claude Code 官方 VS Code 扩展"><button type="button" className="button" disabled={disabled} onClick={() => act({ action: 'extension' })}><ExternalLink size={16} />安装扩展</button></SettingRow></div><p className="manager-note">此设置控制外部编辑器的自动连接，不代表编辑器已经连接。</p></>;
    if (id === 'statusline') return <><p className="manager-note manager-surface-note">仅用于 Claude Code 终端，不更改此工作台的状态栏。</p><SettingRow icon={Settings2} title="终端状态栏" description="选择显示的运行信息"><select aria-label="状态栏样式" value={config.selectedPreset || (config.command ? 'custom' : '')} disabled={disabled} onChange={event => { const preset = event.target.value; if (!preset) act({ action: 'remove' }); else if (preset === 'custom') setAdvanced(true); else act({ action: 'preset', preset }); }}><option value="">关闭</option><option value="compact">简洁</option><option value="detailed">详细</option>{config.command && !config.selectedPreset && <option value="custom">自定义</option>}</select></SettingRow><div className="manager-form-actions"><ToolButton label="自定义脚本" icon={Pencil} disabled={disabled} onClick={() => setAdvanced(value => !value)}>自定义脚本</ToolButton></div>{advanced && <form className="manager-form" onSubmit={event => { event.preventDefault(); act({ action: 'save', command: statusLine.command, padding: statusLine.padding }); }}><Field label="状态栏命令"><textarea required rows={4} value={statusLine.command} onChange={event => { setStatusLine(previous => ({ ...previous, command: event.target.value })); setDirty(true); }} disabled={disabled} /></Field><Field label="左右留白"><input type="number" min={0} max={20} value={statusLine.padding} onChange={event => { setStatusLine(previous => ({ ...previous, padding: event.target.valueAsNumber || 0 })); setDirty(true); }} disabled={disabled} /></Field><div className="manager-form-actions"><button type="submit" className="button primary" disabled={disabled || !dirty || !statusLine.command.trim()}><Save size={14} />保存</button></div></form>}</>;
    if (id === 'keybindings') return <><div className="manager-binding-list">{bindings.map((binding, index) => <div className="manager-binding" key={index}>
      <Field label="生效区域"><select aria-label={`快捷键 ${index + 1} 上下文`} value={binding.context} disabled={disabled} onChange={event => changeBinding(index, 'context', event.target.value)}>{[...new Set([...BINDING_CONTEXTS, binding.context])].map(context => <option key={context} value={context}>{CONTEXT_LABELS[context] || context}</option>)}</select></Field>
      <Field label="按键"><input aria-label={`快捷键 ${index + 1} 按键`} value={binding.key} disabled={disabled} placeholder="ctrl+k" onChange={event => changeBinding(index, 'key', event.target.value)} /></Field>
      <Field label="操作"><select aria-label={`快捷键 ${index + 1} 操作`} value={binding.action} disabled={disabled} onChange={event => changeBinding(index, 'action', event.target.value)}>{bindingActions(binding.context).map(([action, label]) => <option key={action} value={action}>{label}</option>)}{binding.action && !bindingActions(binding.context).some(([action]) => action === binding.action) && <option value={binding.action}>{binding.action}</option>}</select></Field>
      <ToolButton label={`移除快捷键 ${index + 1}`} icon={Trash2} disabled={disabled} onClick={() => { setBindings(previous => previous.filter((_, i) => i !== index)); setDirty(true); }} /></div>)}</div><div className="manager-form-actions"><ToolButton label="添加快捷键" icon={Plus} disabled={disabled} onClick={() => { setBindings(previous => [...previous, { context: 'Chat', key: '', action: 'chat:submit' }]); setDirty(true); }}>添加</ToolButton><button type="button" className="button primary" disabled={disabled || !dirty || bindings.some(row => !row.context.trim() || !row.key.trim())} onClick={() => {
      const grouped = new Map();
      for (const row of bindings) { const context = row.context.trim(); if (!grouped.has(context)) grouped.set(context, {}); grouped.get(context)[row.key.trim()] = row.action.trim() || null; }
      act({ action: 'save', bindings: [...grouped].map(([context, entries]) => ({ context, bindings: entries })) });
    }}><Save size={14} />保存</button></div></>;
    return null;
  }

  const listKind = ['mcp', 'hooks', 'plugin'].includes(id) || DOCUMENT_KINDS.has(id);
  return <section className="command-manager" aria-label={`${id} 管理`}>
    <div className={`manager-toolbar ${listKind ? '' : 'is-utility'}`}><span>{listKind && data ? `${items.length} 项` : null}</span><div>{id === 'mcp' && <ToolButton label="检测 MCP 连接" icon={PlugZap} disabled={disabled || !workspacePath} onClick={() => act({ action: 'probe' })}>检测连接</ToolButton>}{listKind && <ToolButton label={id === 'plugin' ? '安装插件' : '添加'} icon={Plus} disabled={disabled} onClick={beginForm}>{id === 'plugin' ? '安装插件' : '添加'}</ToolButton>}<ToolButton label="刷新状态" icon={RefreshCw} disabled={disabled} onClick={() => act({ action: 'list' })} /></div></div>
    {!data && !error && <div className="manager-loading" role="status"><LoaderCircle size={16} className="spin" />正在读取</div>}
    {data && <>{id === 'hooks' && !editing && <><SettingRow icon={Workflow} title="启用自动化" description={workspacePath ? '在当前项目中执行已保存的规则' : '执行已保存的自动化规则'}><Switch label="启用自动化" checked={config.effectiveEnabled ?? config.enabled} disabled={disabled} onChange={enabled => act({ action: 'toggle', scope: workspacePath ? 'local' : 'user', enabled })} /></SettingRow><details className="manager-advanced"><summary>作用范围</summary>{config.notice && <p className="manager-note">{config.notice}</p>}{Object.entries(config.enabledByScope || { user: config.enabled ?? !config.disableAllHooks }).map(([scope, enabled]) => <Switch key={scope} label={`${({ user: '全局', project: '项目', local: '项目本地' })[scope] || scope}设置：允许钩子`} checked={enabled} disabled={disabled} onChange={next => act({ action: 'toggle', scope, enabled: next })} />)}</details></>}
      {id === 'output-style' && !editing && <SettingRow icon={FileText} title="回答风格" description="应用于后续 Claude 对话"><select aria-label="当前输出风格" value={config.selected || 'Default'} disabled={disabled} onChange={event => act({ action: 'select', name: event.target.value, scope: workspacePath ? 'local' : 'user' })}>{[...new Set([...(config.builtins || ['Default']), ...items.map(item => item.name), config.selected].filter(Boolean))].map(name => <option key={name} value={name}>{STYLE_LABELS[name] || name}</option>)}</select></SettingRow>}
      {id === 'keybindings' && <p className="manager-note manager-surface-note">此处设置 Claude Code 终端快捷键。工作台聊天输入框使用回车发送，Ctrl + 回车换行。</p>}
      {listKind && !editing && managerList()}{addForm()}{documentEditor()}{settings()}
      {id === 'plugin' && <details className="manager-advanced"><summary>管理插件来源</summary><form className="manager-marketplace" onSubmit={event => { event.preventDefault(); const source = new FormData(event.currentTarget).get('source'); if (source) act({ action: 'marketplace-add', source }); }}><Field label="添加插件市场"><input name="source" required placeholder="owner/repository 或 URL" disabled={disabled} /></Field><button className="button" type="submit" disabled={disabled}><Plus size={14} />添加市场</button></form></details>}
      {data.runtime && <section className="manager-runtime" aria-label="连接检测结果"><h4>本次连接检测</h4>{data.runtime.statuses?.length ? <div className="manager-list">{data.runtime.statuses.map((item, index) => <div className="manager-row" key={item.name || index}><div className="manager-row-main"><strong>{item.name}</strong><span>{({ connected: '连接成功', failed: '连接失败', 'needs-auth': '需要登录授权', pending: '等待连接', disabled: '已停用' })[item.status] || item.status}{item.status === 'connected' && Number.isFinite(item.toolCount) ? ` · ${item.toolCount} 个工具` : ''}</span>{item.error && <small className="manager-error">{item.error}</small>}</div></div>)}</div> : <p className="manager-note">{id === 'chrome' ? '未检测到 Chrome 连接' : '未检测到 MCP 连接'}</p>}{data.runtime.message && <p className="manager-note">{data.runtime.message}</p>}</section>}
      {data.pendingCommand && <section className="manager-command-review" aria-label="安装命令确认"><h4>插件安装命令</h4><pre>{data.pendingCommand.command}</pre><div className="manager-form-actions"><button type="button" className="button primary" disabled={disabled} onClick={() => act({ ...data.pendingCommand, acceptCommand: data.pendingCommand.sha256 })}><Check size={14} />确认安装命令</button><button type="button" className="button" disabled={disabled} onClick={() => setData(previous => ({ ...previous, pendingCommand: null }))}><X size={14} />取消</button></div></section>}
    </>}
    {pending && data && <p className="manager-progress" role="status"><LoaderCircle size={14} className="spin" />处理中</p>}
    {message && <p className="manager-message" role="status"><Check size={14} />{message}</p>}
    {error && <p className="command-warning is-error" role="alert"><CircleAlert size={15} /><span>{error}</span></p>}
    {error && !data && <button type="button" className="button" disabled={disabled} onClick={() => act({ action: 'list' })}><RefreshCw size={14} />重试</button>}
  </section>;
}
