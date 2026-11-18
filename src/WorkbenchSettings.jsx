import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Bot, Braces, Cable, CircleUserRound, FileText, Globe, Keyboard,
  LoaderCircle, Monitor, Palette, Plug, Search, Settings2,
  ShieldCheck, Sparkles, Terminal, Workflow,
} from 'lucide-react';
import './workbench-settings.css';

export const SETTINGS_PAGES = [
  { id: 'general', label: '常规', group: '日常', icon: Settings2, keywords: 'general 常用 对话 历史' },
  { id: 'appearance', label: '外观', group: '日常', icon: Palette, keywords: 'theme 主题 暗色 配色' },
  { id: 'icons', label: '图标与头像', group: '日常', icon: CircleUserRound, keywords: 'avatar 头像 图标' },
  { id: 'model', label: '模型与权限', group: '日常', icon: ShieldCheck, commandId: 'model', keywords: 'model effort permissions plan 模型 思考强度 自动编辑' },
  { id: 'output-style', label: '回答风格', group: '日常', icon: FileText, commandId: 'output-style', keywords: 'output-style response 回答 风格 简洁 解释' },
  { id: 'chrome', label: '浏览器', group: '连接与扩展', icon: Globe, commandId: 'chrome', keywords: 'chrome browser 浏览器 扩展 网页' },
  { id: 'mcp', label: '工具连接', group: '连接与扩展', icon: Cable, commandId: 'mcp', keywords: 'mcp 工具 服务器 连接' },
  { id: 'plugin', label: '插件', group: '连接与扩展', icon: Plug, commandId: 'plugin', keywords: 'plugin plugins 插件 市场 安装' },
  { id: 'ide', label: '编辑器', group: '连接与扩展', icon: Monitor, commandId: 'ide', keywords: 'ide vscode vs code 编辑器 扩展' },
  { id: 'memory', label: '项目规则', group: '编码', icon: Braces, commandId: 'memory', keywords: 'memory claude.md 记忆 项目规则' },
  { id: 'skills', label: '技能', group: '编码', icon: Sparkles, commandId: 'skills', keywords: 'skills 技能 指令' },
  { id: 'agents', label: '代理', group: '编码', icon: Bot, commandId: 'agents', keywords: 'agents subagents 子代理 助手' },
  { id: 'hooks', label: '自动化', group: '编码', icon: Workflow, commandId: 'hooks', keywords: 'hooks hook 钩子 自动化 触发' },
  { id: 'keybindings', label: '快捷键', group: '高级', icon: Keyboard, commandId: 'keybindings', keywords: 'keybindings keyboard 快捷键 按键 终端' },
  { id: 'statusline', label: '终端状态栏', group: '高级', icon: Terminal, commandId: 'statusline', keywords: 'statusline terminal 终端 状态栏' },
  { id: 'connection', label: '连接状态', group: '高级', icon: Cable, keywords: 'status connection ccswitch cc switch 渠道 接口 版本 配置目录' },
];

export function SettingsSection({ title, children, className = '' }) {
  return <section className={`workbench-settings-section ${className}`}>
    {title && <h2>{title}</h2>}
    <div className="workbench-settings-section-content">{children}</div>
  </section>;
}

export function SettingsRow({ icon: Icon, label, description, children, className = '' }) {
  return <div className={`workbench-settings-row ${className}`}>
    {Icon && <Icon className="workbench-settings-row-icon" size={20} aria-hidden="true" />}
    <div className="workbench-settings-row-copy"><span>{label}</span>{description && <p>{description}</p>}</div>
    {children && <div className="workbench-settings-row-control">{children}</div>}
  </div>;
}

export default function WorkbenchSettings({ initialPage = 'general', page, onSelectPage, onClose, renderPage, pages = SETTINGS_PAGES }) {
  const [internalPage, setInternalPage] = useState(initialPage);
  const [search, setSearch] = useState('');
  const headingRef = useRef(null);
  const paneRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const selectedId = page ?? internalPage;
  const selected = pages.find(item => item.id === selectedId) || pages[0];
  const filtered = useMemo(() => {
    const query = search.trim().replace(/^\//, '').toLocaleLowerCase();
    return pages.filter(item => !query || `${item.label} ${item.keywords || ''} ${item.commandId || ''}`.toLocaleLowerCase().includes(query));
  }, [pages, search]);
  const groups = [...new Set(filtered.map(item => item.group))];
  const mobilePages = selected && !filtered.some(item => item.id === selected.id) ? [selected, ...filtered] : filtered;

  function navigate(id) {
    if (!pages.some(item => item.id === id)) return;
    setInternalPage(id);
    onSelectPage?.(id);
  }

  useEffect(() => { setInternalPage(initialPage); }, [initialPage]);
  useEffect(() => {
    const previous = document.activeElement;
    headingRef.current?.focus();
    function keyboard(event) {
      if (event.defaultPrevented || document.querySelector('[role="dialog"]') || event.target.closest?.('.model-picker-popup')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current?.(); }
    }
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (paneRef.current) paneRef.current.scrollTop = 0; }, [selected?.id]);

  const content = selected && renderPage?.(selected, navigate);
  return <main className="workbench-settings" aria-label="设置">
    <aside className="workbench-settings-sidebar" aria-label="设置导航">
      <header className="workbench-settings-sidebar-heading">
        <button type="button" className="icon-button" title="返回工作区" aria-label="返回工作区" onClick={onClose}><ArrowLeft size={19} /></button>
        <h2>设置</h2>
      </header>
      <label className="workbench-settings-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="搜索设置" placeholder="搜索设置" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); navigate(filtered[0].id); } }} /></label>
      <div className="workbench-settings-mobile-select"><label htmlFor="workbench-settings-page">设置分类</label><select id="workbench-settings-page" value={selected?.id || ''} onChange={event => navigate(event.target.value)}>{mobilePages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>{!filtered.length && <span role="status">没有匹配项</span>}</div>
      <nav className="workbench-settings-navigation" aria-label="设置分类">
        {groups.map(group => <section key={group}><h3>{group}</h3><div>{filtered.filter(item => item.group === group).map(item => {
          const Icon = item.icon || Settings2;
          return <button key={item.id} type="button" data-settings-page={item.id} aria-current={selected?.id === item.id ? 'page' : undefined} className={selected?.id === item.id ? 'selected' : ''} onClick={() => navigate(item.id)}><Icon size={17} aria-hidden="true" /><span>{item.label}</span></button>;
        })}</div></section>)}
        {!filtered.length && <p className="workbench-settings-no-results" role="status">没有匹配的设置</p>}
      </nav>
    </aside>
    <div className="workbench-settings-pane" ref={paneRef}>
      <div className="workbench-settings-content">
        <header className="workbench-settings-page-heading"><h1 id="workbench-settings-title" ref={headingRef} tabIndex={-1}>{selected?.label || '设置'}</h1>{selected?.description && <p>{selected.description}</p>}</header>
        <div className="workbench-settings-body" key={selected?.id}>{content ?? <div className="workbench-settings-loading" role="status"><LoaderCircle size={17} className="spin" /><span>正在读取设置</span></div>}</div>
      </div>
    </div>
  </main>;
}
