import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Download, FolderOpen, Image, LoaderCircle, Paperclip, X } from 'lucide-react';
import { chatUrlTransform, classifyChatHref, remarkWindowsFileLinks } from '../shared/chat-links.mjs';
import './chat-markdown.css';

function ToolButton({ icon: Icon, label, ...props }) {
  return <button type="button" className="icon-button" title={label} aria-label={label} {...props}><Icon size={17} aria-hidden="true" /></button>;
}

function CopyableCode({ children }) {
  const contentRef = useRef(null);
  const timer = useRef(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(contentRef.current?.textContent || '');
      setCopied(true); setError('');
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch { setError('复制失败，请重试。'); }
  }
  return <div className="code-block"><ToolButton icon={copied ? Check : Copy} label={copied ? '已复制' : '复制代码'} onClick={copy} /><pre ref={contentRef}>{children}</pre>{error && <span role="alert" className="chat-asset-error">{error}</span>}</div>;
}

function LocalImage({ href, alt, api, onPreview, onError }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    Promise.resolve().then(() => api.getChatAsset({ href })).then((asset) => {
      if (active) setState(asset.dataUrl ? { asset } : { error: '这个文件不是图片。' });
    }).catch((error) => { if (active) setState({ error: error.message || '图片读取失败。' }); });
    return () => { active = false; };
  }, [api, href]);
  if (state.asset) return <button type="button" className="chat-image-button" title="查看原图" aria-label={`查看原图：${alt || state.asset.name}`} onClick={() => onPreview({ ...state.asset, href })}><img src={state.asset.dataUrl} alt={alt || state.asset.name} onError={() => setState({ error: '图片无法预览，仍可下载原图。' })} /></button>;
  return <span className="chat-image-fallback">{state.loading ? <LoaderCircle size={15} className="spin" /> : <Image size={15} />}<span>{state.loading ? (alt || '图片加载中') : state.error}</span>{!state.loading && <button type="button" className="chat-inline-link" onClick={() => Promise.resolve().then(() => api.saveChatAsset({ href })).catch(onError)}>下载原图</button>}</span>;
}

function AssetPreview({ asset, api, onClose }) {
  const dialogRef = useRef(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog.querySelector('button')?.focus();
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.querySelectorAll('button:not(:disabled)')];
      const first = buttons[0]; const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [onClose]);
  async function action(method) {
    setBusy(true); setError('');
    try { await api[method]({ href: asset.href }); }
    catch (error) { setError(error.message || '文件操作失败。'); }
    finally { setBusy(false); }
  }
  return createPortal(<div className="modal-backdrop chat-asset-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal chat-asset-preview" role="dialog" aria-modal="true" aria-label={asset.name} ref={dialogRef}>
    <header className="modal-header"><h2>{asset.name}</h2><div className="chat-asset-tools"><ToolButton icon={Download} label="下载原图" disabled={busy} onClick={() => action('saveChatAsset')} /><ToolButton icon={FolderOpen} label="打开所在文件夹" disabled={busy} onClick={() => action('openChatAsset')} /><ToolButton icon={X} label="关闭预览" onClick={onClose} /></div></header>
    <div className="chat-asset-image-stage"><img src={asset.dataUrl} alt={asset.name} onError={() => setError('图片无法预览，仍可下载原图或打开所在文件夹。')} /></div>
    {error && <p role="alert" className="chat-asset-error">{error}</p>}
  </section></div>, document.body);
}

export function ChatAttachment({ attachment, api = window.claudePanel }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const href = attachment.path;
  async function open() {
    setError(''); setBusy(true);
    try {
      const asset = await api.getChatAsset({ href });
      if (asset.kind === 'image' && asset.dataUrl) setPreview({ ...asset, href });
      else await api.openChatAsset({ href });
    } catch (error) { setError(error.message || '附件打开失败。'); }
    finally { setBusy(false); }
  }
  return <span className="chat-attachment">{attachment.previewSrc ? <button type="button" className="chat-image-button chat-attachment-image" title={attachment.name} aria-label={`查看原图：${attachment.name}`} aria-busy={busy} disabled={busy} onClick={open}><img src={attachment.previewSrc} alt={attachment.name} /></button> : attachment.mimeType?.startsWith('image/') ? <LocalImage href={href} alt={attachment.name} api={api} onPreview={setPreview} onError={(error) => setError(error.message || '文件操作失败。')} /> : <button type="button" className="chat-file-attachment" title={href} disabled={busy} onClick={open}><Paperclip size={13} /><span>{attachment.name}</span></button>}{error && <span role="alert" className="chat-asset-error">{error}</span>}{preview && <AssetPreview asset={preview} api={api} onClose={() => setPreview(null)} />}</span>;
}

export default function ChatMarkdown({ text, api = window.claudePanel }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [loadingHref, setLoadingHref] = useState('');
  async function openLocal(href) {
    setError(''); setLoadingHref(href);
    try {
      const asset = await api.getChatAsset({ href });
      if (asset.kind === 'image' && asset.dataUrl) setPreview({ ...asset, href });
      else await api.openChatAsset({ href });
    } catch (error) { setError(error.message || '文件打开失败。'); }
    finally { setLoadingHref(''); }
  }
  async function downloadLocal(href) {
    setError(''); setLoadingHref(href);
    try { await api.saveChatAsset({ href }); }
    catch (error) { setError(error.message || '文件下载失败。'); }
    finally { setLoadingHref(''); }
  }
  function linkText(children) {
    return React.Children.toArray(children).map(child => typeof child === 'string' ? child : React.isValidElement(child) ? linkText(child.props.children) : '').join('');
  }
  const onError = (error) => setError(error.message || '文件操作失败。');
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkWindowsFileLinks]} urlTransform={chatUrlTransform} components={{
    pre: ({ children }) => <CopyableCode>{children}</CopyableCode>,
    a: ({ children, href }) => {
      const kind = classifyChatHref(href);
      if (kind === 'local') return <a href={href} aria-busy={loadingHref === href} onClick={(event) => { event.preventDefault(); const label = linkText(children); if (/下载|download/i.test(label) && !/打开|查看|open|view/i.test(label)) downloadLocal(href); else openLocal(href); }}>{children}</a>;
      if (kind === 'blocked') return <span>{children}</span>;
      return <a href={href} target={kind === 'external' ? '_blank' : undefined} rel={kind === 'external' ? 'noreferrer' : undefined}>{children}</a>;
    },
    img: ({ src, alt }) => classifyChatHref(src) === 'local' ? <LocalImage href={src} alt={alt} api={api} onPreview={setPreview} onError={onError} /> : <a href={classifyChatHref(src) === 'external' ? src : undefined} target="_blank" rel="noreferrer">{alt || '查看图片'}</a>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{text || ''}</ReactMarkdown>{error && <p role="alert" className="chat-asset-error">{error}</p>}{preview && <AssetPreview asset={preview} api={api} onClose={() => setPreview(null)} />}</div>;
}
