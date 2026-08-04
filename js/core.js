/**
 * Pure business rules, ported 1:1 from the desktop backend.
 *
 * Everything here mirrors backend/constants.py, backend/discounts.py and
 * backend/dates.py. These are the rules a sale's money depends on, so
 * they are kept together, free of DOM/storage concerns, and covered by
 * tests.js against the same cases the Python suite uses.
 */

// The Price/Unit field is interpreted in thousands: the entered value is
// multiplied by this before any math. One source of truth, exactly as in
// backend/constants.py.
export const PRICE_MULTIPLIER = 1000;

// Default quantity for a fresh line, so a price alone yields a total.
export const DEFAULT_QTY = 1;

/**
 * Multiplicative factor for a '+'-separated percent chain.
 *
 * "10+5" -> 0.9 * 0.95. A comma is accepted as a decimal separator
 * (matching the number fields). Blank or unparseable parts are skipped;
 * a blank chain yields 1.0, so a line with no discount is left alone.
 */
export function discountFactor(text) {
  let factor = 1.0;
  for (const raw of String(text ?? '').replace(/,/g, '.').split('+')) {
    const part = raw.trim();
    if (!part) continue;
    const pct = Number(part);
    // Number('') is 0 and Number('1 2') is NaN — mirror Python's float()
    // by skipping anything that isn't a clean number.
    if (!Number.isFinite(pct)) continue;
    factor *= (100.0 - pct) / 100.0;
  }
  return factor;
}

/** qty x (price x 1000) x discount-chain factor — the one line-total rule. */
export function lineTotal(item) {
  return (
    Number(item.qty || 0) *
    Number(item.price || 0) *
    PRICE_MULTIPLIER *
    discountFactor(item.discount || '')
  );
}

// Accepted date inputs, tried in order — the same set backend/dates.py
// hands to strptime. The ISO form requires a 4-digit year so a string
// like "24-01-02" reads as dd-mm-yy rather than the year 24.
const DATE_FORMATS = [
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: 'ymd' },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: 'dmy' },
  { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: 'dmy' },
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, order: 'dmy2' },
  { re: /^(\d{1,2})-(\d{1,2})-(\d{2})$/, order: 'dmy2' },
];

/** Python's %y window: 00-68 -> 2000s, 69-99 -> 1900s. */
function expandTwoDigitYear(yy) {
  return yy <= 68 ? 2000 + yy : 1900 + yy;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/**
 * Normalise a typed date to ISO YYYY-MM-DD.
 *
 * Returns "" for blank input (the date is optional), the ISO string for a
 * recognised date, or null when the text is non-empty but unparseable —
 * which is what blocks completion and lights the field red.
 */
export function parseUserDate(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  for (const { re, order } of DATE_FORMATS) {
    const m = t.match(re);
    if (!m) continue;
    let y, mo, d;
    if (order === 'ymd') {
      [y, mo, d] = [+m[1], +m[2], +m[3]];
    } else {
      [d, mo, y] = [+m[1], +m[2], +m[3]];
      if (order === 'dmy2') y = expandTwoDigitYear(y);
    }
    // strptime rejects impossible dates (31/02); Date silently rolls them
    // over, so verify the parts survived the round trip.
    const dt = new Date(y, mo - 1, d);
    if (
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== d
    ) {
      return null;
    }
    return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

/** ISO YYYY-MM-DD -> dd/mm/yyyy for display; '' stays ''. */
export function formatDateDisplay(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** "YYYY-MM-DD HH:MM:SS" -> "HH:MM"; anything else passes through. */
export function formatTime(createdAt) {
  const m = String(createdAt ?? '').match(/^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : String(createdAt ?? '');
}

/** Local "YYYY-MM-DD HH:MM:SS", matching the desktop timestamp format. */
export function nowStamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Local calendar day as ISO YYYY-MM-DD (the Today KPI's "today"). */
export function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A sale's effective date: the user-entered sale date when set, else the
 * day it was logged. Mirrors the CASE expression in Database.today_total.
 */
export function effectiveDate(record) {
  const sd = record.saleDate || '';
  return sd || String(record.createdAt || '').slice(0, 10);
}

// Indonesian convention ('.' groups thousands, ',' decimals), the same
// locale the desktop app formats through. Formatters are cached because
// building one per binding is the expensive part.
const fmtCache = new Map();

function numberFormatter(decimals) {
  let f = fmtCache.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('id-ID', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    fmtCache.set(decimals, f);
  }
  return f;
}

/** Format a bare number to the configured decimals. */
export function formatNumber(value, decimals) {
  const n = Number(value);
  return numberFormatter(decimals).format(Number.isFinite(n) ? n : 0);
}

/** Format money: the currency symbol (when set) plus the number. */
export function formatMoney(value, decimals, currency) {
  const prefix = currency ? `${currency} ` : '';
  return prefix + formatNumber(value, decimals);
}

/**
 * Parse a number the way the input fields do: blank/garbage is 0 and a
 * comma reads as a decimal point.
 */
export function parseField(s) {
  const n = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isNaN(n) ? 0 : n;
}
