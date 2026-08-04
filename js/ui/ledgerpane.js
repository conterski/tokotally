/**
 * The ledger pane — the web port of qml/LedgerPane.qml.
 *
 * Log picker, two chrome-less KPIs, the oldest-first list with the latest
 * sale at the bottom, and a pinned running total. Per-row Edit loads the
 * sale into the left panel (there is no in-ledger editor); Delete is
 * reversible from the toast.
 */

import { formatDateDisplay, formatTime } from '../core.js';
import {
  confirmAction,
  el,
  icon,
  openMenu,
  promptName,
} from './common.js';
import { tweenNumber } from './tween.js';

export class LedgerPane {
  constructor({ ledger, logs, sale, settings, refs, onToast }) {
    this.ledger = ledger;
    this.logs = logs;
    this.sale = sale;
    this.settings = settings;
    this.refs = refs;
    this.onToast = onToast;
    this.prevCount = 0;
    this.menuRow = -1;

    this.todayTween = tweenNumber((v) => {
      this.refs.kpiToday.textContent = this.settings.money(v);
    });
    this.runningTween = tweenNumber((v) => {
      this.refs.runningTotal.textContent = this.settings.money(v);
    });
  }

  init() {
    const { refs, ledger, logs } = this;

    refs.logPicker.addEventListener('click', () => this.openLogMenu());
    refs.copyBtn.addEventListener('click', () => this.copyAmounts());
    refs.clearLogBtn.addEventListener('click', () => this.confirmClearLog());

    ledger.on('structure', (detail) => this.renderRows(detail));
    ledger.on('kpis', () => this.renderKpis());
    logs.on('changed', () => this.renderHead());
    // The accent tint on the row being edited follows the left panel.
    // No scroll: the row count is unchanged, so renderRows leaves the
    // position alone.
    this.sale.on('editing', () => this.renderRows());

    // Re-check the Today KPI each minute so it rolls over at midnight
    // even when no sale is being logged.
    setInterval(() => ledger.refreshToday(), 60000);

    this.renderHead();
    this.renderRows({ reset: true });
    this.renderKpis({ animate: false });
  }

  // ----- rendering ----------------------------------------------------

  renderHead() {
    this.refs.logName.textContent = this.logs.currentLogName;
  }

  renderKpis({ animate = true } = {}) {
    const { ledger, refs } = this;
    refs.kpiCount.textContent = String(ledger.count);
    refs.tabLedgerCount.textContent =
      ledger.count === 1 ? '1 sale' : `${ledger.count} sales`;
    this.todayTween.set(ledger.todayTotal, { animate });
    this.runningTween.set(ledger.runningTotal, { animate });
    const empty = ledger.count === 0;
    refs.copyBtn.disabled = empty;
    refs.clearLogBtn.disabled = empty;
    refs.logEmpty.classList.toggle('hidden', !empty);
  }

  renderRows(detail = {}) {
    const { ledger, refs } = this;
    const frag = document.createDocumentFragment();
    ledger.rows.forEach((row, index) => frag.append(this.buildRow(row, index)));
    refs.logRows.replaceChildren(frag);

    // Keep the latest sale in view: jump to the bottom when rows are
    // added (a new sale) or when the whole list was replaced (a log
    // switch). A deletion leaves the scroll position alone.
    const grew = ledger.rows.length > this.prevCount;
    this.prevCount = ledger.rows.length;
    if (detail.reset || grew) this.scrollToEnd(!detail.reset);
    this.renderKpis();
  }

  buildRow(record, index) {
    const beingEdited =
      this.sale.editing && this.sale.editingTxnId === record.id;

    const more = el(
      'button',
      {
        class: 'log-row__more',
        type: 'button',
        'aria-label': `Actions for sale No. ${record.seqNo}`,
        onclick: (e) => {
          e.stopPropagation();
          this.openRowMenu(e.currentTarget, index, record);
        },
      },
      icon('i-dots', 'icon--dots')
    );

    const classes = ['log-row'];
    if (beingEdited) classes.push('log-row--editing');

    return el('div', { class: classes.join(' '), 'data-row': index }, [
      el('div', { class: 'log-row__meta' }, [
        el('span', { class: 'log-row__seq', text: `No. ${record.seqNo}` }),
        el('span', {
          class: 'log-row__items',
          text: `${record.itemCount} ${record.itemCount === 1 ? 'item' : 'items'}`,
        }),
      ]),
      el('span', {
        class: 'log-row__total',
        text: this.settings.money(record.total),
      }),
      el('div', { class: 'log-row__when' }, [
        el('span', {
          class: 'log-row__date',
          text: formatDateDisplay(record.saleDate || ''),
        }),
        el('span', {
          class: 'log-row__time',
          text: formatTime(record.createdAt),
        }),
      ]),
      more,
    ]);
  }

  scrollToEnd(smooth = true) {
    const scroll = this.refs.logScroll;
    scroll.scrollTo({
      top: scroll.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  refresh() {
    this.renderHead();
    this.renderRows();
    this.renderKpis({ animate: false });
  }

  // ----- actions ------------------------------------------------------

  /**
   * Copy the logged amounts, one per line.
   *
   * navigator.clipboard needs a secure context, which a plain-http LAN
   * address is not — so fall back to the old execCommand path rather
   * than silently doing nothing on a phone.
   */
  async copyAmounts() {
    const text = this.ledger.amountsText();
    const n = this.ledger.count;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = legacyCopy(text);
    this.onToast(
      ok
        ? `Copied ${n} ${n === 1 ? 'amount' : 'amounts'}`
        : 'Could not copy — select and copy manually'
    );
  }

  async confirmClearLog() {
    const ok = await confirmAction({
      title: 'Clear the log?',
      body:
        'This permanently deletes every logged sale and resets the counter ' +
        'and running total to zero.',
      okLabel: 'Clear Log',
    });
    if (ok) await this.ledger.clearLog();
  }

  openLogMenu() {
    const { logs } = this;
    const items = logs.logs.map((log) => ({
      label: `${log.id === logs.currentLogId ? '✓  ' : '     '}${log.name}`,
      current: log.id === logs.currentLogId,
      onSelect: () => logs.selectLog(log.id),
    }));
    items.push({ separator: true });
    items.push({
      label: 'New log…',
      onSelect: async () => {
        const name = await promptName({ title: 'New log' });
        if (name) await logs.createLog(name);
      },
    });
    items.push({
      label: 'Rename…',
      onSelect: async () => {
        const name = await promptName({
          title: 'Rename log',
          value: logs.currentLogName,
        });
        if (name) await logs.renameLog(logs.currentLogId, name);
      },
    });
    items.push({
      label: 'Delete log',
      danger: true,
      // Always keep at least one log alive.
      disabled: logs.count <= 1,
      onSelect: async () => {
        const ok = await confirmAction({
          title: `Delete "${logs.currentLogName}"?`,
          body:
            'This permanently deletes the log and every sale logged in it. ' +
            'This cannot be undone.',
          okLabel: 'Delete log',
        });
        if (ok) await logs.deleteLog(logs.currentLogId);
      },
    });
    openMenu(this.refs.logPicker, items);
  }

  openRowMenu(anchor, index, record) {
    const rowEl = anchor.closest('.log-row');
    rowEl?.classList.add('log-row--menu-open');
    openMenu(
      anchor,
      [
        {
          label: 'Edit',
          // Load this sale into the left input panel for editing.
          onSelect: () => this.sale.beginEdit(index),
        },
        {
          label: 'Delete',
          danger: true,
          onSelect: async () => {
            await this.ledger.deleteSale(index);
            this.onToast('Sale deleted', () => this.ledger.undoDelete());
          },
        },
      ],
      { onClose: () => rowEl?.classList.remove('log-row--menu-open') }
    );
  }
}

/** Clipboard fallback for non-secure contexts (a plain-http LAN host). */
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
