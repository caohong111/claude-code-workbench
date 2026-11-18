import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import './model-picker.css';

export default function ModelPicker({ id, value, onChange, groups = [], disabled, title, label = '模型' }) {
  const generatedId = useId();
  const fieldId = id || `model-picker-${generatedId}`;
  const listId = `${fieldId}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeValue, setActiveValue] = useState(null);
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const searchRef = useRef(null);
  const optionRefs = useRef(new Map());
  const selected = groups.flatMap(group => group.options || []).find(option => option.value === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return groups.map(group => ({ ...group, options: (group.options || []).filter(option => !needle
      || `${group.label || ''} ${option.label || ''} ${option.value || ''}`.toLocaleLowerCase().includes(needle)) })).filter(group => group.options.length);
  }, [groups, query]);
  const options = useMemo(() => filtered.flatMap(group => group.options), [filtered]);
  const enabled = useMemo(() => options.filter(option => !option.disabled), [options]);
  const optionId = optionValue => `${listId}-option-${encodeURIComponent(String(optionValue))}`;
  const activeId = options.some(option => option.value === activeValue) ? optionId(activeValue) : undefined;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const margin = 8;
    const gap = 6;
    const width = Math.min(Math.max(rect.width, 300), Math.max(0, viewportWidth - margin * 2));
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
    const above = Math.max(0, rect.top - margin - gap);
    const below = Math.max(0, viewportHeight - rect.bottom - margin - gap);
    const naturalHeight = (popup.firstElementChild?.getBoundingClientRect().height || 43)
      + (popup.querySelector('.model-picker-list')?.scrollHeight || 0) + 2;
    const desiredHeight = Math.min(420, naturalHeight);
    const upward = below < desiredHeight && above > below;
    const maxHeight = Math.min(420, upward ? above : below);
    const height = Math.min(desiredHeight, maxHeight);
    const top = upward ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap;
    const next = { width, left, top, maxHeight };
    setPosition(previous => previous && Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
  }, []);

  function show(initialQuery = '') {
    if (disabled) return;
    setQuery(initialQuery);
    const available = groups.flatMap(group => group.options || []).filter(option => !option.disabled);
    setActiveValue(available.find(option => option.value === value)?.value ?? available[0]?.value ?? null);
    setOpen(true);
  }

  function choose(option) {
    if (!option || option.disabled || disabled) return;
    close(true);
    onChange?.(option.value);
  }

  function navigate(event) {
    if (event.nativeEvent?.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (event.key === 'Enter') { event.preventDefault(); choose(enabled.find(option => option.value === activeValue)); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!enabled.length) return;
    const index = enabled.findIndex(option => option.value === activeValue);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % enabled.length : (index <= 0 ? enabled.length : index) - 1;
    setActiveValue(enabled[next].value);
  }

  useLayoutEffect(() => { if (open) reposition(); }, [open, filtered, reposition, position?.width, position?.maxHeight]);
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    let frame;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reposition); };
    const outside = event => {
      if (!popupRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(triggerRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [open, close, reposition]);
  useEffect(() => { if (disabled && open) close(); }, [disabled, open, close]);
  useEffect(() => {
    if (open && !enabled.some(option => option.value === activeValue)) setActiveValue(enabled[0]?.value ?? null);
  }, [enabled, activeValue, open]);
  useEffect(() => {
    if (open) optionRefs.current.get(activeValue)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeValue, query]);

  return <>
    <button id={fieldId} ref={triggerRef} type="button" role="combobox" aria-label={label} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} title={title}
      aria-activedescendant={open ? activeId : undefined}
      className={`model-picker-trigger ${open ? 'is-open' : ''}`} onClick={() => open ? close() : show()}
      onKeyDown={event => {
        if (open) { navigate(event); return; }
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(); }
        else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); show(event.key); }
      }}>
      <span>{selected?.label || value || '选择模型'}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={popupRef} className="model-picker-popup" style={position || { visibility: 'hidden' }} onKeyDown={navigate}>
      <div className="model-picker-search"><Search size={15} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label="筛选模型"
          aria-controls={listId} aria-activedescendant={activeId} placeholder="筛选模型" autoComplete="off" spellCheck={false} />
      </div>
      <div id={listId} className="model-picker-list" role="listbox" aria-label={label}>
        {filtered.map((group, groupIndex) => <div className="model-picker-group" role="group" aria-label={group.label || undefined} key={`${group.label || ''}-${groupIndex}`}>
          {group.label && <div className="model-picker-group-label">{group.label}</div>}
          {group.options.map(option => <button id={optionId(option.value)} key={option.value} type="button" role="option" aria-selected={option.value === value}
            aria-disabled={Boolean(option.disabled)} disabled={Boolean(option.disabled)} tabIndex={-1}
            data-model-id={option.value} data-active={activeValue === option.value} className="model-picker-option"
            ref={element => { if (element) optionRefs.current.set(option.value, element); else optionRefs.current.delete(option.value); }}
            onMouseEnter={() => { if (!option.disabled) setActiveValue(option.value); }} onClick={() => choose(option)}>
            <span className="model-picker-check">{option.value === value && <Check size={15} aria-hidden="true" />}</span>
            <span>{option.label || option.value}</span>
          </button>)}
        </div>)}
        {!options.length && <div className="model-picker-empty" role="status">没有匹配模型</div>}
      </div>
    </div>, document.body)}
  </>;
}
