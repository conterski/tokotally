/**
 * In-app number pad for touch devices.
 *
 * The line-item fields set inputmode="none" on a phone, so iOS never
 * raises its own keyboard; this pad takes its place. It is docked below
 * the Grand Total so the running figure stays visible while typing, and
 * it hides the tab bar while open, exactly as a system keyboard would.
 *
 * Keys write into the focused input through the same path a keystroke
 * takes — validate, set, dispatch `input` — so the store, the line
 * totals and the field validators all behave identically whether the
 * digits came from here or a real keyboard. Enter dispatches a genuine
 * Enter keydown, so the whole Enter flow (advance, append a row,
 * complete the sale) is reused rather than reimplemented.
 */

import { el } from './common.js';

// 4x4: digits in the classic phone arrangement, utilities down the right.
const LAYOUT = [
  { label: '7', area: 'k7', ch: '7' },
  { label: '8', area: 'k8', ch: '8' },
  { label: '9', area: 'k9', ch: '9' },
  { label: '⌫', area: 'bs', action: 'backspace', util: true, aria: 'Backspace' },
  { label: '4', area: 'k4', ch: '4' },
  { label: '5', area: 'k5', ch: '5' },
  { label: '6', area: 'k6', ch: '6' },
  { label: '', area: 'ctx', action: 'context', util: true, aria: 'Extra symbol' },
  { label: '1', area: 'k1', ch: '1' },
  { label: '2', area: 'k2', ch: '2' },
  { label: '3', area: 'k3', ch: '3' },
  { label: '↵', area: 'ent', action: 'enter', enter: true, aria: 'Enter' },
  { label: '.', area: 'dot', ch: '.' },
  { label: '0', area: 'k0', ch: '0' },
];

/**
 * The one non-digit character each field accepts, offered on the
 * context key. Qty gets the leading minus so returns and refunds can
 * still be entered on a phone; Discount gets '+' so chains like 10+5
 * are typeable. Price takes digits only, so the key is disabled.
 */
const CONTEXT_KEY = {
  qty: { label: '−', ch: '-' },
  disc: { label: '+', ch: '+' },
  price: null,
};

export class Numpad {
  constructor({ container, app, enabled, onLayoutChange }) {
    this.container = container;
    this.app = app;
    this.enabled = enabled;
    this.onLayoutChange = onLayoutChange || (() => {});
    this.field = null;
    this.keys = new Map();
  }

  init() {
    if (!this.enabled) return;
    this.build();

    // Follow focus: show for a line-item field, hide for anything else
    // (the sale-date field and the settings inputs keep the real
    // keyboard, since they take text this pad cannot produce).
    document.addEventListener('focusin', (e) => {
      const field = e.target.closest?.('.item-row .input');
      if (field) this.attach(field);
      else this.detach();
    });
  }

  build() {
    const pad = el('div', { class: 'numpad__keys' });
    for (const key of LAYOUT) {
      const classes = ['np-key'];
      if (key.util) classes.push('np-key--util');
      if (key.enter) classes.push('np-key--enter');
      const button = el('button', {
        class: classes.join(' '),
        type: 'button',
        tabindex: '-1',
        style: `grid-area: ${key.area}`,
        text: key.label,
        'aria-label': key.aria || key.label,
      });
      // Keep focus in the input: without this the button would take it
      // on press and the caret (and the whole Enter flow) would be lost.
      button.addEventListener('pointerdown', (e) => e.preventDefault());
      button.addEventListener('click', () => this.press(key));
      this.keys.set(key.area, button);
      pad.append(button);
    }
    this.container.replaceChildren(pad);
  }

  attach(field) {
    this.field = field;
    const context = CONTEXT_KEY[field.dataset.area] ?? null;
    const button = this.keys.get('ctx');
    button.textContent = context ? context.label : '';
    button.disabled = !context;
    this.context = context;

    if (this.app.dataset.numpad !== 'open') {
      this.app.dataset.numpad = 'open';
      // The list just got shorter; keep the focused row in view.
      this.onLayoutChange();
    }
  }

  detach() {
    this.field = null;
    if (this.app.dataset.numpad === 'open') {
      delete this.app.dataset.numpad;
      this.onLayoutChange();
    }
  }

  press(key) {
    const field = this.field;
    if (!field) return;
    if (key.action === 'enter') {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      return;
    }
    if (key.action === 'backspace') {
      this.backspace();
      return;
    }
    if (key.action === 'context') {
      if (this.context) this.insert(this.context.ch);
      return;
    }
    this.insert(key.ch);
  }

  /** Insert at the caret, replacing any selection. */
  insert(ch) {
    const field = this.field;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const next = field.value.slice(0, start) + ch + field.value.slice(end);
    // Reject exactly what a keystroke would: the field's own pattern is
    // the single source of truth for what it accepts.
    if (field._pattern && !field._pattern.test(next)) return;
    this.commit(next, start + ch.length);
  }

  backspace() {
    const field = this.field;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    let next;
    let caret;
    if (start !== end) {
      next = field.value.slice(0, start) + field.value.slice(end);
      caret = start;
    } else if (start > 0) {
      next = field.value.slice(0, start - 1) + field.value.slice(start);
      caret = start - 1;
    } else {
      return;
    }
    this.commit(next, caret);
  }

  /** Write the new text and let the field's normal input path run. */
  commit(text, caret) {
    const field = this.field;
    field.value = text;
    field.dataset.prev = text;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
