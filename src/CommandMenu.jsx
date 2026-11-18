import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Cable, Check, ChevronRight, CircleAlert, Copy, Download, FileDiff, FilePenLine, FileText, FolderOpen, GitBranch, Globe, History, Layers,
  ListChecks, LoaderCircle, MessageSquare, Play, Plug, Plus, Search, Settings2, ShieldCheck, Sparkles,
  Terminal, UserRound, Workflow, X,
} from 'lucide-react';
import './command-menu.css';

const CATEGORY_ICONS = { session: MessageSquare, model: Sparkles, context: Layers, workspace: FolderOpen, tools: Workflow, extensions: Terminal, account: UserRound, system: Settings2 };
const SETTINGS_IDS = new Set(['config', 'settings', 'theme', 'model', 'permissions', 'effort', 'fast', 'autocompact', 'chrome', 'mcp', 'plugin', 'ide', 'memory', 'skills', 'agents', 'hooks', 'output-style', 'keybindings', 'statusline', 'status']);
const COMMON_IDS = ['clear', 'resume', 'rename', 'branch', 'compact', 'export', 'copy', 'diff', 'plan', 'model', 'chrome', 'mcp', 'plugin', 'skills', 'memory'];
const SIMPLE_LABELS = { clear: '新建对话', resume: '继续历史对话', rename: '重命名对话', branch: '创建对话分支', compact: '压缩对话', export: '导出对话', copy: '复制回答', diff: '本次文件更改', plan: '制定计划', model: '模型与权限', chrome: '浏览器', mcp: '工具连接', plugin: '插件', skills: '技能', memory: '项目规则' };
const COMMAND_ICONS = { clear: Plus, resume: History, rename: FilePenLine, branch: GitBranch, export: Download, copy: Copy, diff: FileDiff, tasks: ListChecks, model: ShieldCheck, chrome: Globe, mcp: Cable, plugin: Plug, skills: Sparkles, memory: FileText };
const DETAIL_LABELS = { version: 'Claude Code 版本', provider: '当前渠道', endpoint: '服务地址', configured: '已配置凭证', model: '模型', effort: '思考强度', permissionMode: '权限模式', workspace: '工作文件夹', configDirectory: '配置目录', inputTokens: '输入 Token', outputTokens: '输出 Token', cacheReadInputTokens: '缓存读取 Token', cacheCreationInputTokens: '缓存写入 Token', messages: '消息数量', note: '说明', source: '来源', cost: '费用', user: '全局配置', project: '项目配置', local: '项目本地配置', enabled: '启用', disabled: '禁用', sandbox: '沙箱', available: '可用', reason: '原因', totalCostUsd: '费用（美元）', durationMs: '耗时（毫秒）' };

function StructuredResult({ value }) {
  if (value === null || value === undefined) return <span className="command-value-muted">未提供</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <div className="command-value-list">{value.map((item, index) => <StructuredResult key={index} value={item} />)}</div> : <span className="command-value-muted">无</span>;
  return Object.keys(value).length ? <dl className="command-facts">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{DETAIL_LABELS[key] || key}</dt><dd><StructuredResult value={item} /></dd></div>)}</dl> : <span className="command-value-muted">未配置</span>;
}

function initialValues(command, state) {
  return { name: command?.id === 'rename' ? state.session?.title || '' : '', number: 1, format: 'markdown',
    color: state.session?.color || 'default', task: '', arguments: '' };
}

function Segments({ label, value, options, onChange, disabled }) {
  return <fieldset className="command-segments"><legend>{label}</legend><div>
    {options.map(([key, text]) => <label key={key} className={value === key ? 'selected' : ''}>
      <input type="radio" name={`command-${label}`} value={key} checked={value === key} disabled={disabled} onChange={() => onChange(key)} /><span>{text}</span>
    </label>)}
  </div></fieldset>;
}

export default function CommandMenu({ catalog = {}, state = {}, initialId = 'clear', onClose, onExecute, onOpenSettings, onInspectChanges, onInspectActivity, busy }) {
  const commands = catalog.commands || [];
  const [showAll, setShowAll] = useState(!COMMON_IDS.includes(initialId));
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(initialId);
  const [values, setValues] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  const closeRef = useRef(onClose);
  const selectionVersion = useRef(0);
  closeRef.current = onClose;
  const filtered = useMemo(() => {
    const query = search.trim().replace(/^\//, '').toLocaleLowerCase();
    if (!query && !showAll) return COMMON_IDS.map(id => commands.find(command => command.id === id)).filter(Boolean);
    return commands.filter(command => !query || `${SIMPLE_LABELS[command.id] || ''} ${command.label} ${command.command} ${command.description} ${(command.aliases || []).join(' ')}`.toLocaleLowerCase().includes(query));
  }, [commands, showAll, search]);
  const selected = commands.find(command => command.id === selectedId);
  const disabled = pending || Boolean(busy);
  const currentModel = state.preferences?.model === 'default' ? state.connection?.configuredModel : state.preferences?.model;
  const requiresClaude = selected?.execution === 'sdk' && /^(?:gpt-|o\d|codex-)/i.test(currentModel || '');
  const allowed = selected && selected.available !== false && selected.execution !== 'unavailable' && !requiresClaude && (!selected.requiresWorkspace || Boolean(state.workspace)) && (!state.run || selected.id === 'stop');
  const Icon = COMMAND_ICONS[selected?.id] || CATEGORY_ICONS[selected?.category] || Terminal;
  const isSettings = SETTINGS_IDS.has(selected?.id);

  function selectCommand(command) {
    if (SETTINGS_IDS.has(command.id)) { onOpenSettings?.(command.id); return; }
    setSelectedId(command.id);
  }

  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    function keyboard(event) {
      if (event.target.closest?.('.model-picker-popup')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current?.(); }
      if (event.key !== 'Tab') return;
      const elements = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter(element => element.getClientRects().length);
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (!commands.length) return;
    if (!filtered.some(command => command.id === selectedId)) setSelectedId(filtered.find(command => command.id === initialId)?.id || filtered[0]?.id || '');
  }, [filtered, selectedId, commands.length, initialId]);

  useEffect(() => {
    selectionVersion.current++;
    setValues(initialValues(selected, state)); setResult(null); setError('');
  }, [selected?.id]);

  function change(key, value) { setValues(previous => ({ ...previous, [key]: value })); }

  async function execute(overrides = {}) {
    if (!selected || !allowed || disabled) return;
    const version = selectionVersion.current;
    setPending(true); setError('');
    try {
      if (SETTINGS_IDS.has(selected.id)) { onClose?.(); onOpenSettings?.(selected.id); return; }
      if (selected.id === 'diff' && onInspectChanges) { onClose?.(); onInspectChanges(); return; }
      const payload = { ...values, ...overrides };
      const next = await onExecute?.(selected, payload);
      if (version !== selectionVersion.current) return;
      if (next?.close) { onClose?.(); return; }
      setResult(next || { type: 'text', content: '已完成' });
    } catch (failure) {
      if (version === selectionVersion.current) setError(failure?.message || '操作失败，请重试。');
    } finally { setPending(false); }
  }

  function fields() {
    if (!selected) return null;
    const id = selected.id;
    if (['rename', 'branch'].includes(id)) return <label className="command-input">对话名称<input value={values.name || ''} maxLength={200} onChange={event => change('name', event.target.value)} disabled={disabled} /></label>;
    if (id === 'copy') return <label className="command-input">最近第几条回答<input type="number" min={1} max={9999} step={1} value={values.number || 1} onChange={event => change('number', event.target.valueAsNumber || 1)} disabled={disabled} /></label>;
    if (id === 'export') return <Segments label="文件格式" value={values.format} options={[["markdown", 'Markdown'], ['json', 'JSON']]} onChange={value => change('format', value)} disabled={disabled} />;
    if (id === 'color') return <fieldset className="command-color-options"><legend>会话颜色</legend><div>{[['default', '默认'], ['#67d5df', '青色'], ['#54d99a', '绿色'], ['#70a7ff', '蓝色'], ['#ed8e96', '红色'], ['#ddc56f', '金色']].map(([value, label]) => <button type="button" key={value} title={label} aria-label={label} aria-pressed={values.color === value} disabled={disabled} style={{ '--swatch': value === 'default' ? 'var(--accent)' : value }} onClick={() => change('color', value)}>{values.color === value && <Check size={15} />}</button>)}</div></fieldset>;
    if (id === 'resume') return <div className="command-session-list">{(state.sessions || []).map(session => <button key={session.id} type="button" disabled={disabled} className={values.sessionId === session.id ? 'selected' : ''} onClick={() => change('sessionId', session.id)}><MessageSquare size={15} /><span>{session.title || '未命名对话'}</span>{values.sessionId === session.id && <Check size={14} />}</button>)}{!state.sessions?.length && <p className="command-empty">暂无历史对话</p>}</div>;
    if (selected.execution === 'sdk' || id === 'plan') return <label className="command-input">{id === 'compact' ? '保留重点' : '任务'}<textarea rows={5} value={values.arguments || values.task || ''} onChange={event => setValues(previous => ({ ...previous, task: event.target.value, arguments: event.target.value }))} disabled={disabled} /></label>;
    return null;
  }

  const actionText = selected?.id === 'add-dir' ? '选择文件夹'
      : SETTINGS_IDS.has(selected?.id) ? '打开设置'
        : selected?.id === 'copy' ? '复制回答' : selected?.id === 'export' ? '导出对话'
          : selected?.id === 'rename' ? '保存名称' : selected?.id === 'resume' ? '继续对话'
            : selected?.id === 'clear' ? '新建对话' : selected?.id === 'compact' ? '压缩对话'
              : selected?.id === 'branch' ? '创建分支' : selected?.id === 'plan' ? '开始计划'
                : selected?.id === 'reload-skills' ? '重新扫描' : selected?.id === 'reload-plugins' ? '检查加载' : selected?.execution === 'inspect' ? '查看' : SIMPLE_LABELS[selected?.id] || selected?.label || '确认';
  const invalid = selected?.id === 'rename' && !values.name?.trim()
    || selected?.id === 'resume' && !values.sessionId;

  return <div className="command-menu-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
    <section className="command-menu" ref={dialogRef} role="dialog" aria-modal="true" aria-label="命令中心">
      <header className="command-menu-header"><Workflow size={19} /><h2 id="command-menu-heading">快捷操作</h2>
        {catalog.loading && <LoaderCircle size={14} className="spin" aria-label="正在读取命令" />}
        <button type="button" className="icon-button" title="关闭命令中心" aria-label="关闭命令中心" onClick={onClose}><X size={18} /></button></header>
      <div className="command-menu-search"><Search size={17} /><input ref={searchRef} type="search" aria-label="搜索命令" placeholder="搜索功能" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !filtered.length) return;
        event.preventDefault(); const index = filtered.findIndex(command => command.id === selectedId); setSelectedId(filtered[(index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length].id);
      }} /></div>
      <div className="command-menu-body"><div className="command-list" aria-label="命令列表">
        {filtered.map(command => { const CommandIcon = COMMAND_ICONS[command.id] || CATEGORY_ICONS[command.category] || Terminal; return <button type="button" key={command.id} data-command-id={command.id} aria-current={selectedId === command.id ? 'true' : undefined} className={`command-row ${selectedId === command.id ? 'selected' : ''} ${command.available === false || command.execution === 'unavailable' ? 'unavailable' : ''}`} onClick={() => selectCommand(command)}><CommandIcon size={17} /><span><strong>{SIMPLE_LABELS[command.id] || command.label}</strong></span>{command.available === false || command.execution === 'unavailable' ? <small>不可用</small> : <ChevronRight size={14} />}</button>; })}
        {(!search || /操作|记录/.test(search)) && <button type="button" className="command-row" data-workbench-action="activity" onClick={() => { onClose?.(); onInspectActivity?.(); }}><ListChecks size={17} /><span><strong>操作记录</strong></span><ChevronRight size={14} /></button>}
        {!filtered.length && <p className="command-empty">没有匹配的功能</p>}
        {!search && <button type="button" className="command-more" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? '收起更多操作' : '更多操作'}<ChevronRight size={14} className={showAll ? 'rotated' : ''} /></button>}
      </div><div className="command-detail" aria-live="polite">
        {selected ? <><header className="command-detail-heading"><Icon size={21} /><div><h3>{SIMPLE_LABELS[selected.id] || selected.label}</h3></div></header>
          <p className="command-description">{selected.description}</p>
          {selected.implementationNote && <p className="command-scope-note">{selected.implementationNote}</p>}
          {!allowed && <p className="command-warning"><CircleAlert size={15} /><span>{state.run && selected.id !== 'stop' ? '当前任务运行中。' : requiresClaude ? '此命令需要 Claude 渠道，当前选择的是 Responses 模型。' : selected.requiresWorkspace && !state.workspace ? '请先打开一个工作文件夹。' : selected.availabilityReason || '当前配置不支持此命令。'}</span></p>}
          {allowed && !isSettings && fields()}
          {result && <section className="command-result" aria-label="操作结果">
            {result.title && <h4>{result.title}</h4>}
            {['files', 'sessions'].includes(result.type) && <div className="command-result-items">{(result.items || []).map((item, index) => <button type="button" key={item.path || item.id || index} disabled={disabled} onClick={() => execute(result.type === 'sessions' ? { sessionId: item.id } : { action: 'read', path: item.path })}><FileText size={14} /><span>{item.name || item.title || item.path}</span><ChevronRight size={13} /></button>)}</div>}
            {result.type === 'json' ? <StructuredResult value={result.content ?? result.items ?? {}} /> : result.content ? typeof result.content === 'string' ? <pre>{result.content}</pre> : <StructuredResult value={result.content} /> : null}
            {result.message && <p role="status">{result.message}</p>}
          </section>}
          {error && <p className="command-warning is-error" role="alert"><CircleAlert size={15} /><span>{error}</span></p>}
          <div className="command-detail-actions"><button type="button" className="button primary" disabled={isSettings ? disabled : !allowed || disabled || invalid} onClick={() => isSettings ? onOpenSettings?.(selected.id) : execute()}>{pending ? <LoaderCircle size={15} className="spin" /> : isSettings ? <Settings2 size={15} /> : selected.execution === 'inspect' ? <Search size={15} /> : <Play size={15} />}{pending ? '处理中' : actionText}</button></div>
          {showAll && <details className="command-technical"><summary>命令详情</summary><code>{selected.command}</code>{selected.aliases?.length > 0 && <div className="command-aliases">{selected.aliases.map(alias => <code key={alias}>/{alias}</code>)}</div>}</details>}
        </> : <div className="command-detail-empty"><Search size={26} /><span>没有匹配的功能</span></div>}
      </div></div>
      <footer className="command-menu-footer"><span>{catalog.loading ? '正在读取项目功能' : state.connection?.claudeVersion ? `Claude Code ${state.connection.claudeVersion}` : ''}</span><button type="button" onClick={() => onOpenSettings?.('general')}><Settings2 size={15} />设置</button></footer>
    </section>
  </div>;
}
