/**
 * IndexedDB data layer — the web counterpart of backend/database.py.
 *
 * This is the only module that touches storage; the stores call into it
 * through the same small, intention-revealing API the Python version
 * exposes, so the view-model logic above it reads identically.
 *
 * Object stores mirror the SQLite tables one-for-one (logs, transactions,
 * lineItems, settings). Where SQLite did the work in a query — the
 * per-log running total, today's takings, the next seq_no, cascade
 * deletes — we do it over an index cursor instead; a shop's ledger is
 * small enough that reading a log's rows is cheap.
 */

const DB_NAME = 'tokotally';
const DB_VERSION = 1;

export const STORES = {
  logs: 'logs',
  transactions: 'transactions',
  lineItems: 'lineItems',
  settings: 'settings',
};

/** Promise wrapper for an IDBRequest. */
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Promise that settles when a transaction commits (or fails). */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export class Database {
  constructor(db) {
    this._db = db;
  }

  /**
   * Open (creating on first run) the database and guarantee the
   * invariant the app relies on everywhere: at least one log exists.
   */
  static async open(name = DB_NAME) {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORES.logs)) {
        db.createObjectStore(STORES.logs, {
          keyPath: 'id',
          autoIncrement: true,
        });
      }
      if (!db.objectStoreNames.contains(STORES.transactions)) {
        const t = db.createObjectStore(STORES.transactions, {
          keyPath: 'id',
          autoIncrement: true,
        });
        // Every ledger read is "the rows of one log", so index it.
        t.createIndex('logId', 'logId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.lineItems)) {
        const li = db.createObjectStore(STORES.lineItems, {
          keyPath: 'id',
          autoIncrement: true,
        });
        // Lookup-by-parent drives both the item count and the hand-rolled
        // cascade delete.
        li.createIndex('transactionId', 'transactionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
    };
    const raw = await req(open);
    const db = new Database(raw);
    await db._ensureDefaultLog();
    return db;
  }

  async _ensureDefaultLog() {
    const logs = await this.allLogs();
    if (logs.length === 0) await this.createLog('Log 1');
  }

  _tx(names, mode = 'readonly') {
    return this._db.transaction(names, mode);
  }

  // ----- logs ---------------------------------------------------------

  /** Every log, oldest first (stable picker order). */
  async allLogs() {
    const rows = await req(this._tx(STORES.logs).objectStore(STORES.logs).getAll());
    return rows
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ id: r.id, name: String(r.name) }));
  }

  async createLog(name) {
    const tx = this._tx(STORES.logs, 'readwrite');
    const id = await req(
      tx.objectStore(STORES.logs).add({ name: String(name) })
    );
    await done(tx);
    return { id, name: String(name) };
  }

  async renameLog(logId, name) {
    const tx = this._tx(STORES.logs, 'readwrite');
    const store = tx.objectStore(STORES.logs);
    const rec = await req(store.get(logId));
    if (rec) {
      rec.name = String(name);
      store.put(rec);
    }
    await done(tx);
  }

  /** Delete a log and everything inside it (transactions + their lines). */
  async deleteLog(logId) {
    const ids = await this._txnIdsForLog(logId);
    const tx = this._tx(
      [STORES.logs, STORES.transactions, STORES.lineItems],
      'readwrite'
    );
    this._deleteTxnsIn(tx, ids);
    tx.objectStore(STORES.logs).delete(logId);
    await done(tx);
  }

  // ----- ledger reads --------------------------------------------------

  async _txnIdsForLog(logId) {
    const idx = this._tx(STORES.transactions)
      .objectStore(STORES.transactions)
      .index('logId');
    return await req(idx.getAllKeys(IDBKeyRange.only(logId)));
  }

  /** Raw transaction records of one log, oldest first. */
  async _rawTransactions(logId) {
    const idx = this._tx(STORES.transactions)
      .objectStore(STORES.transactions)
      .index('logId');
    const rows = await req(idx.getAll(IDBKeyRange.only(logId)));
    return rows.sort((a, b) => a.id - b.id);
  }

  /**
   * One log's transactions, oldest first, each carrying its line-item
   * count — the shape the ledger list binds to.
   */
  async allTransactions(logId) {
    const rows = await this._rawTransactions(logId);
    // Count line items for the whole log in one pass rather than a query
    // per row (the N+1 the SQL version avoided with a subquery).
    const counts = await this._lineItemCounts();
    return rows.map((r) => ({
      id: r.id,
      logId: r.logId,
      seqNo: r.seqNo,
      total: Number(r.total),
      createdAt: String(r.createdAt),
      saleDate: String(r.saleDate || ''),
      itemCount: counts.get(r.id) || 0,
    }));
  }

  async _lineItemCounts() {
    const store = this._tx(STORES.lineItems).objectStore(STORES.lineItems);
    const all = await req(store.getAll());
    const counts = new Map();
    for (const li of all) {
      counts.set(li.transactionId, (counts.get(li.transactionId) || 0) + 1);
    }
    return counts;
  }

  /** Sum of one log's totals — the pinned footer value. */
  async runningTotal(logId) {
    const rows = await this._rawTransactions(logId);
    return rows.reduce((s, r) => s + Number(r.total), 0);
  }

  /** How many transactions are logged in one log. */
  async count(logId) {
    const ids = await this._txnIdsForLog(logId);
    return ids.length;
  }

  /** The next human-visible sequence number (1, 2, 3 ...) for a log. */
  async _nextSeqNo(logId) {
    const rows = await this._rawTransactions(logId);
    return rows.reduce((m, r) => Math.max(m, Number(r.seqNo) || 0), 0) + 1;
  }

  // ----- ledger writes -------------------------------------------------

  /**
   * Log one completed sale (into `logId`) plus its line items, and return
   * the freshly created record so the caller can append it without
   * re-reading everything.
   */
  async insertTransaction(logId, total, items, saleDate, createdAt) {
    const seqNo = await this._nextSeqNo(logId);
    const stamp = createdAt;
    const tx = this._tx([STORES.transactions, STORES.lineItems], 'readwrite');
    const id = await req(
      tx.objectStore(STORES.transactions).add({
        logId,
        seqNo,
        total: Number(total),
        createdAt: stamp,
        saleDate: String(saleDate || ''),
      })
    );
    this._putLineItems(tx, id, items || []);
    await done(tx);
    return {
      id,
      logId,
      seqNo,
      total: Number(total),
      createdAt: stamp,
      saleDate: String(saleDate || ''),
      itemCount: (items || []).length,
    };
  }

  /**
   * Re-insert a just-deleted sale verbatim (the Undo path).
   *
   * Reuses the original key, which is safe because IndexedDB's key
   * generator only ever moves forward — no newer row can have claimed it.
   */
  async restoreTransaction(record, items) {
    const tx = this._tx([STORES.transactions, STORES.lineItems], 'readwrite');
    tx.objectStore(STORES.transactions).add({
      id: record.id,
      logId: record.logId,
      seqNo: record.seqNo,
      total: Number(record.total),
      createdAt: String(record.createdAt),
      saleDate: String(record.saleDate || ''),
    });
    this._putLineItems(tx, record.id, items);
    await done(tx);
  }

  _putLineItems(tx, txnId, items) {
    const store = tx.objectStore(STORES.lineItems);
    for (const i of items) {
      store.add({
        transactionId: txnId,
        qty: Number(i.qty),
        price: Number(i.price),
        discount: String(i.discount || ''),
      });
    }
  }

  /** The raw {qty, price, discount} lines of a transaction, in order. */
  async getLineItems(txnId) {
    const idx = this._tx(STORES.lineItems)
      .objectStore(STORES.lineItems)
      .index('transactionId');
    const rows = await req(idx.getAll(IDBKeyRange.only(txnId)));
    return rows
      .sort((a, b) => a.id - b.id)
      .map((r) => ({
        qty: Number(r.qty),
        price: Number(r.price),
        discount: String(r.discount || ''),
      }));
  }

  /** Swap a transaction's line items for a new set. */
  async replaceLineItems(txnId, items) {
    const keys = await req(
      this._tx(STORES.lineItems)
        .objectStore(STORES.lineItems)
        .index('transactionId')
        .getAllKeys(IDBKeyRange.only(txnId))
    );
    const tx = this._tx(STORES.lineItems, 'readwrite');
    const store = tx.objectStore(STORES.lineItems);
    for (const k of keys) store.delete(k);
    this._putLineItems(tx, txnId, items);
    await done(tx);
  }

  /** Edit any subset of a transaction's fields by key. */
  async updateTransaction(txnId, fields) {
    const tx = this._tx(STORES.transactions, 'readwrite');
    const store = tx.objectStore(STORES.transactions);
    const rec = await req(store.get(txnId));
    if (rec) {
      if (fields.total !== undefined) rec.total = Number(fields.total);
      if (fields.seqNo !== undefined) rec.seqNo = Number(fields.seqNo);
      if (fields.createdAt !== undefined) rec.createdAt = String(fields.createdAt);
      if (fields.saleDate !== undefined) rec.saleDate = String(fields.saleDate);
      store.put(rec);
    }
    await done(tx);
  }

  /**
   * Remove a single transaction and its lines.
   *
   * Other rows keep their seqNo — the visible numbers are historical, so
   * gaps after a delete are expected and intentional.
   */
  async deleteTransaction(txnId) {
    const tx = this._tx([STORES.transactions, STORES.lineItems], 'readwrite');
    this._deleteTxnsIn(tx, [txnId]);
    await done(tx);
  }

  /**
   * Empty one log and reset its sequence counter.
   *
   * Deleting the log's rows takes its max seqNo back to 0, so the next
   * sale in this log starts again at 1. Other logs are untouched.
   */
  async clearTransactions(logId) {
    const ids = await this._txnIdsForLog(logId);
    const tx = this._tx([STORES.transactions, STORES.lineItems], 'readwrite');
    this._deleteTxnsIn(tx, ids);
    await done(tx);
  }

  /**
   * Delete transactions + their line items inside an open transaction.
   * IndexedDB has no cascade, so the children go by hand — the same shape
   * as _delete_log_contents in the Python layer.
   */
  _deleteTxnsIn(tx, txnIds) {
    const txns = tx.objectStore(STORES.transactions);
    const lines = tx.objectStore(STORES.lineItems).index('transactionId');
    for (const id of txnIds) {
      txns.delete(id);
      const cur = lines.openKeyCursor(IDBKeyRange.only(id));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        tx.objectStore(STORES.lineItems).delete(c.primaryKey);
        c.continue();
      };
    }
  }

  // ----- settings key/value -------------------------------------------

  async getSetting(key, fallback = null) {
    const rec = await req(
      this._tx(STORES.settings).objectStore(STORES.settings).get(key)
    );
    return rec ? rec.value : fallback;
  }

  async allSettings() {
    const rows = await req(
      this._tx(STORES.settings).objectStore(STORES.settings).getAll()
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSetting(key, value) {
    const tx = this._tx(STORES.settings, 'readwrite');
    tx.objectStore(STORES.settings).put({ key, value: String(value) });
    await done(tx);
  }

  // ----- backup / restore ---------------------------------------------

  /**
   * The whole database as a plain object.
   *
   * Browser storage is per-device, so this is how a ledger moves between
   * the phone and the PC (Settings -> Export).
   */
  async exportAll() {
    const [logs, transactions, lineItems, settings] = await Promise.all([
      req(this._tx(STORES.logs).objectStore(STORES.logs).getAll()),
      req(this._tx(STORES.transactions).objectStore(STORES.transactions).getAll()),
      req(this._tx(STORES.lineItems).objectStore(STORES.lineItems).getAll()),
      req(this._tx(STORES.settings).objectStore(STORES.settings).getAll()),
    ]);
    return {
      format: 'tokotally-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      logs,
      transactions,
      lineItems,
      settings,
    };
  }

  /**
   * Replace everything with a previously exported payload.
   *
   * Destructive by design (it is a restore, not a merge), so the caller
   * confirms first. Keys are preserved so the transaction/line-item
   * relationships survive the round trip.
   */
  async importAll(data) {
    if (!data || data.format !== 'tokotally-backup') {
      throw new Error('Not a TokoTally backup file');
    }
    const names = [
      STORES.logs,
      STORES.transactions,
      STORES.lineItems,
      STORES.settings,
    ];
    const tx = this._tx(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    for (const r of data.logs || []) tx.objectStore(STORES.logs).put(r);
    for (const r of data.transactions || []) {
      tx.objectStore(STORES.transactions).put(r);
    }
    for (const r of data.lineItems || []) tx.objectStore(STORES.lineItems).put(r);
    for (const r of data.settings || []) tx.objectStore(STORES.settings).put(r);
    await done(tx);
    await this._ensureDefaultLog();
  }
}
