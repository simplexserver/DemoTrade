/**
 * ui/core.js — Shared UI helpers for SimpleXEngine [BOT].
 *
 * DOM utilities, store-bound form controls, toast/notification system,
 * delegated event handling, and status dot helpers.
 * Browser-only: never called from worker or Node contexts.
 */

import { createStore } from '../core/store.js';
import { bus } from '../core/bus.js';
import { escapeHtml, uid } from '../core/util.js';
import { EVENTS } from '../config.js';

// ─── Re-export lazy store singleton ───────────────────────────────────────────
// The store is created once by app.js; we expose a getter here for modules
// that import core.js without going through app.js.
let _store = null;
export function setStore(s) { _store = s; }
export function getStore() { return _store; }

// ─── DOM shortcuts ────────────────────────────────────────────────────────────
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const esc = escapeHtml;

// ─── Attribute builder ────────────────────────────────────────────────────────
export const attr = (name, value) =>
  (value === undefined || value === null || value === '') ? '' : ` ${name}="${esc(String(value))}"`;

const display = (v) =>
  (v === null || v === undefined || typeof v === 'object') ? '' : String(v);

// ─── HTML form builders ───────────────────────────────────────────────────────

/** Toggle switch bound to a boolean store path. */
export function switchHtml({ path, label, sub = '', checked, disabled = false }) {
  const on = checked !== undefined ? Boolean(checked) : Boolean(_store?.get(path));
  return `<label class="switch${disabled ? ' is-disabled' : ''}">
    <input type="checkbox" data-path="${esc(path)}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}>
    <span class="track"><span class="thumb"></span></span>
    <span class="switch-label">${esc(label)}${sub ? `<span class="hint">${esc(sub)}</span>` : ''}</span>
  </label>`;
}

/** Number input bound to a store path. */
export function numberField({ path, label, value, min, max, step = 'any', unit = '', hint = '', nullable = false, placeholder = '' }) {
  const id = uid('num');
  const current = value !== undefined ? value : _store?.get(path);
  return `<div class="field">
    <label class="field-label" for="${id}">${esc(label)}</label>
    <div class="row">
      <input id="${id}" class="input" type="number" inputmode="decimal" data-path="${esc(path)}"${nullable ? ' data-nullable' : ''}
        value="${esc(display(current))}" step="${esc(step)}"${attr('min', min)}${attr('max', max)}${attr('placeholder', placeholder)}>
      ${unit ? `<span class="muted small">${esc(unit)}</span>` : ''}
    </div>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;
}

/** Text input bound to a store path. */
export function textField({ path, label, value, placeholder = '', type = 'text', hint = '' }) {
  const id = uid('txt');
  const current = value !== undefined ? value : _store?.get(path);
  return `<div class="field">
    <label class="field-label" for="${id}">${esc(label)}</label>
    <input id="${id}" class="input" type="${esc(type)}" data-path="${esc(path)}"
      value="${esc(display(current))}"${attr('placeholder', placeholder)} autocomplete="off" spellcheck="false">
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;
}

/** Select/dropdown bound to a store path. options: Array<{value, label}> */
export function selectField({ path, label, options = [], value, hint = '' }) {
  const id = uid('sel');
  const current = display(value !== undefined ? value : _store?.get(path));
  const opts = options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return `<option value="${esc(String(v))}"${current === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');
  return `<div class="field">
    <label class="field-label" for="${id}">${esc(label)}</label>
    <select id="${id}" class="input" data-path="${esc(path)}">${opts}</select>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;
}

/** Settings row: label + control side by side. */
export function settingsRow({ label, hint = '', control, dangerous = false }) {
  return `<div class="settings-row${dangerous ? ' dangerous' : ''}">
    <div class="settings-row-text">
      <div class="settings-label">${esc(label)}</div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    </div>
    <div class="settings-control">${control}</div>
  </div>`;
}

// ─── Store binding ────────────────────────────────────────────────────────────

/**
 * Wire all [data-path] inputs inside `root` to the store.
 * On change: coerces the value and writes it. On store update: syncs the UI.
 * Returns an unsubscribe function.
 */
export function bindDataPaths(root = document) {
  if (!_store) return () => {};

  function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') {
      const n = parseFloat(el.value);
      if ('nullable' in el.dataset && el.value === '') return null;
      return isNaN(n) ? el.value : n;
    }
    return el.value;
  }

  function writeInput(el, val) {
    if (el.type === 'checkbox') { el.checked = Boolean(val); return; }
    if (document.activeElement === el) return; // don't clobber while typing
    el.value = val === null || val === undefined ? '' : String(val);
  }

  const handler = (e) => {
    const el = e.target;
    const path = el.dataset?.path;
    if (!path) return;
    _store.set(path, readInput(el));
  };
  root.addEventListener('change', handler);

  // Sync when store writes (e.g. from learning module or remote)
  const unsub = bus.on(EVENTS.SETTINGS_CHANGED, ({ path, value }) => {
    for (const el of $$(` [data-path="${CSS.escape(path)}"]`, root)) {
      writeInput(el, value);
    }
  });

  return () => { root.removeEventListener('change', handler); unsub?.(); };
}

// ─── Toast notifications ──────────────────────────────────────────────────────

let _toastArea = null;

function getToastArea() {
  if (_toastArea) return _toastArea;
  _toastArea = document.getElementById('toast-area');
  if (!_toastArea) {
    _toastArea = document.createElement('div');
    _toastArea.id = 'toast-area';
    document.body.appendChild(_toastArea);
  }
  return _toastArea;
}

/**
 * Show a toast notification.
 * @param {string} msg
 * @param {'info'|'success'|'warn'|'error'} type
 * @param {number} ms — auto-dismiss timeout (0 = sticky)
 */
export function toast(msg, type = 'info', ms = 4000) {
  const area = getToastArea();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => dismiss(el));
  el.appendChild(close);

  area.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));

  if (ms > 0) setTimeout(() => dismiss(el), ms);
  return el;
}

function dismiss(el) {
  el.classList.remove('toast-visible');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 600); // fallback
}

// ─── Status dot helpers ───────────────────────────────────────────────────────

/**
 * Update a [data-status] element.
 * @param {string} selector – CSS selector or element
 * @param {'ok'|'warn'|'error'|'idle'|'loading'} status
 * @param {string} [label]
 */
export function setStatus(selector, status, label) {
  const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!el) return;
  el.dataset.status = status;
  if (label !== undefined) el.textContent = label;
}

// ─── Delegated action dispatcher ─────────────────────────────────────────────

/**
 * Wire [data-action] buttons. Handler map: { actionName: fn(el, e) }
 * Returns unsubscribe.
 */
export function bindActions(root = document, handlers = {}) {
  const handler = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const fn = handlers[action];
    if (fn) { e.preventDefault(); fn(btn, e); }
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}

// ─── Number formatting ────────────────────────────────────────────────────────

/** Format a USD amount: always 2 decimal places, with sign. */
export function fmtMoney(val) {
  if (val === null || val === undefined || !isFinite(val)) return '—';
  const n = Number(val);
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Format a plain USD amount without sign. */
export function fmtBalance(val) {
  if (val === null || val === undefined || !isFinite(val)) return '—';
  return `$${Number(val).toFixed(2)}`;
}

/** Format a percentage. */
export function fmtPct(val, decimals = 1) {
  if (val === null || val === undefined || !isFinite(val)) return '—';
  return `${Number(val * 100).toFixed(decimals)}%`;
}

/** Clamp + flash a numeric DOM element. */
export function flashNum(el, val, fmt = fmtMoney) {
  if (!el) return;
  el.textContent = fmt(val);
  el.classList.remove('num-flash');
  void el.offsetWidth; // reflow
  el.classList.add('num-flash');
}

// ─── Bus-wired UI events ──────────────────────────────────────────────────────

/**
 * Subscribe to common bus events and update the UI.
 * Returns an unsubscribe function.
 */
export function wireBusToUI() {
  const unsubs = [
    bus.on(EVENTS.TRADE, ({ netUsd, side, asset }) => {
      const isWin = netUsd >= 0;
      toast(`${side?.toUpperCase() ?? '?'} ${asset ?? ''} → ${fmtMoney(netUsd)}`, isWin ? 'success' : 'warn', 3000);
    }),
    bus.on('broker:mode', ({ mode }) => {
      const badge = document.getElementById('conn-badge');
      if (badge) {
        badge.dataset.mode = mode;
        badge.textContent = mode.toUpperCase();
      }
      setStatus('#conn-badge', mode === 'paper' ? 'idle' : 'ok', mode.toUpperCase());
    }),
    bus.on('broker:emergency', ({ on, reason }) => {
      if (on) toast(`⚠ Emergency stop: ${reason}`, 'error', 0);
    }),
    bus.on('conn:status', ({ socket, status, message }) => {
      const dot = document.getElementById('ws-status');
      if (dot) {
        dot.className = `conn-dot conn-${status}`;
        dot.title = message || '';
      }
    }),
  ];
  return () => unsubs.forEach(fn => fn?.());
}
