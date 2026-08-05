/**
 * The sale pane — the web port of qml/SalePane.qml + qml/LineItemRow.qml.
 *
 * Keeps the desktop app's keyboard-first entry: Enter walks Qty -> Price
 * -> next line (creating one as it goes), Enter on the last line's empty
 * Price completes the sale, Shift+Enter walks back, and the arrow keys
 * move around the grid. On a phone the same rows reflow to two lines and
 * the remove control is always visible, because there is no hover.
 */

import { PRICE_MULTIPLIER, parseField } from '../core.js';
import { el, icon } from './common.js';
import { tweenNumber } from './tween.js';

// Column indices, matching the desktop's requestFocusAt contract.
const COL = { QTY: 0, PRICE: 1, DISC: 2 };

// Ported from EditField.qml's validators. QML anchors a
// RegularExpressionValidator implicitly; here the anchors are explicit.
const RE = {
  // Discount: digits, separators and '+' (the chain).
  chain: /^[0-9.,+\s]*$/,
  // Qty: an optional leading '-' (returns/refunds) plus the optional
  // "3*80" / "3x80" shorthand for a whole line in one field.
  combined: /^-?[0-9]*[.,]?[0-9]*\s*[*xX]?\s*[0-9]*[.,]?[0-9]*$/,
  // Price: digits with one optional decimal separator.
  plain: /^[0-9]*[.,]?[0-9]*$/,
};

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export class SalePane {
  constructor({
    sale,
    settings,
    refs,
    onOpenSettings,
    onToast,
    useNumpad,
    onFieldFocused,
  }) {
    this.sale = sale;
    this.settings = settings;
    this.refs = refs;
    this.onOpenSettings = onOpenSettings;
    this.onToast = onToast;
    // On touch the in-app number pad replaces the system keyboard.
    this.useNumpad = Boolean(useNumpad);
    // Told whenever this pane moves focus itself, so the number pad can
    // follow without depending on the browser honouring a programmatic
    // focus (iOS is choosy about those outside a user gesture).
    this.onFieldFocused = onFieldFocused || (() => {});

    // Which rows have had their Qty committed. Keyed by the item object
    // itself, so the flag survives a re-render and disappears with the
    // row — the same lifetime the QML delegate's property had.
    this.confirmed = new WeakSet();

    this.totalTween = tweenNumber((v) => {
      this.refs.grandTotal.textContent = this.settings.money(v);
      this.refs.tabSaleTotal.textContent = this.settings.money(v);
    });
  }

  init() {
    const { sale, refs } = this;

    refs.settingsBtn.addEventListener('click', () => this.onOpenSettings());
    refs.clearBtn.addEventListener('click', () => this.clearEntryWithUndo());
    refs.completeBtn.addEventListener('click', () => sale.completeSale());

    refs.dateField.addEventListener('input', () => {
      sale.setSaleDate(refs.dateField.value);
      this.renderDateValidity();
    });

    // A newly appended row is scrolled into view by the focus that
    // immediately follows it (see advance), not from here. Issuing a
    // second smooth scroll would re-aim from a mid-flight position and
    // land short, leaving the row clipped.
    sale.on('structure', () => this.renderRows());
    sale.on('values', () => this.renderTotals());
    sale.on('editing', () => this.renderChrome());
    sale.on('saleDate', () => this.renderSaleDate());

    sale.on('completed', () => {
      this.focusCell(0, COL.QTY);
      this.refs.itemsScroll.scrollTop = 0;
    });
    sale.on('editSaved', (seqNo) => {
      this.onToast(`Sale No. ${seqNo} updated`);
      this.focusCell(0, COL.QTY);
      this.refs.itemsScroll.scrollTop = 0;
    });
    sale.on('invalidDate', () => {
      // Completion was blocked by an unparseable date: send the user to
      // the field rather than fail silently.
      refs.dateField.focus();
      refs.dateField.select();
    });

    // Re-evaluated each minute so the shown date survives midnight.
    setInterval(() => this.renderChrome(), 60000);

    this.renderRows();
    this.renderChrome();
    this.renderSaleDate();
  }

  /** Esc / the bottom-left button: cancel an edit, or clear with undo. */
  clearEntryWithUndo() {
    const { sale } = this;
    if (sale.editing) {
      sale.cancelEdit();
    } else if (sale.clearEntry()) {
      this.onToast('Entry cleared', () => sale.restoreEntry());
    }
    this.focusCell(0, COL.QTY);
  }

  // ----- rendering ----------------------------------------------------

  /** Title, subtitle and the two action-button labels. */
  renderChrome() {
    const { sale, refs } = this;
    refs.saleTitle.textContent = sale.editing ? 'Editing sale' : 'TokoTally';
    refs.saleSubtitle.textContent = sale.editing
      ? `No. ${sale.editSeqNo} — saving overwrites it`
      : dateFmt.format(new Date());
    refs.saleSubtitle.classList.toggle('topstrip__sub--editing', sale.editing);
    refs.clearBtnLabel.textContent = sale.editing ? 'Cancel' : 'Clear Entry';
    refs.completeBtnLabel.textContent = sale.editing
      ? 'Save Changes'
      : 'Complete Sale';
  }

  renderSaleDate() {
    const { refs, sale } = this;
    // Never fight the user mid-edit; only re-seed a field they are not in.
    if (document.activeElement !== refs.dateField) {
      refs.dateField.value = sale.saleDate;
    }
    this.renderDateValidity();
  }

  renderDateValidity() {
    this.refs.dateField.classList.toggle(
      'input--invalid',
      !this.sale.saleDateValid
    );
  }

  /** Rebuild the row list. Called only on structural change. */
  renderRows() {
    const { sale, refs } = this;
    const frag = document.createDocumentFragment();
    sale.items.forEach((item, index) => frag.append(this.buildRow(item, index)));
    refs.itemRows.replaceChildren(frag);
    this.renderTotals();
  }

  buildRow(item, index) {
    const isLast = index === this.sale.items.length - 1;

    const qty = this.buildField({
      area: 'qty',
      placeholder: 'Qty',
      value: item.qty !== 0 ? String(item.qty) : '',
      pattern: RE.combined,
    });
    const price = this.buildField({
      area: 'price',
      placeholder: 'Price/Unit',
      value: item.price !== 0 ? String(item.price) : '',
      pattern: RE.plain,
    });
    const disc = this.buildField({
      area: 'disc',
      placeholder: 'Discount %',
      value: item.discount || '',
      pattern: RE.chain,
    });

    const hint = el('span', { class: 'item-row__hint' });
    const total = el('span', { class: 'item-row__total' });
    const remove = el(
      'button',
      {
        class: 'item-row__remove',
        type: 'button',
        // Out of the tab order so Tab from Price reaches the next line's
        // Qty rather than stopping on a decoration.
        tabindex: '-1',
        'aria-label': `Remove line ${index + 1}`,
        onclick: () => this.sale.removeLine(index),
      },
      icon('i-cross', 'icon--cross')
    );

    const row = el('div', { class: 'item-row', 'data-row': index }, [
      el('span', { class: 'item-row__num', text: String(index + 1) }),
      qty,
      el('span', { class: 'item-row__mult', text: '×' }),
      price,
      hint,
      disc,
      total,
      remove,
    ]);

    // Muted while the Qty is still the untouched default 1; solid once
    // the user commits it or the value is anything else.
    const syncQtyTone = () => {
      const tentative = !this.confirmed.has(item) && Number(item.qty) === 1;
      qty.classList.toggle('input--tentative', tentative);
    };
    syncQtyTone();

    const syncHint = () => {
      // While editing a price, spell out the x1000 value so "80" is not
      // misread as 80.
      const v = parseField(price.value);
      const show = document.activeElement === price && v !== 0;
      hint.textContent = show
        ? `= ${this.settings.number(v * PRICE_MULTIPLIER)}`
        : '';
    };

    // --- input handling ---------------------------------------------
    qty.addEventListener('input', () => {
      this.confirmed.add(item);
      const text = qty.value;
      const m = text.match(/^(.*?)[*xX](.*)$/);
      if (m) {
        // "3*80" shorthand: split into qty + price and mirror the price
        // into its own field.
        const q = m[1].trim() === '' ? 1 : parseField(m[1]);
        this.sale.setQty(index, q);
        this.sale.setPrice(index, parseField(m[2]));
        setValue(price, parseField(m[2]) !== 0 ? String(parseField(m[2])) : '');
      } else {
        this.sale.setQty(index, parseField(text));
      }
      syncQtyTone();
    });

    price.addEventListener('input', () => {
      this.sale.setPrice(index, parseField(price.value));
      syncHint();
    });

    disc.addEventListener('input', () => {
      this.sale.setDiscount(index, disc.value);
    });

    price.addEventListener('focus', syncHint);
    price.addEventListener('blur', syncHint);

    // Selecting on focus lets a click or Tab overtype the value straight
    // away, matching EditField's selectAll().
    for (const [field, col] of [
      [qty, COL.QTY],
      [price, COL.PRICE],
      [disc, COL.DISC],
    ]) {
      field.addEventListener('focus', () => {
        field.select();
        this.scrollRowIntoView(index);
      });
      field.addEventListener('keydown', (e) =>
        this.onFieldKey(e, { index, col, isLast, item, qty, price, disc })
      );
    }

    row._parts = { item, qty, price, disc, total, hint, syncQtyTone };
    return row;
  }

  buildField({ area, placeholder, value, pattern }) {
    const input = el('input', {
      class: 'input',
      type: 'text',
      // 'none' stops iOS raising its own keyboard so the in-app pad can
      // take its place; the input still focuses and keeps a caret. With
      // a physical keyboard, 'decimal' asks for the numeric layout
      // without rejecting the separators and shorthand these accept.
      inputmode: this.useNumpad ? 'none' : 'decimal',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder,
      'aria-label': placeholder,
      'data-area': area,
    });
    setValue(input, value);
    // Published so the number pad can reject a key with exactly the rule
    // that governs typing, keeping one definition of what each field takes.
    input._pattern = pattern;
    // QML's validator rejects the keystroke outright; the browser has no
    // equivalent, so an invalid edit is rolled back to the last good text.
    input.addEventListener('input', () => {
      if (pattern.test(input.value)) {
        input.dataset.prev = input.value;
        return;
      }
      const caret = input.selectionStart ?? 0;
      input.value = input.dataset.prev ?? '';
      const at = Math.max(0, caret - 1);
      input.setSelectionRange(at, at);
    });
    return input;
  }

  /** Line totals + the grand total. Never touches the inputs. */
  renderTotals() {
    const rows = [...this.refs.itemRows.children];
    rows.forEach((row, index) => {
      const value = this.sale.lineTotalAt(index);
      row._parts.total.textContent = this.settings.number(value);
      row._parts.total.classList.toggle('item-row__total--zero', value === 0);
      row._parts.syncQtyTone();
    });
    this.totalTween.set(this.sale.grandTotal);
  }

  /** Re-read everything after a settings change (decimals, discounts). */
  refresh() {
    this.renderRows();
    this.renderChrome();
  }

  // ----- keyboard -----------------------------------------------------

  onFieldKey(e, ctx) {
    const { index, col, isLast, item, qty, price } = ctx;
    const field = e.currentTarget;
    const key = e.key;

    if (key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.sale.completeSale(); // handled globally too; harmless twice
        return;
      }
      if (e.shiftKey) {
        // Backward through the same chain Enter walks forward, which
        // differs per flow: column entry retreats up its own column.
        if (this.settings.entryFlow === 'column') {
          this.focusCell(index - 1, col);
          return;
        }
        if (col === COL.QTY) this.focusCell(index - 1, COL.PRICE);
        else if (col === COL.PRICE) this.focusCell(index, COL.QTY);
        else this.focusCell(index, COL.PRICE);
        return;
      }
      if (this.settings.entryFlow === 'column') {
        this.enterColumnFlow(ctx);
        return;
      }
      if (col === COL.QTY) {
        this.confirmed.add(item);
        if (/[*xX]/.test(qty.value)) {
          // The shorthand line is complete: tidy Qty back to just the
          // number and jump to the next line.
          setValue(qty, String(qty.value).split(/[*xX]/)[0].trim());
          this.advance(index);
        } else {
          this.focusCell(index, COL.PRICE);
        }
        return;
      }
      if (col === COL.PRICE) {
        // Enter on the blank trailing line completes the sale.
        if (isLast && price.value.length === 0) this.sale.completeSale();
        else this.advance(index);
        return;
      }
      // Discount walks straight down its own column; it never completes.
      this.focusCell(index + 1, COL.DISC);
      return;
    }

    if (key === 'Tab' && !e.shiftKey) {
      // Tab switches sides: with discounts on it jumps to this line's
      // Discount, and from Discount back to Qty.
      const discOn = this.settings.discountEnabled;
      if (col === COL.QTY) {
        e.preventDefault();
        this.focusCell(index, discOn ? COL.DISC : COL.PRICE);
      } else if (col === COL.PRICE && discOn) {
        e.preventDefault();
        this.focusCell(index, COL.DISC);
      } else if (col === COL.DISC) {
        e.preventDefault();
        this.focusCell(index, COL.QTY);
      }
      return;
    }

    if (key === 'ArrowUp') {
      e.preventDefault();
      this.focusCell(index - 1, col);
      return;
    }
    if (key === 'ArrowDown') {
      e.preventDefault();
      this.focusCell(index + 1, col);
      return;
    }

    const atStart = field.selectionStart === 0 && collapsed(field);
    const atEnd = field.selectionStart === field.value.length && collapsed(field);

    if (key === 'ArrowLeft' && atStart) {
      e.preventDefault();
      if (col === COL.QTY) {
        // Off the left edge -> the previous line's rightmost column.
        this.focusCell(
          index - 1,
          this.settings.discountEnabled ? COL.DISC : COL.PRICE
        );
      } else if (col === COL.PRICE) {
        this.focusCell(index, COL.QTY);
      } else {
        this.focusCell(index, COL.PRICE);
      }
      return;
    }
    if (key === 'ArrowRight' && atEnd) {
      e.preventDefault();
      if (col === COL.QTY) {
        this.focusCell(index, COL.PRICE);
      } else if (col === COL.PRICE) {
        if (this.settings.discountEnabled) this.focusCell(index, COL.DISC);
        else this.focusCell(index + 1, COL.QTY);
      } else {
        this.focusCell(index + 1, COL.QTY);
      }
    }
  }

  /**
   * Enter in column-first ("N") flow.
   *
   * Enter walks straight down whichever column you are in. Leaving a Qty
   * untouched means the quantities are done, so it hops to the top of
   * the Price column; an empty Price on the last row completes the sale.
   * That gives: all quantities, across, all prices.
   */
  enterColumnFlow(ctx) {
    const { index, col, isLast, item, qty, price } = ctx;

    if (col === COL.DISC) {
      // The discount column already walks downward in both flows.
      this.focusCell(index + 1, COL.DISC);
      return;
    }

    if (col === COL.QTY) {
      // "Nothing typed here" is either an untouched default 1 or a
      // field the user cleared — both mean the Qty column is finished.
      const untouched = !this.confirmed.has(item) || qty.value.trim() === '';
      if (untouched) {
        this.focusCell(0, COL.PRICE);
        return;
      }
      this.confirmed.add(item);
      if (/[*xX]/.test(qty.value)) {
        // The shorthand filled a price too; tidy Qty back to the number.
        setValue(qty, String(qty.value).split(/[*xX]/)[0].trim());
      }
      // Append unconditionally: no price exists yet during this pass.
      this.sale.appendRowAfter(index);
      this.focusCell(index + 1, COL.QTY);
      return;
    }

    // Price column.
    if (price.value.length === 0) {
      // Only the trailing row ends the sale; a gap mid-column is just
      // a line the user chose to skip, so step over it.
      if (isLast) this.sale.completeSale();
      else this.focusCell(index + 1, COL.PRICE);
      return;
    }
    this.sale.ensureTrailingBlank(index);
    this.focusCell(index + 1, COL.PRICE);
  }

  /**
   * Enter on a price: create the next line now (not while typing) if this
   * is the last row and it carries a price, then move into it.
   */
  advance(index) {
    this.sale.ensureTrailingBlank(index);
    // ensureTrailingBlank emits synchronously, so the row list has
    // already been rebuilt by the time we get here — no deferral needed.
    this.focusCell(index + 1, COL.QTY);
  }

  /** Focus (row, column). Out-of-range rows simply leave focus put. */
  focusCell(row, col) {
    const node = this.refs.itemRows.children[row];
    if (!node) return;
    const area = col === COL.QTY ? 'qty' : col === COL.PRICE ? 'price' : 'disc';
    const field = node.querySelector(`[data-area='${area}']`);
    // A hidden Discount column (the setting is off) is not focusable.
    if (!field || field.offsetParent === null) return;
    // preventScroll matters: left to itself the browser scrolls the
    // focused *input* into view and centres it, which both overshoots and
    // ignores the row's scroll-margin — the row ends up a few pixels
    // clipped and the list jumps. Suppressing it hands the scrolling to
    // scrollRowIntoView, which moves the minimum distance and smoothly.
    field.focus({ preventScroll: true });
    field.select();
    this.onFieldFocused(field);
    this.scrollRowIntoView(row);
  }

  /**
   * Re-reveal whatever row holds focus. Called when the number pad opens
   * or closes, since that resizes the list under the focused field.
   */
  scrollFocusedIntoView() {
    const row = document.activeElement?.closest?.('.item-row');
    if (!row) return;
    this.scrollRowIntoView([...this.refs.itemRows.children].indexOf(row));
  }

  /**
   * Bring a row fully into view, scrolling the minimum distance plus the
   * row's scroll-margin so it doesn't sit flush against the edge.
   *
   * This does the arithmetic rather than calling scrollIntoView because
   * of the early return: every focus asks to be scrolled to, so one
   * Enter (focus Qty, focus Price, focus the new row) would fire three
   * requests in a single tick. Smooth scrolls issued on top of each
   * other re-aim from a half-finished position and land short, leaving
   * the new row clipped. Bailing out when there is nothing to do means
   * exactly one scroll is ever in flight.
   *
   * Reading the rects forces layout, so a row appended moments ago is
   * measured where it actually is — the browser's equivalent of the
   * forceLayout() the QML version needs.
   */
  scrollRowIntoView(row) {
    const node = this.refs.itemRows.children[row];
    if (!node) return;
    const scroller = this.refs.itemsScroll;
    const margin = parseFloat(getComputedStyle(node).scrollMarginTop) || 0;
    const box = node.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();

    let delta = 0;
    if (box.top - margin < view.top) {
      delta = box.top - margin - view.top;
    } else if (box.bottom + margin > view.bottom) {
      delta = box.bottom + margin - view.bottom;
    }
    if (Math.abs(delta) < 1) return; // already comfortably in view

    scroller.scrollTo({
      top: scroller.scrollTop + delta,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }
}

/** True when there is a caret rather than a selection. */
function collapsed(field) {
  return field.selectionStart === field.selectionEnd;
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Set an input's text and keep its rollback snapshot in step. */
function setValue(input, text) {
  input.value = text;
  input.dataset.prev = text;
}
