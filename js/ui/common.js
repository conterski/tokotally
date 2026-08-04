/**
 * Shared UI pieces: the undo toast, popup menus, and the two modal
 * dialogs (confirm / name-a-log).
 *
 * The toast exists for the same reason it does on the desktop: the
 * destructive shortcuts (Esc, Delete) stay one keystroke fast because
 * they stay reversible for a few seconds, rather than being gated behind
 * a confirmation every time.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Build an element: tag, attributes/props, and children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c) node.append(c);
  }
  return node;
}

/** An <svg><use> reference to one of the sprite symbols in index.html. */
export function icon(id, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

// =====================================================================
// toast
// =====================================================================
const toastEl = $('#toast');
const toastMsg = $('#toastMsg');
const toastUndo = $('#toastUndo');
let toastTimer = null;
let undoAction = null;

toastUndo.addEventListener('click', () => {
  const fn = undoAction;
  dismissToast();
  if (fn) fn();
});

export function showToast(message, undo = null) {
  toastMsg.textContent = message;
  undoAction = undo;
  toastUndo.classList.toggle('hidden', !undo);
  toastEl.classList.add('toast--shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, 5000);
}

export function dismissToast() {
  clearTimeout(toastTimer);
  undoAction = null;
  toastEl.classList.remove('toast--shown');
}

// =====================================================================
// popup menu
// =====================================================================
let openMenuEl = null;
let onMenuClose = null;

/**
 * Open a menu anchored under `anchor`.
 *
 * `items` is a list of {label, onSelect, current, danger, disabled} or
 * {separator: true}. One menu element exists at a time — a long ledger
 * would otherwise keep hundreds of live menus around, which is why the
 * desktop version shares a single Menu instance too.
 */
export function openMenu(anchor, items, { onClose } = {}) {
  closeMenu();
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.separator) {
      menu.append(el('div', { class: 'menu__sep' }));
      continue;
    }
    const classes = ['menu__item'];
    if (item.current) classes.push('menu__item--current');
    if (item.danger) classes.push('menu__item--danger');
    menu.append(
      el('button', {
        class: classes.join(' '),
        type: 'button',
        role: 'menuitem',
        text: item.label,
        disabled: item.disabled || false,
        onclick: () => {
          closeMenu();
          item.onSelect?.();
        },
      })
    );
  }
  document.body.append(menu);

  // Position under the anchor, then pull back inside the viewport. On a
  // phone the menu can be wider than the space to the right of a button,
  // so the clamp matters more than the alignment.
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const pad = 8;
  let left = a.left;
  let top = a.bottom + 4;
  if (left + m.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - pad - m.width);
  }
  if (top + m.height > window.innerHeight - pad) {
    // Flip above the anchor when there is no room below.
    top = Math.max(pad, a.top - m.height - 4);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  openMenuEl = menu;
  onMenuClose = onClose || null;
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutsidePointer, true);
  }, 0);
}

function onOutsidePointer(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
}

export function closeMenu() {
  if (!openMenuEl) return;
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  openMenuEl.remove();
  openMenuEl = null;
  const cb = onMenuClose;
  onMenuClose = null;
  cb?.();
}

export function isMenuOpen() {
  return openMenuEl !== null;
}

// =====================================================================
// confirm dialog
// =====================================================================
const confirmDlg = $('#confirmDialog');
const confirmTitle = $('#confirmTitle');
const confirmBody = $('#confirmBody');
const confirmOk = $('#confirmOk');
const confirmCancel = $('#confirmCancel');
let confirmResolve = null;

confirmCancel.addEventListener('click', () => settleConfirm(false));
confirmOk.addEventListener('click', () => settleConfirm(true));
// Esc (or any native cancel) counts as declining.
confirmDlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  settleConfirm(false);
});

function settleConfirm(value) {
  if (!confirmDlg.open) return;
  confirmDlg.close();
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(value);
}

/** Ask for confirmation; resolves true only on the affirmative button. */
export function confirmAction({ title, body, okLabel }) {
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmOk.textContent = okLabel;
  confirmDlg.showModal();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

// =====================================================================
// name-a-log dialog
// =====================================================================
const nameDlg = $('#nameDialog');
const nameForm = nameDlg.querySelector('form');
const nameTitle = $('#nameTitle');
const nameField = $('#nameField');
const nameCancel = $('#nameCancel');
let nameResolve = null;

nameCancel.addEventListener('click', () => settleName(null));
nameDlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  settleName(null);
});
nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = nameField.value.trim();
  if (!value) return; // a blank name is simply not a submit
  settleName(value);
});

function settleName(value) {
  if (!nameDlg.open) return;
  nameDlg.close();
  const resolve = nameResolve;
  nameResolve = null;
  resolve?.(value);
}

/** Prompt for a log name; resolves the trimmed name, or null if cancelled. */
export function promptName({ title, value = '' }) {
  nameTitle.textContent = title;
  nameField.value = value;
  nameDlg.showModal();
  // Select the existing name so a rename can be overtyped straight away.
  nameField.focus();
  nameField.select();
  return new Promise((resolve) => {
    nameResolve = resolve;
  });
}

/** True while any modal dialog is on screen. */
export function anyDialogOpen() {
  return $$('dialog').some((d) => d.open);
}
