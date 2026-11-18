import React, { useCallback, useEffect, useRef, useState } from 'react';
import ChatMarkdown, { ChatAttachment } from './ChatMarkdown.jsx';
import ModelPicker from './ModelPicker.jsx';
import CommandMenu from './CommandMenu.jsx';
import CommandManager from './CommandManager.jsx';
import WorkbenchSettings, { SettingsSection, SettingsRow } from './WorkbenchSettings.jsx';
import AppearanceSettings from './AppearanceSettings.jsx';
import { THEME_OPTIONS, getTheme } from './themes.js';
import appIcon from '../assets/app-icon.png';
import claudeAvatar from '../assets/assistant-avatar.png';
import userAvatar from '../assets/user-avatar.png';
import {
  ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert,
  Code2, Copy, File, FileCode2, FileDiff, FileSearch, Folder, FolderOpen,
  Folders, ListChecks, LoaderCircle, Menu, MessageSquare, PanelRight,
  Palette, Paperclip, ImagePlus, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, Terminal, Trash2, X,
} from 'lucide-react';

const EFFORT_OPTIONS = [['low', '低'], ['medium', '中等'], ['high', '高'], ['xhigh', '很高'], ['max', '最高']];
const PERMISSION_OPTIONS = [['manual', '手动确认'], ['acceptEdits', '自动接受编辑'], ['auto', '自动判断'], ['plan', '仅做计划']];
const DEFAULT_PREFERENCES = { model: 'default', effort: 'medium', permissionMode: 'manual', theme: 'tech-dark' };
const SETTINGS_ROUTES = { config: 'general', settings: 'general', theme: 'appearance', permissions: 'model', effort: 'model', fast: 'model', autocompact: 'model', status: 'connection' };
const EMPTY_STATE = {
  workspaces: [], workspace: null, sessions: [], session: null, run: null,
  permission: null, preferences: DEFAULT_PREFERENCES, connection: {}, error: null,
};
const QUICK_TASKS = [
  { icon: FileSearch, title: '了解项目', prompt: '请先阅读当前文件夹，梳理项目用途、目录结构与启动方式，暂时不要修改文件。' },
  { icon: Code2, title: '排查问题', prompt: '请检查当前项目的配置与代码，找出可能阻碍运行的问题。先汇报问题和修复建议，等待我确认后再修改。' },
  { icon: ListChecks, title: '检查代码', prompt: '请审查当前项目，优先检查实际缺陷、边界条件和缺失的关键测试。给出具体文件位置，暂时不要修改。' },
];

function IconButton({ icon: Icon, label, className = '', children, ...props }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>
    <Icon size={17} aria-hidden="true" />{children}
  </button>;
}

function useModalFocus(onEscape) {
  const modalRef = useRef(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const modal = modalRef.current;
    modal?.querySelector('h2')?.focus();
    function handleKey(event) {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== modal) return;
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault();
        escapeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((element) => element.getClientRects().length);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.querySelector('h2'))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return modalRef;
}

function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
}

function getInputSummary(input = {}) {
  if (typeof input === 'string') return input;
  return input.command || input.file_path || input.path || input.pattern || input.description || input.prompt || '';
}

function ModelField({ preferences, connection = {}, modelSourceId, onChange, onRefresh, disabled, compact = false }) {
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const sourceId = connection.sourceId || '';
  const catalog = connection.catalog || {};
  const currentCatalog = !catalog.sourceId || !sourceId || catalog.sourceId === sourceId;
  const models = currentCatalog && Array.isArray(catalog.models) ? catalog.models.filter((model) => model.id && model.id !== 'default') : [];
  const loading = catalog.status === 'loading' || !currentCatalog;
  const error = currentCatalog && catalog.status === 'error';
  const knownModel = models.some((model) => model.id === preferences.model);
  const selectedOnSource = !sourceId || !modelSourceId || modelSourceId === sourceId;
  const selectedModel = preferences.model === 'default' || knownModel || selectedOnSource ? preferences.model : 'default';
  const showCustomSelection = selectedModel !== 'default' && !knownModel;
  const fieldId = compact ? 'composer-model' : 'settings-model';
  const providerName = connection.providerName || '当前渠道';
  const defaultLabel = connection.configuredModel ? `跟随 CC Switch · ${connection.configuredModel}` : '跟随 CC Switch';
  const recommended = catalog.source === 'codex';
  const catalogLabel = recommended ? 'Codex 推荐 · 渠道支持待确认' : providerName;
  const status = loading ? '正在获取模型列表' : error ? '模型列表获取失败' : models.length ? (recommended ? `Codex 推荐 ${models.length} 个模型 · 渠道支持待确认` : `${models.length} 个模型`) : catalog.status === 'ready' ? '渠道返回空模型列表' : '尚未获取模型列表';
  const statusTitle = [providerName, status, error && catalog.error].filter(Boolean).join(' · ');
  const groups = [
    { label: '', options: [{ value: 'default', label: compact ? '跟随 CC Switch' : defaultLabel }] },
    { label: catalogLabel, options: models.map(model => ({ value: model.id, label: model.displayName || model.id })) },
    { label: '', options: [...(showCustomSelection ? [{ value: selectedModel, label: selectedModel }] : []), ...((loading || error || !models.length) ? [{ value: '__catalog_status__', label: status, disabled: true }] : []), { value: '__custom__', label: '自定义模型…' }] },
  ];
  useEffect(() => { setCustomMode(false); setCustomValue(''); }, [sourceId]);

  function applyCustomModel() {
    if (disabled || !customValue.trim()) return;
    onChange({ model: customValue.trim() }); setCustomMode(false);
  }

  return <div className={`control-field model-field ${compact ? 'compact' : ''}`}>
    <label htmlFor={fieldId}>模型</label>
    <div className="model-provider" title={providerName}><span className={`connection-dot ${connection.hasCredential ? 'connected' : ''}`} /><span>{providerName}</span></div>
    <div className="model-input-row" aria-busy={loading}>
      <ModelPicker id={fieldId} value={customMode ? '__custom__' : selectedModel} groups={groups} title={`${providerName} · ${customMode ? '自定义模型' : selectedModel === 'default' ? defaultLabel : selectedModel}`} disabled={disabled} onChange={value => {
        if (value === '__custom__') { setCustomMode(true); setCustomValue(showCustomSelection ? selectedModel : ''); }
        else { setCustomMode(false); onChange({ model: value }); }
      }} />
      <IconButton icon={loading ? LoaderCircle : error ? CircleAlert : RefreshCw} label="刷新模型列表" title={statusTitle}
        className={`model-refresh ${loading ? 'is-loading' : ''} ${error ? 'has-error' : ''}`} disabled={!onRefresh || loading} onClick={onRefresh} />
    </div>
    <span className={`${compact ? 'visually-hidden' : 'model-catalog-status'} ${error ? 'status-warning' : ''}`} title={statusTitle} role="status">{status}{error && catalog.error ? `：${catalog.error}` : ''}</span>
    {customMode && <div className="custom-model-popover" onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); applyCustomModel(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCustomMode(false); }
    }}>
      <label htmlFor={`${fieldId}-custom`}>模型 ID</label>
      <div className="inline-form"><input id={`${fieldId}-custom`} value={customValue} onChange={(event) => setCustomValue(event.target.value)} autoFocus placeholder="模型 ID" />
        <IconButton icon={Check} label="应用模型" disabled={disabled || !customValue.trim()} onClick={applyCustomModel} />
        <IconButton icon={X} label="取消" onClick={() => setCustomMode(false)} /></div>
    </div>}
  </div>;
}

function PreferenceFields({ preferences, connection, modelSourceId, onChange, onRefreshModels, disabled, compact = false }) {
  return <>
    <ModelField preferences={preferences} connection={connection} modelSourceId={modelSourceId} onChange={onChange} onRefresh={onRefreshModels} disabled={disabled} compact={compact} />
    <div className={`control-field ${compact ? 'compact' : ''}`}><label htmlFor={compact ? 'toolbar-effort' : 'settings-effort'}>思考强度</label>
      <select id={compact ? 'toolbar-effort' : 'settings-effort'} value={preferences.effort} disabled={disabled} onChange={(event) => onChange({ effort: event.target.value })}>
        {EFFORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></div>
    <div className={`control-field permission-field ${compact ? 'compact' : ''}`}><label htmlFor={compact ? 'toolbar-permission' : 'settings-permission'}>操作权限</label>
      <select id={compact ? 'toolbar-permission' : 'settings-permission'} value={preferences.permissionMode} disabled={disabled} onChange={(event) => onChange({ permissionMode: event.target.value })}>
        {PERMISSION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></div>
  </>;
}

function FileTree({ workspacePath, api, onFile, reportError, changeRevision }) {
  const [directories, setDirectories] = useState({});
  const [expanded, setExpanded] = useState(new Set(['']));
  const [loading, setLoading] = useState(new Set());
  const [filter, setFilter] = useState('');

  const load = useCallback(async (path = '') => {
    if (!api || !workspacePath) return;
    setLoading((previous) => new Set(previous).add(path));
    try {
      const result = await api.listDirectory(path);
      setDirectories((previous) => ({ ...previous, [path]: (result.entries || []).map((entry) => ({ ...entry, isDirectory: entry.type === 'directory' || entry.isDirectory })) }));
    } catch (error) { reportError(error); }
    finally { setLoading((previous) => { const next = new Set(previous); next.delete(path); return next; }); }
  }, [api, workspacePath, reportError]);

  useEffect(() => { setDirectories({}); setExpanded(new Set([''])); setFilter(''); load(''); }, [workspacePath, load]);
  useEffect(() => {
    if (changeRevision) { load(''); [...expanded].filter(Boolean).forEach((path) => load(path)); }
  }, [changeRevision, load]);

  async function toggle(entry) {
    const next = new Set(expanded);
    if (next.has(entry.path)) next.delete(entry.path);
    else { next.add(entry.path); if (!directories[entry.path]) await load(entry.path); }
    setExpanded(next);
  }

  function renderDirectory(path, depth = 0) {
    const entries = (directories[path] || []).filter((entry) => !filter || entry.name.toLowerCase().includes(filter.toLowerCase()) || entry.isDirectory);
    return <ul className="file-tree-list" role={depth === 0 ? 'tree' : 'group'}>
      {entries.map((entry) => <li key={entry.path} role="treeitem" aria-expanded={entry.isDirectory ? expanded.has(entry.path) : undefined}>
        <button type="button" className={`file-tree-item ${entry.isDirectory ? 'directory' : ''}`} style={{ paddingLeft: 12 + depth * 14 }}
          title={entry.path} onClick={() => entry.isDirectory ? toggle(entry) : onFile(entry.path)}>
          {entry.isDirectory ? (expanded.has(entry.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="tree-spacer" />}
          {loading.has(entry.path) ? <LoaderCircle size={15} className="spin" /> : entry.isDirectory ? <Folder size={15} /> : <File size={15} />}
          <span>{entry.name}</span>
        </button>
        {entry.isDirectory && expanded.has(entry.path) && renderDirectory(entry.path, depth + 1)}
      </li>)}
      {loading.has(path) && <li className="tree-loading"><LoaderCircle size={14} className="spin" /><span>读取中</span></li>}
      {!loading.has(path) && entries.length === 0 && <li className="tree-empty">{filter ? '没有匹配文件' : '空文件夹'}</li>}
    </ul>;
  }

  if (!workspacePath) return <div className="section-empty">未打开文件夹</div>;
  return <div className="files-section"><div className="file-filter"><Search size={14} /><input aria-label="筛选已展开的文件" placeholder="筛选文件" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <IconButton icon={RefreshCw} label="刷新文件列表" onClick={() => load('')} /></div>{renderDirectory('')}</div>;
}

function PermissionDialog({ permission, onRespond, pending }) {
  const [selections, setSelections] = useState({});
  const [freeText, setFreeText] = useState({});
  const questions = permission.questions || permission.input?.questions || [];
  const isQuestion = permission.toolName === 'AskUserQuestion' && questions.length > 0;
  const headingRef = useRef(null);
  const modalRef = useModalFocus();
  useEffect(() => { headingRef.current?.focus(); setSelections({}); setFreeText({}); }, [permission.id]);

  function sendAnswers() {
    const answers = {};
    for (const question of questions) {
      answers[question.question] = freeText[question.question]?.trim() || (selections[question.question] || []).join(', ');
    }
    onRespond({ id: permission.id, decision: 'allow', answers });
  }
  const answerReady = questions.every((question) => freeText[question.question]?.trim() || selections[question.question]?.length);

  return <div className="modal-backdrop permission-backdrop"><section ref={modalRef} className="modal permission-modal" role="dialog" aria-modal="true" aria-labelledby="permission-heading">
    <header className="modal-header"><div className="permission-title"><ShieldCheck size={22} /><div><span className="eyebrow">等待确认</span><h2 id="permission-heading" ref={headingRef} tabIndex={-1}>{isQuestion ? 'Claude 有一个问题' : '允许这次操作？'}</h2></div></div></header>
    <div className="modal-body">
      {permission.reason && <p className="permission-reason">{permission.reason}</p>}
      {isQuestion ? <div className="question-list">{questions.map((question) => <fieldset key={question.question}>
        <legend>{question.question}</legend>
        {question.options?.map((option) => <label className="question-option" key={option.label}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={question.question} checked={(selections[question.question] || []).includes(option.label)} onChange={(event) => setSelections((previous) => {
            const values = question.multiSelect ? new Set(previous[question.question] || []) : new Set();
            if (event.target.checked) values.add(option.label); else values.delete(option.label);
            return { ...previous, [question.question]: [...values] };
          })} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}
        <label className="question-custom">其他回答<input value={freeText[question.question] || ''} onChange={(event) => setFreeText((previous) => ({ ...previous, [question.question]: event.target.value }))} /></label>
      </fieldset>)}</div> : <><div className="permission-tool"><Code2 size={16} /><strong>{permission.toolName}</strong></div>
        <pre className="permission-input">{typeof permission.input === 'string' ? permission.input : JSON.stringify(permission.input, null, 2)}</pre></>}
    </div>
    <footer className="modal-footer"><button className="button secondary" disabled={pending} onClick={() => onRespond({ id: permission.id, decision: 'deny' })}><X size={16} />{isQuestion ? '取消' : '拒绝'}</button>
      <button className="button primary" disabled={pending || (isQuestion && !answerReady)} onClick={isQuestion ? sendAnswers : () => onRespond({ id: permission.id, decision: 'allow' })}>
        {pending ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{isQuestion ? '提交回答' : '允许一次'}</button></footer>
  </section></div>;
}

function ThemePicker({ value, onChange, disabled }) {
  return <fieldset className="theme-picker"><legend className="visually-hidden">界面主题</legend>
    {[...new Set(THEME_OPTIONS.map(theme => theme.group))].map(group => <React.Fragment key={group}>
      <h4 className="theme-group-label">{group}</h4>
      {THEME_OPTIONS.filter(theme => theme.group === group).map((theme) => <label key={theme.value} className={`theme-option ${value === theme.value ? 'is-selected' : ''}`}>
      <input type="radio" name="appearance-theme" value={theme.value} data-theme-value={theme.value} aria-label={theme.name}
        checked={value === theme.value} disabled={disabled} onChange={() => onChange({ theme: theme.value })} />
      <span className="theme-sample" data-theme={theme.value} aria-hidden="true">
        <span className="theme-sample-header"><i /><i /><i /><b /></span>
        <span className="theme-sample-sidebar"><i /><i /><i /><i /></span>
        <span className="theme-sample-chat"><i /><b /><i /><b /><span><i /><b /></span></span>
        <span className="theme-sample-inspector"><i /><i /><i /><i /></span>
      </span>
      <span className="theme-option-meta"><strong>{theme.name}</strong><span className="theme-radio-indicator" aria-hidden="true">{value === theme.value && <Check size={12} strokeWidth={2.5} />}</span></span>
      <span className="theme-swatches" aria-hidden="true">{theme.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span>
      </label>)}
    </React.Fragment>)}
  </fieldset>;
}

function ProjectRules({ workspace, onCommand, disabled, usesResponses }) {
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    setPending(true); setLoaded(false); setError('');
    onCommand('memory', { action: 'read' }).then(result => { if (active) { setContent(result.content || ''); setSaved(result.content || ''); setLoaded(true); } }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [workspace?.path, readAttempt]);
  if (!workspace) return <p className="manager-note">请先打开工作文件夹。</p>;
  return <SettingsSection title={workspace.name || '当前项目'}>
    <p className="manager-note">{usesResponses ? '这些规则用于 Claude 对话；当前 GPT 渠道暂不读取项目规则。' : 'Claude 会在这个项目的对话中读取这些规则。'}</p>
    <label className="manager-field"><span>项目要求</span><textarea aria-label="项目要求" rows={12} value={content} disabled={disabled || pending || !loaded} onChange={event => { setContent(event.target.value); setMessage(''); }} /></label>
    <div className="manager-form-actions"><button type="button" className="button primary" disabled={disabled || pending || !loaded || saved === content} onClick={async () => {
      setPending(true); setError(''); setMessage('');
      try { const result = await onCommand('memory', { action: 'save', content }); setSaved(result.content || ''); setMessage('项目规则已保存。'); }
      catch (error) { setError(error.message); }
      finally { setPending(false); }
    }}>{pending ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存规则</button>{!loaded && error && <button type="button" className="button secondary" disabled={pending} onClick={() => setReadAttempt(value => value + 1)}><RefreshCw size={15} />重新读取</button>}</div>
    {message && <p className="manager-message" role="status">{message}</p>}{error && <p className="command-warning is-error" role="alert">{error}</p>}
  </SettingsSection>;
}

function ClaudePreferences({ connection, preferences, onCommand, disabled }) {
  const options = connection.claudeOptions || {};
  const selectedModel = preferences.model === 'default' ? connection.configuredModel : preferences.model;
  const modelBase = String(selectedModel || '').replace(/\[1m\]$/i, '').toLowerCase();
  const resolvedModel = modelBase.startsWith('claude-') ? modelBase : options.modelAliases?.[modelBase];
  const canonicalModel = /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(resolvedModel || '') ? resolvedModel.replace(/-\d{8}$/, '').toLowerCase() : '';
  const [scope, setScope] = useState(canonicalModel ? 'model' : 'all');
  const configuredWindow = scope === 'model' ? options.modelAutoCompactWindows?.[canonicalModel] ?? options.autoCompactWindow ?? 'auto' : options.autoCompactWindow ?? 'auto';
  const [window, setWindow] = useState(typeof configuredWindow === 'number' ? configuredWindow : 500000);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { setScope(canonicalModel ? 'model' : 'all'); }, [canonicalModel]);
  useEffect(() => { setWindow(typeof configuredWindow === 'number' ? configuredWindow : 500000); }, [configuredWindow, scope]);
  async function save(id, values) {
    setPending(true); setError(''); setMessage('');
    try { await onCommand(id, values); setMessage('Claude 设置已保存。'); }
    catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  function compactValues(value) { return { window: value, scope, ...(scope === 'model' ? { model: canonicalModel } : {}) }; }
  return <SettingsSection title="Claude 专用设置">
    <SettingsRow label="请求快速模式" description="需要支持的 Claude 模型和账户；是否加速由服务确认"><label className="command-switch manager-switch"><span className="visually-hidden">快速模式</span><input type="checkbox" role="switch" aria-label="快速模式" checked={Boolean(options.fastMode)} disabled={disabled || pending} onChange={event => save('fast', { enabled: event.target.checked })} /><i aria-hidden="true" /></label></SettingsRow>
    <SettingsRow label="压缩设置范围" description={scope === 'model' ? canonicalModel : '单个模型的独立设置优先于默认值'}><select aria-label="压缩设置范围" value={scope} disabled={disabled || pending} onChange={event => setScope(event.target.value)}><option value="model" disabled={!canonicalModel}>当前 Claude 模型</option><option value="all">所有 Claude 模型的默认值</option></select></SettingsRow>
    <SettingsRow label="自动压缩窗口" description={options.autoCompactEnvironmentOverride ? '当前由环境变量指定' : undefined}><select aria-label="自动压缩窗口" value={typeof configuredWindow === 'number' ? 'custom' : 'auto'} disabled={disabled || pending || options.autoCompactEnvironmentOverride} onChange={event => save('autocompact', compactValues(event.target.value === 'auto' ? 'auto' : window))}><option value="auto">自动</option><option value="custom">自定义</option></select></SettingsRow>
    {typeof configuredWindow === 'number' && <SettingsRow label="上下文 Token 数"><form className="inline-form" onSubmit={event => { event.preventDefault(); save('autocompact', compactValues(Number(window))); }}><input aria-label="上下文 Token 数" type="number" min={100000} max={1000000} step={10000} value={window} onChange={event => setWindow(event.target.valueAsNumber)} disabled={disabled || pending || options.autoCompactEnvironmentOverride} /><button type="submit" className="button secondary" disabled={disabled || pending || Number(window) === configuredWindow || !(Number.isInteger(Number(window)) && window >= 100000 && window <= 1000000)}>保存</button></form></SettingsRow>}
    {error && <p className="command-warning is-error" role="alert">{error}</p>}{message && <p className="manager-message" role="status">{message}</p>}
  </SettingsSection>;
}

function SettingsPage({ page, onSelectPage, workspace, connection, preferences, appearance, onPickAppearance, onResetAppearance, appearanceBusy, modelSourceId, onChange, onRefreshModels, disabled, themeDisabled, onClose, onOpenConfig, onChooseWorkspace, onCommand, onOpenOperation }) {
  return <WorkbenchSettings page={page} onSelectPage={onSelectPage} onClose={onClose} renderPage={(section, navigate) => {
    if (section.id === 'general') return <>
      <SettingsSection title="工作区">
        <SettingsRow icon={FolderOpen} label="工作文件夹" description={workspace?.path || '尚未选择'}><button type="button" className="button secondary" disabled={disabled} onClick={onChooseWorkspace}><FolderOpen size={15} />打开文件夹</button></SettingsRow>
        <SettingsRow icon={MessageSquare} label="历史对话"><button type="button" className="button secondary" disabled={disabled || !workspace} onClick={() => onOpenOperation('resume')}>管理</button></SettingsRow>
      </SettingsSection>
      <SettingsSection title="对话">
        <SettingsRow icon={ShieldCheck} label="模型与权限" description={preferences.model === 'default' ? connection.configuredModel || '跟随 CC Switch' : preferences.model}><button type="button" className="button secondary" onClick={() => navigate('model')}>更改</button></SettingsRow>
        <SettingsRow icon={FileCode2} label="项目规则"><button type="button" className="button secondary" onClick={() => navigate('memory')}>编辑</button></SettingsRow>
      </SettingsSection>
    </>;
    if (section.id === 'appearance') return <SettingsSection title="界面主题"><ThemePicker value={preferences.theme} onChange={onChange} disabled={themeDisabled} /></SettingsSection>;
    if (section.id === 'icons') return <SettingsSection title="自定义图标"><AppearanceSettings appearance={appearance} onPick={onPickAppearance} onReset={onResetAppearance} busy={appearanceBusy} /></SettingsSection>;
    if (section.id === 'model') return <><SettingsSection title="对话设置"><div className="settings-fields"><PreferenceFields preferences={preferences} connection={connection} modelSourceId={modelSourceId} onChange={onChange} onRefreshModels={onRefreshModels} disabled={disabled} /></div><p className="manager-note">权限模式与 Claude 原有工具规则共同生效；此页暂不编辑允许、询问和拒绝规则。</p></SettingsSection><ClaudePreferences connection={connection} preferences={preferences} onCommand={onCommand} disabled={disabled} /></>;
    if (section.id === 'memory') return <ProjectRules key={workspace?.path || 'none'} workspace={workspace} onCommand={onCommand} disabled={disabled} usesResponses={/^(?:gpt-|o\d|codex-)/i.test(preferences.model === 'default' ? connection.configuredModel || '' : preferences.model)} />;
    if (section.id === 'connection') return <>
      <SettingsSection title="当前渠道"><div className="settings-connection"><dl className="connection-details">
        <div><dt>渠道</dt><dd>{connection.providerName || '未读取'}</dd></div>
        <div><dt>模型</dt><dd>{preferences.model === 'default' ? connection.configuredModel || '跟随 Claude 默认模型' : preferences.model}</dd></div>
        <div><dt>接口地址</dt><dd>{connection.baseUrl || 'Anthropic 官方接口'}</dd></div>
        <div><dt>认证</dt><dd className={connection.hasCredential ? 'status-success' : 'status-warning'}>{connection.hasCredential ? '已配置凭据' : '未配置凭据'}</dd></div>
        <div><dt>Claude Code</dt><dd>{connection.claudeVersion || '未读取'}</dd></div>
      </dl></div></SettingsSection>
      <details className="settings-advanced"><summary>高级配置</summary><SettingsRow label="配置目录" description={connection.configDirectory}><button type="button" className="button secondary" onClick={onOpenConfig}><FolderOpen size={15} />打开</button></SettingsRow></details>
    </>;
    return <CommandManager key={section.commandId} id={section.commandId} workspace={workspace?.path} disabled={disabled} onAction={values => onCommand(section.commandId, values)} />;
  }} />;
}

function ChangesView({ changes, onSelect, selectedPath }) {
  if (!changes.length) return <div className="inspector-empty"><FileDiff size={28} /><span>当前对话尚无文件更改</span></div>;
  return <div className="changes-list">{changes.map((change) => <button className={`change-row ${selectedPath === change.path ? 'selected' : ''}`} key={change.path} onClick={() => onSelect(change)}>
    <FileDiff size={16} /><span title={change.path}>{change.path}</span><small>{['created', 'added'].includes(change.status || change.kind) ? '新增' : (change.status || change.kind) === 'deleted' ? '删除' : '修改'}</small>
  </button>)}</div>;
}

function DiffPreview({ change }) {
  return <div className="diff-preview"><div className="preview-heading"><FileDiff size={15} /><span title={change.path}>{change.path}</span></div>
    {change.before !== undefined && <section><h4>修改前</h4><pre className="diff-before">{change.before || '（空文件）'}</pre></section>}
    {change.after !== undefined && <section><h4>修改后</h4><pre className="diff-after">{change.after || '（空文件）'}</pre></section>}
    {change.before === undefined && change.after === undefined && <div className="section-empty">没有可用的内容快照</div>}
  </div>;
}

function ToolActivity({ tools }) {
  const [expanded, setExpanded] = useState(new Set());
  if (!tools.length) return <div className="inspector-empty"><ListChecks size={28} /><span>当前对话尚无操作记录</span></div>;
  return <div className="activity-list">{[...tools].reverse().map((tool) => <div className="activity-item" key={tool.id}>
    <button className="activity-heading" aria-expanded={expanded.has(tool.id)} onClick={() => setExpanded((previous) => {
      const next = new Set(previous); if (next.has(tool.id)) next.delete(tool.id); else next.add(tool.id); return next;
    })}>
      {tool.status === 'running' ? <LoaderCircle size={15} className="spin" /> : tool.status === 'error' ? <CircleAlert size={15} className="status-error" /> : <Check size={15} className="status-success" />}
      <strong>{tool.name}</strong><time>{formatTime(tool.createdAt)}</time><ChevronDown size={13} className={expanded.has(tool.id) ? 'rotated' : ''} />
    </button><p className="activity-summary">{getInputSummary(tool.input)}</p>
    {expanded.has(tool.id) && <div className="activity-detail"><pre>{JSON.stringify(tool.input, null, 2)}</pre>{tool.output && <pre>{typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}</pre>}</div>}
  </div>)}</div>;
}

export default function App() {
  const api = window.claudePanel;
  const [state, setState] = useState(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [localError, setLocalError] = useState('');
  const [dismissedError, setDismissedError] = useState('');
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [imageGeneration, setImageGeneration] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState('files');
  const [filePreview, setFilePreview] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [selectedChange, setSelectedChange] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState('general');
  const [settingsConnection, setSettingsConnection] = useState(null);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [commandsInitialId, setCommandsInitialId] = useState('clear');
  const [appearanceBusy, setAppearanceBusy] = useState('');
  const [permissionPending, setPermissionPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const pendingFileRef = useRef(0);
  const workspaceRef = useRef(null);
  const autoScrollRef = useRef(true);
  const preferences = { ...DEFAULT_PREFERENCES, ...state.preferences };
  const modelSourceId = preferences.modelSourceId;
  const running = Boolean(state.run);
  const messages = state.session?.messages || [];
  const tools = state.session?.tools || [];
  const changes = state.session?.changes || [];
  const usage = state.session?.usage || {};
  const workspaces = state.recentWorkspaces || state.workspaces || [];
  const visibleError = localError || (state.error !== dismissedError ? state.error : '');

  const reportError = useCallback((error) => { setLocalError(error?.message || String(error)); }, []);
  const applyState = useCallback((next) => {
    if (next && typeof next === 'object' && ('workspace' in next || 'workspaces' in next)) setState(next);
  }, []);

  useEffect(() => {
    const theme = THEME_OPTIONS.some((option) => option.value === preferences.theme) ? preferences.theme : 'tech-dark';
    const colorScheme = getTheme(theme).scheme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = colorScheme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', colorScheme);
  }, [preferences.theme]);

  useEffect(() => {
    if (!api) { setLocalError('桌面连接未就绪，请从 Claude 工作台启动入口打开。'); setReady(true); return undefined; }
    let mounted = true;
    const unsubscribe = api.onState((next) => { if (mounted) { applyState(next); setReady(true); } });
    api.getState().then((next) => { if (mounted) { applyState(next); setReady(true); } }).catch((error) => { if (mounted) { reportError(error); setReady(true); } });
    return () => { mounted = false; unsubscribe?.(); };
  }, [api, applyState, reportError]);

  useEffect(() => {
    if (workspaceRef.current !== state.workspace?.path) { setFilePreview(null); setSelectedChange(null); setDraft(''); setAttachments([]); workspaceRef.current = state.workspace?.path; }
  }, [state.workspace?.path]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && autoScrollRef.current) element.scrollTop = element.scrollHeight;
  }, [messages, tools, state.run, state.permission]);

  useEffect(() => {
    if (!state.run) { setElapsed(0); return undefined; }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - new Date(state.run.startedAt).getTime()) / 1000)));
    tick(); const interval = setInterval(tick, 1000); return () => clearInterval(interval);
  }, [state.run?.id, state.run?.startedAt]);

  useEffect(() => { setPermissionPending(false); }, [state.permission?.id]);

  async function action(name, callback) {
    if (!api) return;
    setBusy(name); setLocalError('');
    try { const result = await callback(); applyState(result); return result; }
    catch (error) { reportError(error); return undefined; }
    finally { setBusy(''); }
  }

  async function chooseWorkspace(path) {
    const result = await action('workspace', () => path ? api.selectWorkspace(path) : api.openWorkspace());
    if (result?.workspace) { setSidebarOpen(false); composerRef.current?.focus(); }
  }

  async function sendMessage(quickPrompt) {
    const text = (quickPrompt || draft).trim();
    if ((!text && !attachments.length) || running || busy || sendingRef.current || !state.workspace || !api) return;
    sendingRef.current = true;
    autoScrollRef.current = true;
    try {
      const result = await action('send', () => api.sendMessage({ text, ...preferences, sourceId: state.connection?.sourceId, attachments, imageGeneration: !quickPrompt && imageGeneration }));
      if (result) { setDraft(''); setAttachments([]); }
    } finally { sendingRef.current = false; }
  }

  function composerKeyDown(event) {
    if (event.key !== 'Enter' || composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const input = event.currentTarget;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const next = input.value.slice(0, start) + '\n' + input.value.slice(end);
      setDraft(next);
      requestAnimationFrame(() => { if (input.isConnected && input.value === next) input.setSelectionRange(start + 1, start + 1); });
    } else if (!event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) sendMessage();
    }
  }

  async function selectFile(path) {
    const requestId = ++pendingFileRef.current;
    setInspectorTab('files'); setInspectorOpen(true); setSelectedChange(null); setFileLoading(true);
    try { const result = await api.readFile(path); if (pendingFileRef.current === requestId) setFilePreview(result); }
    catch (error) { reportError(error); }
    finally { if (pendingFileRef.current === requestId) setFileLoading(false); }
  }

  function changePreferences(patch) {
    action('preferences', () => api.savePreferences({ ...patch, sourceId: state.connection?.sourceId }));
  }

  async function addAttachments() {
    const result = await action('attachments', () => api.chooseAttachments());
    if (Array.isArray(result)) mergeAttachments(result);
  }

  function mergeAttachments(items) {
    setAttachments((previous) => {
      const next = [...new Map([...previous, ...items].map(item => [item.path, item])).values()];
      const images = next.filter(item => item.mimeType?.startsWith('image/'));
      if (images.length > 4 || images.reduce((size, item) => size + (item.size || 0), 0) > 20 * 1024 * 1024) {
        setLocalError('每条消息最多添加 4 张图片，合计不超过 20 MB。');
        return previous;
      }
      return next;
    });
  }

  async function pasteImages(event) {
    const imageItems = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItems.length) return;
    event.preventDefault();
    if (busy || running || !state.workspace || !api) return;
    const files = imageItems.map(item => item.getAsFile()).filter(Boolean);
    if (files.some(file => file.size > 10 * 1024 * 1024) || imageItems.length + attachments.filter(item => item.mimeType?.startsWith('image/')).length > 4) { reportError(new Error('每条消息最多 4 张图片，单张不超过 10 MB。')); return; }
    const result = await action('paste', async () => {
      const added = [];
      if (!files.length) added.push(await api.pasteImage());
      for (const file of files) added.push(await api.pasteImage({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || '截图.png' }));
      return added;
    });
    if (Array.isArray(result)) mergeAttachments(result);
  }

  async function showSettings(requestedPage = 'general') {
    const page = typeof requestedPage === 'string' ? requestedPage : 'general';
    setCommandsOpen(false);
    setSettingsPage(SETTINGS_ROUTES[page] || page);
    setSettingsOpen(true);
    const result = await action('settings', () => api.openSettings());
    if (result) setSettingsConnection(result);
  }

  async function showCommands(requestedId = 'clear') {
    setSettingsOpen(false);
    setCommandsInitialId(typeof requestedId === 'string' ? requestedId : 'clear');
    setCommandsOpen(true);
    try { await api.getCommands(); } catch (error) { reportError(error); }
  }

  async function changeAppearance(slot, reset = false) {
    setAppearanceBusy(slot);
    try { applyState(await (reset ? api.resetAppearance(slot) : api.pickAppearance(slot))); }
    catch (error) { reportError(error); }
    finally { setAppearanceBusy(''); }
  }

  async function showAppearance() {
    await showSettings('icons');
  }

  async function executeCommand(command, values) {
    if (command.id === 'cd') { await chooseWorkspace(); return { close: true }; }
    if (command.id === 'focus') { setSidebarOpen(false); setInspectorOpen(false); setFocusMode(value => !value); return { close: true }; }
    if (command.id === 'help') return { type: 'text', content: `${state.commandCatalog?.commands?.length || 0} 个命令` };
    if (command.execution === 'sdk') {
      const model = preferences.model === 'default' ? state.connection?.configuredModel : preferences.model;
      if (/^(?:gpt-|o\d|codex-)/i.test(model || '')) throw new Error('这是 Claude Code 命令，请先选择支持 Claude 的渠道和模型。');
      const result = await api.sendMessage({ text: `${command.command}${values.arguments?.trim() ? ` ${values.arguments.trim()}` : ''}`, ...preferences, sourceId: state.connection?.sourceId });
      applyState(result); return { close: true };
    }
    const result = await api.executeCommand({ id: command.id, values });
    if (command.id === 'plan' && values.task?.trim()) {
      applyState(await api.sendMessage({ text: values.task.trim(), ...preferences, permissionMode: 'plan', sourceId: state.connection?.sourceId }));
      return { close: true };
    }
    return result;
  }

  async function respondPermission(response) {
    setPermissionPending(true);
    try { applyState(await api.respondPermission(response)); }
    catch (error) { reportError(error); }
    finally { setPermissionPending(false); }
  }

  function chooseChange(change) { setSelectedChange(change); setInspectorTab('changes'); setInspectorOpen(true); }

  return <div className="app-shell">
    <header className="app-header">
      <div className="app-brand">{!settingsOpen && <IconButton icon={Menu} label="展开侧栏" className="mobile-sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)} />}
        <button className="brand-mark" title="更换应用图标" aria-label="更换应用图标" onClick={showAppearance}><img src={state.appearance?.appIcon?.src || appIcon} alt="Claude 工作台图标" /></button><h1>Claude <span>工作台</span></h1></div>
      <div className="header-workspace" title={state.workspace?.path || ''}><Folder size={15} /><span>{state.workspace?.path || '未选择工作文件夹'}</span></div>
      <div className="header-actions">{!settingsOpen && <><button className="button secondary open-folder-button" aria-label="打开文件夹" title="打开文件夹" disabled={!api || Boolean(busy) || running} onClick={() => chooseWorkspace()}>
        {busy === 'workspace' ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}<span>打开文件夹</span></button>
        <IconButton icon={PanelRight} label="文件与操作记录" className={inspectorOpen ? 'active' : ''} onClick={() => setInspectorOpen((value) => !value)} /></>}
        <IconButton icon={Terminal} label="命令中心" className={commandsOpen ? 'active' : ''} disabled={!api} onClick={showCommands} />
        <IconButton icon={Settings2} label="连接与设置" className={settingsOpen ? 'active' : ''} disabled={!api} onClick={showSettings} /></div>
    </header>

    <div className={`workspace-layout ${inspectorOpen ? 'inspector-visible' : ''} ${settingsOpen ? 'is-hidden' : ''} ${focusMode ? 'focus-mode' : ''}`}>
      {sidebarOpen && <button className="drawer-scrim sidebar-scrim" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="工作区与对话">
        <div className="sidebar-section workspace-section"><div className="section-heading"><span>工作区</span><IconButton icon={Plus} label="打开另一个文件夹" disabled={!api || running || Boolean(busy)} onClick={() => chooseWorkspace()} /></div>
          {workspaces.length ? <div className="workspace-list">{workspaces.map((workspace) => <button key={workspace.path} className={`workspace-item ${state.workspace?.path === workspace.path ? 'selected' : ''}`}
            disabled={running || Boolean(busy)} onClick={() => chooseWorkspace(workspace.path)} title={workspace.path}>
            <Folder size={16} /><span>{workspace.name}</span>{state.workspace?.path === workspace.path && <span className="selection-dot" />}</button>)}</div> : <div className="section-empty">尚无工作区</div>}
        </div>
        <div className="sidebar-section conversations-section"><div className="section-heading"><span>对话</span><IconButton icon={Plus} label="新建对话" disabled={!state.workspace || running || Boolean(busy)} onClick={() => action('new', () => api.newSession())} /></div>
          {state.sessions?.length ? <div className="session-list">{state.sessions.map((session) => <div className={`session-row ${state.session?.id === session.id ? 'selected' : ''}`} key={session.id}><button className={`session-item ${state.session?.id === session.id ? 'selected' : ''}`}
            disabled={running || Boolean(busy)} onClick={async () => { await action('session', () => api.selectSession(session.id)); setSidebarOpen(false); }} title={session.title}>
            <MessageSquare size={15} /><span>{session.title || '新对话'}</span></button><IconButton icon={Trash2} label={`删除对话 ${session.title || '新对话'}`} className="delete-session" disabled={running || Boolean(busy)} onClick={() => { if (window.confirm(`删除对话“${session.title || '新对话'}”？`)) action('delete-session', () => api.deleteSession(session.id)); }} /></div>)}</div> : <div className="section-empty">尚无对话</div>}
        </div>
        <div className="sidebar-section file-browser-section"><div className="section-heading"><span>工作文件</span><IconButton icon={FolderOpen} label="在资源管理器中打开" disabled={!state.workspace} onClick={() => action('reveal', () => api.openInExplorer())} /></div>
          <FileTree workspacePath={state.workspace?.path} api={api} onFile={selectFile} reportError={reportError} changeRevision={changes.map((change) => `${change.path}:${change.status || change.kind}`).join('|')} />
        </div>
        <footer className="sidebar-footer"><span className={`connection-dot ${state.connection?.hasCredential ? 'connected' : ''}`} />
          <span title={state.connection?.baseUrl || ''}>{state.connection?.hasCredential ? '已读取连接配置' : '未检测到 API 凭据'}</span>
          <IconButton icon={Settings2} label="查看连接" disabled={!api} onClick={showSettings} />
        </footer>
      </aside>

      <main className="chat-workspace" style={state.session?.color ? { '--session-accent': state.session.color } : undefined}>
        <div className="workspace-toolbar"><div className="session-heading"><MessageSquare size={17} /><h2>{state.session?.title || '新对话'}</h2></div>
        </div>

        {visibleError && <div className="error-banner" role="alert"><CircleAlert size={17} /><span>{visibleError}</span><IconButton icon={X} label="关闭错误提示" onClick={() => { setLocalError(''); setDismissedError(state.error); Promise.resolve(api?.clearError?.()).catch(reportError); }} /></div>}

        <div className="conversation-scroll" ref={scrollRef} onScroll={() => { const element = scrollRef.current; autoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
          {!ready ? <div className="chat-empty"><LoaderCircle size={30} className="spin" /><h2>正在连接工作台</h2></div> : !messages.length ? <div className="chat-empty">
            <div className="empty-workspace-mark"><FolderOpen size={40} strokeWidth={1.35} /></div>
            <h2>{state.workspace ? state.workspace.name : '打开工作文件夹'}</h2>
            {state.workspace ? <><span className="empty-subtitle">新对话</span><div className="quick-tasks">{QUICK_TASKS.map((task) => <button key={task.title} disabled={!api || running || Boolean(busy)} onClick={() => sendMessage(task.prompt)}><task.icon size={19} /><span>{task.title}</span><ChevronRight size={15} /></button>)}</div></>
              : <button className="button primary" disabled={!api || Boolean(busy)} onClick={() => chooseWorkspace()}><FolderOpen size={17} />打开文件夹</button>}
          </div> : <div className="message-list">{messages.map((message) => <article className={`message message-${message.role}`} key={message.id}>
            <header className="message-heading"><button type="button" className={`message-avatar ${message.role === 'assistant' ? 'assistant' : ''}`} title={message.role === 'assistant' ? '更换 Claude 头像' : '更换我的头像'} aria-label={message.role === 'assistant' ? '更换 Claude 头像' : '更换我的头像'} onClick={showAppearance}>{message.role === 'assistant' ? <img src={state.appearance?.claudeAvatar?.src || claudeAvatar} alt="Claude 头像" /> : message.role === 'user' ? <img src={state.appearance?.userAvatar?.src || userAvatar} alt="我的头像" /> : <CircleAlert size={15} />}</button>
              <strong>{message.role === 'assistant' ? 'Claude' : message.role === 'user' ? '你' : '工作台'}</strong><time>{formatTime(message.createdAt)}</time>
              {message.text && <IconButton icon={Copy} label="复制消息" onClick={() => api.copyText(message.text).then(() => setLocalError('')).catch(reportError)} />}</header>
            <div className="message-body"><ChatMarkdown text={message.text || (message.role === 'assistant' && state.run?.assistantMessageId !== message.id ? (message.error ? `本次请求失败：${message.error}` : '该次请求未返回内容。') : '')} />{message.attachments?.length > 0 && <div className="message-attachments">{message.attachments.map((item) => item.mimeType?.startsWith('image/') ? <ChatAttachment key={item.path} attachment={item} /> : <span key={item.path} title={item.path}><Paperclip size={12} />{item.name}</span>)}</div>}</div>
          </article>)}
          {running && <div className="run-status" role="status"><LoaderCircle size={15} className="spin" /><span>{state.run.status === 'waiting' ? '等待你的确认' : state.run.status === 'stopping' ? '正在停止' : 'Claude 正在处理'}</span><time>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</time>
            {tools.length > 0 && <button onClick={() => { setInspectorTab('activity'); setInspectorOpen(true); }}><ListChecks size={14} />{tools.length} 项操作</button>}</div>}
          </div>}
        </div>

        <div className="composer-area">
          {!autoScrollRef.current && running && <IconButton icon={ArrowDown} label="滚动到最新消息" className="scroll-to-bottom" onClick={() => { autoScrollRef.current = true; scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }} />}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
            {attachments.length > 0 && <div className="attachment-list">{attachments.map((item) => <span className={`attachment-chip ${item.previewSrc ? 'has-image' : ''}`} key={item.path} title={item.path}>{item.previewSrc ? <img src={item.previewSrc} alt={item.name} /> : <File size={14} />}<span>{item.name}</span><IconButton icon={X} label={`移除 ${item.name}`} onClick={() => setAttachments((previous) => previous.filter((attachment) => attachment.path !== item.path))} /></span>)}</div>}
            <textarea ref={composerRef} value={draft} onChange={(event) => { if (event.target.value === '/') { showCommands(); return; } setDraft(event.target.value); }} aria-label="输入任务" placeholder={state.workspace ? imageGeneration ? '描述要生成的图片…' : '输入任务…' : '先打开一个工作文件夹'} disabled={!state.workspace || !api}
              onPaste={pasteImages} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={composerKeyDown} />
            <div className="composer-bottom"><div className="composer-tools"><IconButton icon={Terminal} label="打开命令菜单" disabled={!api} onClick={showCommands} /><IconButton icon={Paperclip} label="添加文件" disabled={!state.workspace || running || Boolean(busy)} onClick={addAttachments} /><IconButton icon={ImagePlus} label="AI 生图" aria-pressed={imageGeneration} className={imageGeneration ? 'image-mode-active' : ''} disabled={!state.workspace || running || Boolean(busy)} onClick={() => { setImageGeneration(value => !value); composerRef.current?.focus(); }} />
              <ModelField preferences={preferences} connection={state.connection || {}} modelSourceId={modelSourceId} onChange={changePreferences}
                onRefresh={api?.refreshModels ? () => action('models', () => api.refreshModels()) : undefined} compact disabled={!api || running || Boolean(busy)} /></div>
              {running ? <button className="button stop-button" type="button" disabled={state.run.status === 'stopping'} onClick={() => action('stop', () => api.stopRun())}><Square size={13} fill="currentColor" />停止</button>
                : <button className="send-button" type="submit" title="发送任务" aria-label="发送任务" disabled={(!draft.trim() && !attachments.length) || !state.workspace || !api || Boolean(busy)}>{busy === 'send' ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} />}</button>}
            </div>
          </form>
          <div className="conversation-footer"><button className="permission-status" title="操作权限设置" aria-label="操作权限设置" disabled={!api} onClick={() => showSettings('model')}><ShieldCheck size={12} />{PERMISSION_OPTIONS.find(([value]) => value === preferences.permissionMode)?.[1] || preferences.permissionMode}</button>
            {(usage.inputTokens || usage.outputTokens) ? <span title="输入 / 输出 token">{formatNumber(usage.inputTokens)} / {formatNumber(usage.outputTokens)} tokens</span> : <span>{state.connection?.claudeVersion ? `Claude Code ${state.connection.claudeVersion}` : ''}</span>}
            {typeof usage.costUsd === 'number' && usage.costUsd > 0 && <span title="CLI 报告的估算费用；实际计费以供应商为准">估算 ${usage.costUsd.toFixed(4)}</span>}
          </div>
        </div>
      </main>

      {inspectorOpen && <button className="drawer-scrim inspector-scrim" aria-label="收起文件与操作记录" onClick={() => setInspectorOpen(false)} />}
      <aside className={`inspector ${inspectorOpen ? 'is-open' : ''}`} aria-label="文件与操作记录">
        <div className="inspector-tabs" role="tablist">{[['files', '文件', FileCode2], ['changes', '更改', FileDiff], ['activity', '操作', ListChecks]].map(([value, label, Icon]) => <button key={value} role="tab" aria-selected={inspectorTab === value} className={inspectorTab === value ? 'selected' : ''} onClick={() => setInspectorTab(value)}><Icon size={14} />{label}{value === 'changes' && changes.length > 0 && <span>{changes.length}</span>}</button>)}
          <IconButton icon={X} label="收起面板" className="close-inspector" onClick={() => setInspectorOpen(false)} /></div>
        <div className="inspector-content">
          {inspectorTab === 'files' && (fileLoading ? <div className="inspector-empty"><LoaderCircle size={25} className="spin" /><span>正在读取文件</span></div> : filePreview ? <><div className="preview-heading"><FileCode2 size={15} /><span title={filePreview.path}>{filePreview.path}</span><IconButton icon={FolderOpen} label="在资源管理器中显示文件" onClick={() => action('reveal-file', () => api.openInExplorer(filePreview.path))} /></div>
            {filePreview.truncated && <div className="preview-warning">文件较大，仅显示部分内容</div>}<pre className="file-preview">{filePreview.content || '（空文件）'}</pre></> : <div className="inspector-empty"><FileCode2 size={28} /><span>尚未选择文件</span></div>)}
          {inspectorTab === 'changes' && <><ChangesView changes={changes} onSelect={chooseChange} selectedPath={selectedChange?.path} />{selectedChange && <DiffPreview change={selectedChange} />}</>}
          {inspectorTab === 'activity' && <ToolActivity tools={tools} />}
        </div>
      </aside>
    </div>
    {settingsOpen && <SettingsPage page={settingsPage} onSelectPage={setSettingsPage} workspace={state.workspace} connection={{ ...settingsConnection, ...state.connection }} preferences={preferences} modelSourceId={modelSourceId} onChange={changePreferences}
      appearance={state.appearance} onPickAppearance={slot => changeAppearance(slot)} onResetAppearance={slot => changeAppearance(slot, true)} appearanceBusy={appearanceBusy}
      onRefreshModels={api?.refreshModels ? () => action('models', () => api.refreshModels()) : undefined} disabled={running || Boolean(busy)} themeDisabled={!api || busy === 'preferences'} onClose={() => setSettingsOpen(false)} onOpenConfig={() => action('config-directory', () => api.openConfigDirectory())}
      onChooseWorkspace={() => chooseWorkspace()} onCommand={(id, values) => api.executeCommand({ id, values })} onOpenOperation={showCommands} />}
    {state.permission && <PermissionDialog permission={state.permission} onRespond={respondPermission} pending={permissionPending} />}
    {commandsOpen && !state.permission && <CommandMenu initialId={commandsInitialId} catalog={state.commandCatalog || {}} state={state} onClose={() => setCommandsOpen(false)} onExecute={executeCommand} onOpenSettings={showSettings}
      onInspectChanges={() => { setInspectorOpen(true); setInspectorTab('changes'); }} onInspectActivity={() => { setInspectorOpen(true); setInspectorTab('activity'); }} busy={Boolean(busy)} />}
  </div>;
}
