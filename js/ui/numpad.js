/**
 * In-app number pad for touch devices.
 *
 * The line-item fields set inputmode="none" on a phone, so iOS never
 * raises its own keyboard; this pad takes its place. It is docked below
 * the Grand Total so the running figure stays visible while typing, and
 * it hides the tab bar while open, exactly as a system keyboard would.
 *
 * Keys write into the target input through the same path a keystroke
 * takes — validate, set, dispatch `input` — so the store, the line
 * totals and the field validators all behave identically whether the
 * digits came from here or a real keyboard. Enter dispatches a genuine
 * Enter keydown, so the whole Enter flow (advance, append a row,
 * complete the sale) is reused rather than reimplemented.
 *
 * The pad follows focus automatically, and a button above Complete Sale
 * dismisses or restores it by hand.
 */

import { el, icon } from './common.js';

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
  { label: '0', area: 'k0', ch: '0' },
  { label: '.', area: 'dot', ch: '.' },
];

/**
 * The navigation strip above the keys: ◀ on the left, ▲ over ▼ in the
 * middle, ▶ on the right. Up and down reuse the arrow-key handlers as
 * they are; left and right park the caret at the matching edge first,
 * because those handlers only cross fields from the edge of the text —
 * fine while typing, but a dedicated button should always move.
 */
const NAV = [
  { dir: 'left', rotate: -90, aria: 'Previous field' },
  { dir: 'up', rotate: 0, aria: 'Row above' },
  { dir: 'down', rotate: 180, aria: 'Row below' },
  { dir: 'right', rotate: 90, aria: 'Next field' },
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

const FIELD_SELECTOR = '.item-row .input';

export class Numpad {
  constructor({ container, app, toggle, enabled, onLayoutChange }) {
    this.container = container;
    this.app = app;
    this.toggleButton = toggle;
    this.enabled = enabled;
    // Open/closed as it was when the toggle was pressed, so a focus
    // change between press and click cannot invert the action.
    this.pressedWhileOpen = null;
    this.onLayoutChange = onLayoutChange || (() => {});
    // The input the keys write into. Kept separately from document focus
    // so the pad still works if a browser declines a programmatic focus.
    this.field = null;
    // Where to return when the pad is switched back on by hand.
    this.lastField = null;
    this.keys = new Map();
  }

  init() {
    if (!this.enabled) return;
    this.build();
    // The attribute's presence marks the pad as available (and reveals
    // the toggle); its value is the open/closed state.
    this.app.dataset.numpad = 'off';

    if (this.toggleButton) {
      // Deliberately NOT preventing the default on pointerdown here.
      // Safari on iOS can swallow the follow-up click when a pointer
      // default is cancelled, which left the button dead on the device.
      // Nothing needs cancelling any more: the focus rule below ignores
      // buttons, so tapping this one cannot disturb the pad.
      //
      // The state is captured on press rather than read on click, so
      // even if something does move focus in between, the tap still does
      // what the icon showed when the user pressed it.
      this.toggleButton.addEventListener('pointerdown', () => {
        this.pressedWhileOpen = this.isOpen;
      });
      this.toggleButton.addEventListener('click', () => {
        const wasOpen = this.pressedWhileOpen ?? this.isOpen;
        this.pressedWhileOpen = null;
        this.toggle(wasOpen);
      });
    }

    // Follow focus into the line items, and step aside for a field that
    // genuinely needs the system keyboard (the sale date, the settings
    // inputs). Everything else — buttons, the pad's own keys, the body —
    // is ignored on purpose: tapping a button must never dismiss the
    // pad, which is what made the toggle close and instantly reopen.
    document.addEventListener('focusin', (e) => {
      const target = e.target;
      const field = target.closest?.(FIELD_SELECTOR);
      if (field) {
        this.attach(field);
      } else if (target.matches?.('input, textarea')) {
        this.detach();
      }
    });

    this.renderToggle();
  }

  get isOpen() {
    return this.app.dataset.numpad === 'open';
  }

  build() {
    this.container.replaceChildren(this.buildNav(), this.buildKeys());
  }

  /** ◀ | ▲ over ▼ | ▶, spanning the pad's full width in one short strip. */
  buildNav() {
    const nav = el('div', { class: 'numpad__nav' });
    const make = (spec) => {
      const button = el(
        'button',
        {
          class: `np-nav np-nav--${spec.dir}`,
          type: 'button',
          tabindex: '-1',
          'aria-label': spec.aria,
        },
        icon('i-tri', 'icon--nav')
      );
      button.querySelector('svg').style.transform = `rotate(${spec.rotate}deg)`;
      button.addEventListener('pointerdown', (e) => e.preventDefault());
      button.addEventListener('click', () => this.navigate(spec.dir));
      return button;
    };
    const [left, up, down, right] = NAV.map(make);
    // Up and down share the middle cell, stacked, as in a d-pad.
    nav.append(left, el('div', { class: 'np-nav-stack' }, [up, down]), right);
    return nav;
  }

  buildKeys() {
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
    return pad;
  }

  /** Move focus with the nav strip, reusing the arrow-key handlers. */
  navigate(direction) {
    const field = this.field;
    if (!field) return;
    if (direction === 'up' || direction === 'down') {
      this.sendKey(field, direction === 'up' ? 'ArrowUp' : 'ArrowDown');
      return;
    }
    // Park the caret on the edge the handler looks for, so the button
    // moves whether or not the user was mid-number.
    const at = direction === 'left' ? 0 : field.value.length;
    field.setSelectionRange(at, at);
    this.sendKey(field, direction === 'left' ? 'ArrowLeft' : 'ArrowRight');
  }

  sendKey(field, key, extra = {}) {
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      })
    );
  }

  /**
   * Point the pad at a field and show it.
   *
   * Called both from the focusin listener and directly by the sale pane
   * whenever it moves focus itself — so completing a sale, which
   * refocuses the first Qty, brings the pad straight back even if the
   * browser ignores the programmatic focus.
   */
  attach(field) {
    if (!this.enabled || !field) return;
    this.field = field;
    this.lastField = field;

    const context = CONTEXT_KEY[field.dataset.area] ?? null;
    const button = this.keys.get('ctx');
    button.textContent = context ? context.label : '';
    button.disabled = !context;
    this.context = context;

    // The list just got shorter; setOpen keeps the focused row in view.
    this.setOpen(true);
  }

  detach() {
    this.field = null;
    this.setOpen(false);
  }

  /**
   * The triangle beside the Grand Total.
   *
   * Hiding also blurs the field, so tapping that same input again
   * re-fires focusin and brings the pad right back — otherwise a field
   * that still held focus could never reopen it.
   *
   * @param wasOpen state at press time; falls back to the current state.
   */
  toggle(wasOpen = this.isOpen) {
    if (!this.enabled) return;
    if (wasOpen) {
      this.field?.blur();
      this.detach();
      return;
    }
    const target =
      this.lastField && this.lastField.isConnected
        ? this.lastField
        : document.querySelector(FIELD_SELECTOR);
    // Show the pad even with no field to return to; the next tap on a
    // row will bind it.
    this.setOpen(true);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.select?.();
    // focus() normally fires focusin, which attaches; attach anyway so
    // the pad still binds where that focus is refused.
    this.attach(target);
  }

  /** Flip the shell's state attribute and repaint the toggle. */
  setOpen(open) {
    const next = open ? 'open' : 'off';
    if (this.app.dataset.numpad === next) return;
    this.app.dataset.numpad = next;
    this.renderToggle();
    this.onLayoutChange();
  }

  /** The triangle points up to raise the pad, down to dismiss it. */
  renderToggle() {
    if (!this.toggleButton) return;
    const open = this.isOpen;
    this.toggleButton.setAttribute('aria-pressed', String(open));
    this.toggleButton.setAttribute(
      'aria-label',
      open ? 'Hide number pad' : 'Show number pad'
    );
    this.toggleButton.classList.toggle('numpad-toggle--open', open);
  }

  press(key) {
    const field = this.field;
    if (!field) return;
    if (key.action === 'enter') {
      this.sendKey(field, 'Enter');
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
    if (field.value.length === 0) {
      // Nothing left to rub out: step back a field instead of doing
      // nothing. Shift+Enter already encodes "one step backwards" for
      // whichever entry flow is set, so reuse it rather than restate it.
      this.sendKey(field, 'Enter', { shiftKey: true });
      return;
    }
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
