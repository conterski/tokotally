/**
 * View-model layer — the web counterpart of backend/*_viewmodel.py and
 * backend/settings.py.
 *
 * Same split as the desktop app: SettingsStore holds persisted
 * preferences, LogsStore owns the named logs and the active selection,
 * LedgerStore owns the logged sales plus the KPI aggregates, and
 * SaleStore owns the in-progress sale. Stores never touch the DOM; they
 * emit events the UI subscribes to.
 *
 * Two event kinds matter for rendering:
 *   'structure' — the row list changed shape, so rebuild it
 *   'values'    — only numbers moved, so patch text and leave inputs
 *                 (and the caret) alone
 * Re-rendering inputs on every keystroke would fight the user, which is
 * the same reason the QML delegate patches roles instead of resetting.
 */

import {
  DEFAULT_QTY,
  PRICE_MULTIPLIER,
  discountFactor,
  effectiveDate,
  formatDateDisplay,
  formatMoney,
  formatNumber,
  lineTotal,
  nowStamp,
  parseUserDate,
  todayIso,
} from './core.js';

/** Minimal synchronous event emitter. */
class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this._handlers.get(event).delete(fn);
  }

  emit(event, detail) {
    const set = this._handlers.get(event);
    if (set) for (const fn of [...set]) fn(detail);
  }
}

// =====================================================================
// Settings
// =====================================================================
export class SettingsStore extends Emitter {
  constructor(db, values) {
    super();
    this._db = db;
    // Defaults match the desktop brief: 3 decimals, Rupiah, calm teal,
    // dark first, per-line discounts off until opted into.
    this.decimals = parseInt(values.decimals ?? '3', 10);
    this.currency = values.currency ?? 'Rp';
    this.accent = values.accent ?? '#2dd4bf';
    this.darkMode = (values.dark_mode ?? '1') === '1';
    this.discountEnabled = (values.discount_enabled ?? '0') === '1';
    // How Enter walks the grid. 'row' is the desktop app's zig-zag —
    // Qty, Price, down to the next line. 'column' fills the whole Qty
    // column first, then the whole Price column.
    this.entryFlow = values.entry_flow === 'column' ? 'column' : 'row';
  }

  static async load(db) {
    return new SettingsStore(db, await db.allSettings());
  }

  async _write(key, value) {
    await this._db.setSetting(key, value);
    this.emit('changed');
  }

  setDecimals(v) {
    const next = Math.max(0, Math.min(6, Number(v) | 0));
    if (next === this.decimals) return;
    this.decimals = next;
    this._write('decimals', String(next));
  }

  setCurrency(v) {
    const next = String(v).trim() || 'Rp';
    if (next === this.currency) return;
    this.currency = next;
    this._write('currency', next);
  }

  setAccent(v) {
    if (v === this.accent) return;
    this.accent = v;
    this._write('accent', v);
  }

  setDarkMode(v) {
    const next = Boolean(v);
    if (next === this.darkMode) return;
    this.darkMode = next;
    this._write('dark_mode', next ? '1' : '0');
  }

  setDiscountEnabled(v) {
    const next = Boolean(v);
    if (next === this.discountEnabled) return;
    this.discountEnabled = next;
    this._write('discount_enabled', next ? '1' : '0');
  }

  setEntryFlow(v) {
    const next = v === 'column' ? 'column' : 'row';
    if (next === this.entryFlow) return;
    this.entryFlow = next;
    this._write('entry_flow', next);
  }

  /** Format helpers bound to the current preferences. */
  money(v) {
    return formatMoney(v, this.decimals, this.currency);
  }

  number(v) {
    return formatNumber(v, this.decimals);
  }
}

// =====================================================================
// Logs
// =====================================================================
const SELECTED_KEY = 'selected_log_id';

export class LogsStore extends Emitter {
  constructor(db, ledger) {
    super();
    this._db = db;
    this._ledger = ledger;
    this.logs = [];
    this.currentLogId = -1;
  }

  static async create(db, ledger) {
    const store = new LogsStore(db, ledger);
    store.logs = await db.allLogs();
    // Restore the persisted active log, falling back to the first if the
    // stored id is stale (that log was deleted, or the data was imported).
    const stored = await db.getSetting(SELECTED_KEY);
    store.currentLogId = store._coerceCurrent(stored);
    await ledger.setLog(store.currentLogId);
    await db.setSetting(SELECTED_KEY, String(store.currentLogId));
    return store;
  }

  _coerceCurrent(stored) {
    const ids = this.logs.map((l) => l.id);
    const wanted = Number.parseInt(stored, 10);
    return ids.includes(wanted) ? wanted : ids[0];
  }

  get count() {
    return this.logs.length;
  }

  get currentLogName() {
    const log = this.logs.find((l) => l.id === this.currentLogId);
    return log ? log.name : '';
  }

  /** Make `logId` the active log — ledger view and save target both. */
  async selectLog(logId) {
    logId = Number(logId);
    if (logId === this.currentLogId) return;
    if (!this.logs.some((l) => l.id === logId)) return;
    this.currentLogId = logId;
    await this._db.setSetting(SELECTED_KEY, String(logId));
    await this._ledger.setLog(logId);
    this.emit('changed');
  }

  /** Create a named log and immediately make it active. */
  async createLog(name) {
    const clean = String(name).trim() || `Log ${this.logs.length + 1}`;
    const record = await this._db.createLog(clean);
    this.logs.push(record);
    this.emit('changed');
    // Force the switch: selectLog short-circuits on an unchanged id.
    this.currentLogId = -1;
    await this.selectLog(record.id);
  }

  async renameLog(logId, name) {
    const clean = String(name).trim();
    const log = this.logs.find((l) => l.id === Number(logId));
    if (!log || !clean) return;
    await this._db.renameLog(log.id, clean);
    log.name = clean;
    this.emit('changed');
  }

  /** Delete a log and its contents; always keep at least one alive. */
  async deleteLog(logId) {
    logId = Number(logId);
    const at = this.logs.findIndex((l) => l.id === logId);
    if (at < 0 || this.logs.length <= 1) return;
    await this._db.deleteLog(logId);
    this.logs.splice(at, 1);
    this.emit('changed');
    if (logId === this.currentLogId) {
      this.currentLogId = -1;
      await this.selectLog(this.logs[0].id);
    }
  }

  /** Re-read logs from storage (after a backup restore). */
  async reload() {
    this.logs = await this._db.allLogs();
    const stored = await this._db.getSetting(SELECTED_KEY);
    this.currentLogId = this._coerceCurrent(stored);
    await this._db.setSetting(SELECTED_KEY, String(this.currentLogId));
    await this._ledger.setLog(this.currentLogId);
    this.emit('changed');
  }
}

// =====================================================================
// Ledger
// =====================================================================
export class LedgerStore extends Emitter {
  constructor(db) {
    super();
    this._db = db;
    this.rows = [];
    this.currentLogId = null;
    // Stash for the delete-undo toast: {pos, record, items}.
    this._deleted = null;
  }

  /** Switch the ledger to show (and write to) `logId`. */
  async setLog(logId) {
    this.currentLogId = Number(logId);
    this._deleted = null; // belonged to the log we are leaving
    this.rows = await this._db.allTransactions(this.currentLogId);
    // `reset` tells the view the whole list was replaced, so it should
    // jump to the newest sale rather than hold the old scroll position.
    this.emit('structure', { reset: true });
    this.emit('kpis');
  }

  // The aggregates are derived rather than maintained incrementally: the
  // rows are already in memory, so a reduce cannot drift out of sync with
  // them the way a running counter can.
  get runningTotal() {
    return this.rows.reduce((s, r) => s + Number(r.total), 0);
  }

  get count() {
    return this.rows.length;
  }

  /**
   * Sum of sales whose effective date is today. Re-derived on demand so
   * a minute timer can roll it over at midnight with no new sale.
   */
  get todayTotal() {
    const today = todayIso();
    return this.rows
      .filter((r) => effectiveDate(r) === today)
      .reduce((s, r) => s + Number(r.total), 0);
  }

  refreshToday() {
    this.emit('kpis');
  }

  /** Persist a completed sale (with its line items) and update the KPIs. */
  async logSale(total, items, saleDate) {
    const record = await this._db.insertTransaction(
      this.currentLogId,
      total,
      items,
      saleDate,
      nowStamp()
    );
    this.rows.push(record); // newest at the bottom
    this.emit('structure', { appended: record.id });
    this.emit('kpis');
  }

  /** Empty the active log entirely and reset its KPIs to zero. */
  async clearLog() {
    await this._db.clearTransactions(this.currentLogId);
    this.rows = [];
    this._deleted = null; // the undo target no longer exists
    this.emit('structure', { reset: true });
    this.emit('kpis');
  }

  /** Everything the sale panel needs to edit the sale at `row`. */
  async editSnapshot(row) {
    if (!(row >= 0 && row < this.rows.length)) return null;
    const rec = this.rows[row];
    return {
      id: rec.id,
      seqNo: rec.seqNo,
      createdAt: rec.createdAt,
      saleDate: rec.saleDate || '',
      items: await this._db.getLineItems(rec.id),
    };
  }

  /**
   * Current list position of a transaction (or -1), so an in-panel edit
   * can re-resolve its target at save time even if the list shifted.
   */
  rowForTxnId(txnId) {
    return this.rows.findIndex((r) => r.id === Number(txnId));
  }

  /**
   * Edit a logged sale: line items plus No. and the optional date.
   *
   * The total is *derived* from the lines with the same x1000 rule as a
   * live sale, so it always agrees with the breakdown. A non-positive
   * total is rejected (delete is how you remove a sale), as is an
   * unparseable date.
   */
  async updateSaleLines(row, seqNo, createdAt, saleDateText, items) {
    if (!(row >= 0 && row < this.rows.length)) return;
    const saleDate = parseUserDate(saleDateText);
    if (saleDate === null) return;
    const clean = items
      .filter((it) => Number(it.qty || 0) || Number(it.price || 0))
      .map((it) => ({
        qty: Number(it.qty),
        price: Number(it.price),
        discount: String(it.discount || ''),
      }));
    const total = clean.reduce(
      (s, i) =>
        s + i.qty * i.price * PRICE_MULTIPLIER * discountFactor(i.discount),
      0
    );
    if (total <= 0) return;
    const record = this.rows[row];
    await this._db.replaceLineItems(record.id, clean);
    await this._db.updateTransaction(record.id, {
      total,
      seqNo,
      createdAt,
      saleDate,
    });
    Object.assign(record, {
      seqNo: Number(seqNo),
      total,
      createdAt: String(createdAt),
      saleDate,
      itemCount: clean.length,
    });
    this.emit('structure');
    this.emit('kpis');
  }

  /** Delete one logged sale, stashing it for the Undo toast. */
  async deleteSale(row) {
    if (!(row >= 0 && row < this.rows.length)) return;
    const record = this.rows[row];
    // Read the lines before the delete takes them with it.
    const items = await this._db.getLineItems(record.id);
    this._deleted = { pos: row, record, items };
    await this._db.deleteTransaction(record.id);
    this.rows.splice(row, 1);
    this.emit('structure');
    this.emit('kpis');
  }

  /** Restore the most recently deleted sale (Undo in the toast). */
  async undoDelete() {
    if (!this._deleted) return;
    const { pos, record, items } = this._deleted;
    this._deleted = null;
    await this._db.restoreTransaction(record, items);
    this.rows.splice(Math.min(pos, this.rows.length), 0, record);
    this.emit('structure');
    this.emit('kpis');
  }

  /**
   * The logged amounts, one per line — bare numbers in the same
   * oldest-first order as the list, so the text pastes cleanly into a
   * spreadsheet or a message.
   */
  amountsText() {
    // String() already drops a trailing ".0" the way the Python version's
    // int-vs-float branch did, so a whole amount copies as "1600000".
    return this.rows.map((r) => String(Number(r.total))).join('\n');
  }
}

// =====================================================================
// Active sale
// =====================================================================
export class SaleStore extends Emitter {
  constructor(ledger) {
    super();
    this._ledger = ledger;
    // Start with one blank row to type into.
    this.items = [blankRow()];
    // Kept across sales so a batch back-logged for one day is typed once.
    this.saleDate = '';
    this._undoItems = null;
    // "Edit a logged sale in this panel" state; null id == composing new.
    this.editingId = null;
    this.editSeqNo = 0;
    this._editCreatedAt = '';
    this._composeStash = null;
  }

  get editing() {
    return this.editingId !== null;
  }

  get editingTxnId() {
    return this.editingId === null ? -1 : this.editingId;
  }

  get grandTotal() {
    return this.items.reduce((s, i) => s + lineTotal(i), 0);
  }

  get saleDateValid() {
    return parseUserDate(this.saleDate) !== null;
  }

  setSaleDate(text) {
    if (text === this.saleDate) return;
    this.saleDate = String(text);
    this.emit('saleDate');
  }

  lineTotalAt(row) {
    const item = this.items[row];
    return item ? lineTotal(item) : 0;
  }

  setQty(row, value) {
    if (!this.items[row]) return;
    this.items[row].qty = Number(value);
    this.emit('values', { row });
  }

  setPrice(row, value) {
    if (!this.items[row]) return;
    this.items[row].price = Number(value);
    this.emit('values', { row });
  }

  setDiscount(row, text) {
    if (!this.items[row]) return;
    this.items[row].discount = String(text);
    this.emit('values', { row });
  }

  /**
   * Append a fresh trailing row once the last row has data.
   *
   * Called the moment Enter is pressed on a price, so a new empty line
   * appears only on that explicit step — never while still typing. The
   * appended row inherits the completed row's discount chain, so a batch
   * sharing one discount only needs it typed once.
   */
  ensureTrailingBlank(row) {
    const last = this.items.length - 1;
    if (row !== last || rowBlank(this.items[last])) return false;
    return this._appendBlank();
  }

  /**
   * Append a blank row when `row` is the last one, whatever it holds.
   *
   * Column-first entry walks down the Qty column before any price
   * exists, so it cannot use ensureTrailingBlank's "only once the line
   * carries a price" rule — every row would still look blank.
   */
  appendRowAfter(row) {
    if (row !== this.items.length - 1) return false;
    return this._appendBlank();
  }

  _appendBlank() {
    const previous = this.items[this.items.length - 1];
    const next = blankRow();
    next.discount = previous.discount || '';
    this.items.push(next);
    this.emit('structure', { appended: this.items.length - 1 });
    return true;
  }

  /** Remove a line item; always keep at least one (blank) row. */
  removeLine(row) {
    if (!(row >= 0 && row < this.items.length)) return;
    this.items.splice(row, 1);
    if (this.items.length === 0) this.items.push(blankRow());
    this.emit('structure');
  }

  _resetItems() {
    this.items = [blankRow()];
    this.emit('structure');
  }

  /**
   * Discard the current line items; returns true if any had data, so the
   * caller can skip the toast for an already-empty sale. The discarded
   * items are stashed for restoreEntry (the toast's Undo).
   */
  clearEntry() {
    const hadData = this.items.some((i) => !rowBlank(i));
    if (hadData) this._undoItems = this.items.map((i) => ({ ...i }));
    this._resetItems();
    return hadData;
  }

  restoreEntry() {
    if (!this._undoItems) return;
    this.items = this._undoItems;
    this._undoItems = null;
    this.emit('structure');
  }

  /**
   * Load the ledger sale at `row` into this panel for editing.
   *
   * Any in-progress new sale is parked and restored when the edit is
   * saved or cancelled. The sale's No. and creation time are preserved —
   * only line items and the date are editable here.
   */
  async beginEdit(row) {
    const snap = await this._ledger.editSnapshot(row);
    if (!snap) return;
    // Park the compose the first time in; switching targets keeps the
    // original stash.
    if (this.editingId === null) {
      this._composeStash = {
        items: this.items.map((i) => ({ ...i })),
        date: this.saleDate,
      };
    }
    const lines = snap.items || [];
    this.items = lines.length
      ? lines.map((l) => ({
          qty: Number(l.qty),
          price: Number(l.price),
          discount: String(l.discount || ''),
        }))
      : [blankRow()];
    this.editingId = Number(snap.id);
    this.editSeqNo = Number(snap.seqNo);
    this._editCreatedAt = String(snap.createdAt);
    this.saleDate = formatDateDisplay(snap.saleDate || '');
    this.emit('editing');
    this.emit('saleDate');
    this.emit('structure');
  }

  /** Leave edit mode without saving; restore the parked new sale. */
  cancelEdit() {
    if (this.editingId === null) return;
    this._exitEdit(true);
  }

  _exitEdit(restore) {
    if (restore && this._composeStash) {
      this.items = this._composeStash.items;
      this.saleDate = this._composeStash.date;
    } else {
      this.items = [blankRow()];
    }
    this._composeStash = null;
    this.editingId = null;
    this.editSeqNo = 0;
    this._editCreatedAt = '';
    this.emit('editing');
    this.emit('saleDate');
    this.emit('structure');
  }

  /**
   * Save the current line items.
   *
   * Composing: validate the optional date, require a positive total, hand
   * it to the ledger, reset, and signal so the UI refocuses. The typed
   * date is kept for the next sale (batch entry per day).
   *
   * Editing: same validation, then overwrite that transaction's lines,
   * total and date (its No. and creation time are preserved), leave edit
   * mode restoring the parked sale, and signal.
   */
  async completeSale() {
    const saleDate = parseUserDate(this.saleDate);
    if (saleDate === null) {
      this.emit('invalidDate');
      return;
    }
    const total = this.grandTotal;
    // Persist the breakdown too (skipping blank rows) so the logged sale
    // can later be reopened and edited line by line.
    const items = this.items
      .filter((i) => !rowBlank(i))
      .map((i) => ({
        qty: i.qty,
        price: i.price,
        discount: i.discount || '',
      }));

    if (this.editingId !== null) {
      if (total <= 0) return; // nothing to save; stay in edit mode
      const row = this._ledger.rowForTxnId(this.editingId);
      if (row < 0) {
        // The transaction vanished (deleted elsewhere): leave edit mode
        // rather than write to a stale row.
        this._exitEdit(true);
        return;
      }
      const seq = this.editSeqNo;
      await this._ledger.updateSaleLines(
        row,
        seq,
        this._editCreatedAt,
        this.saleDate,
        items
      );
      this._exitEdit(true);
      this.emit('editSaved', seq);
      return;
    }

    if (total <= 0) return;
    await this._ledger.logSale(total, items, saleDate);
    this._resetItems();
    this.emit('completed');
  }
}

/** A pristine, untouched line item. */
function blankRow() {
  return { qty: DEFAULT_QTY, price: 0, discount: '' };
}

/**
 * True when a row is not yet a real line.
 *
 * A line only becomes real once it has a price — qty alone (which
 * defaults to 1) never makes a loggable line, since the total is
 * qty x price. So the price is the single signal for "this row has
 * data": it decides when a trailing blank is appended and which rows are
 * logged. It also means a qty-only row is the trailing blank, so Enter
 * on its empty Price completes the sale.
 */
function rowBlank(item) {
  return Number(item.price) === 0;
}
