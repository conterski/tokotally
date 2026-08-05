/**
 * Application entry point — the web port of qml/Main.qml.
 *
 * Wires the IndexedDB layer to the stores, hands them to the two panes,
 * and owns everything that is global: the theme, the responsive scale,
 * the keyboard shortcuts, the phone tab switcher, and the viewport
 * bookkeeping iOS needs when the soft keyboard opens.
 */

import { Database } from './db.js';
import { LedgerStore, LogsStore, SaleStore, SettingsStore } from './store.js';
import {
  $,
  anyDialogOpen,
  closeMenu,
  dismissToast,
  el,
  isMenuOpen,
  showToast,
} from './ui/common.js';
import { LedgerPane } from './ui/ledgerpane.js';
import { Numpad } from './ui/numpad.js';
import { SalePane } from './ui/salepane.js';
import { SettingsDrawer } from './ui/settings.js';

const root = document.documentElement;

// Every element the UI touches, resolved once.
const refs = {
  app: $('#app'),
  // sale pane
  saleTitle: $('#saleTitle'),
  saleSubtitle: $('#saleSubtitle'),
  dateField: $('#dateField'),
  settingsBtn: $('#settingsBtn'),
  itemsScroll: $('#itemsScroll'),
  itemRows: $('#itemRows'),
  grandTotal: $('#grandTotal'),
  clearBtn: $('#clearBtn'),
  clearBtnLabel: $('#clearBtnLabel'),
  completeBtn: $('#completeBtn'),
  completeBtnLabel: $('#completeBtnLabel'),
  // ledger pane
  logPicker: $('#logPicker'),
  logName: $('#logName'),
  copyBtn: $('#copyBtn'),
  clearLogBtn: $('#clearLogBtn'),
  kpiCount: $('#kpiCount'),
  kpiToday: $('#kpiToday'),
  logScroll: $('#logScroll'),
  logRows: $('#logRows'),
  logEmpty: $('#logEmpty'),
  runningTotal: $('#runningTotal'),
  numpad: $('#numpad'),
  numpadToggle: $('#numpadToggle'),
  // tabs
  tabSale: $('#tabSale'),
  tabLedger: $('#tabLedger'),
  tabSaleTotal: $('#tabSaleTotal'),
  tabLedgerCount: $('#tabLedgerCount'),
  // settings
  settingsDialog: $('#settingsDialog'),
  themeDark: $('#themeDark'),
  themeLight: $('#themeLight'),
  discOn: $('#discOn'),
  discOff: $('#discOff'),
  flowRow: $('#flowRow'),
  flowColumn: $('#flowColumn'),
  flowNote: $('#flowNote'),
  swatches: $('#swatches'),
  decMinus: $('#decMinus'),
  decPlus: $('#decPlus'),
  decValue: $('#decValue'),
  currencyField: $('#currencyField'),
  moneyPreview: $('#moneyPreview'),
  exportBtn: $('#exportBtn'),
  importBtn: $('#importBtn'),
  importFile: $('#importFile'),
  settingsClose: $('#settingsClose'),
  // help
  helpDialog: $('#helpDialog'),
  helpClose: $('#helpClose'),
  keysList: $('#keysList'),
};

/** The cheatsheet, whose Enter rows depend on the chosen entry flow. */
function shortcutRows(entryFlow) {
  const enter =
    entryFlow === 'column'
      ? [
          ['Enter', 'Walk down the column you are in'],
          ['Enter on empty Qty', 'Jump across to the Price column'],
          ['Enter on empty Price', 'Complete the sale'],
          ['Shift+Enter', 'Back up the same column'],
        ]
      : [
          ['Enter', "Next field; on the last line's empty Price, complete the sale"],
          ['Shift+Enter', 'Jump back to the previous field'],
        ];
  return [
    ...enter,
    ['Ctrl+Enter', 'Complete the sale from anywhere'],
    ['3 * 80', 'Quantity × price in one field (also 3x80)'],
    ['↑  ↓', 'Move between line rows'],
    ['←  →', 'Move between Qty and Price at a field edge'],
    ['Tab', 'Next field'],
    ['Esc', 'Clear the entry (with undo) · close a dialog'],
    ['?  /  F1', 'Show or hide this help'],
  ];
}

async function main() {
  const db = await Database.open();
  const settings = await SettingsStore.load(db);
  const ledger = new LedgerStore(db);
  const logs = await LogsStore.create(db, ledger);
  const sale = new SaleStore(ledger);

  const toast = (msg, undo) => showToast(msg, undo);

  // Touch devices get the in-app number pad instead of the OS keyboard.
  const touch = isTouch();

  const salePane = new SalePane({
    sale,
    settings,
    refs,
    useNumpad: touch,
    onOpenSettings: () => drawer.open(),
    onToast: toast,
    // Keeps the pad on the field this pane just moved to — notably the
    // first Qty after a sale is completed.
    onFieldFocused: (field) => numpad.attach(field),
  });
  const ledgerPane = new LedgerPane({
    ledger,
    logs,
    sale,
    settings,
    refs,
    onToast: toast,
  });
  const drawer = new SettingsDrawer({
    settings,
    db,
    refs,
    onToast: toast,
    onChanged: () => {
      applyTheme(settings);
      salePane.refresh();
      ledgerPane.refresh();
      // The cheatsheet's Enter rows describe the chosen flow.
      buildHelp(settings.entryFlow);
    },
    // A restore replaces every store's contents, so re-hydrate from disk
    // rather than trying to patch the in-memory state.
    onRestored: async () => {
      const fresh = await SettingsStore.load(db);
      Object.assign(settings, {
        decimals: fresh.decimals,
        currency: fresh.currency,
        accent: fresh.accent,
        darkMode: fresh.darkMode,
        discountEnabled: fresh.discountEnabled,
      });
      await logs.reload();
      settings.emit('changed');
    },
  });

  const numpad = new Numpad({
    container: refs.numpad,
    app: refs.app,
    toggle: refs.numpadToggle,
    enabled: touch,
    onLayoutChange: () => salePane.scrollFocusedIntoView(),
  });

  salePane.init();
  ledgerPane.init();
  drawer.init();
  numpad.init();

  wireHelp();
  buildHelp(settings.entryFlow);
  wireTabs();
  wireShortcuts({ sale, salePane, drawer });
  applyTheme(settings);
  applyScale();
  syncViewportHeight();

  window.addEventListener('resize', () => {
    applyScale();
    syncViewportHeight();
  });
  window.visualViewport?.addEventListener('resize', syncViewportHeight);
  window.visualViewport?.addEventListener('scroll', syncViewportHeight);
  // iOS still reports the pre-rotation size for a moment after the event
  // fires, so measure once more when it has settled.
  window.addEventListener('orientationchange', () => {
    syncViewportHeight();
    setTimeout(syncViewportHeight, 300);
  });

  // Start where the desktop app starts: in the first Qty field. Skipped
  // on touch so a phone doesn't raise the number pad the moment it
  // loads — the same `touch` the pad itself is keyed off, so the two
  // cannot disagree.
  if (!touch) salePane.focusCell(0, 0);

  registerServiceWorker();
}

/** Theme, accent and the browser chrome colour. */
function applyTheme(settings) {
  root.dataset.theme = settings.darkMode ? 'dark' : 'light';
  root.style.setProperty('--accent', settings.accent);
  refs.app.dataset.discounts = settings.discountEnabled ? 'on' : 'off';
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  $('#themeColor')?.setAttribute('content', bg || '#0e1116');
}

/**
 * Proportion the UI to the window, exactly as Main.qml binds
 * Theme.uiScale: the smaller of the width/height ratios against the
 * 1100x720 design reference, clamped so type stays legible when small
 * and doesn't get cartoonish when maximised.
 *
 * Phones opt out — they get the touch-sized layout instead, which has
 * its own fixed minimums for tap targets and 16px inputs.
 */
function applyScale() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale =
    w < 900
      ? 1
      : Math.max(0.75, Math.min(1.5, Math.min(w / 1100, h / 720)));
  root.style.setProperty('--scale', String(scale));
}

/**
 * Keep the app exactly as tall as the *visual* viewport.
 *
 * When iOS opens the soft keyboard the layout viewport does not shrink,
 * so a 100dvh app would put the Grand Total and Complete Sale button
 * behind the keyboard. visualViewport.height is the part actually on
 * screen, so binding to it keeps the bottom bar reachable while typing.
 */
function syncViewportHeight() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  root.style.setProperty('--app-h', `${Math.round(h)}px`);
  // iOS scrolls the page itself to reveal a focused field; with a fixed
  // app shell that only shifts the whole UI, so undo it.
  if (vv && vv.offsetTop === 0 && window.scrollY !== 0) window.scrollTo(0, 0);
}

function buildHelp(entryFlow) {
  const frag = document.createDocumentFragment();
  for (const [key, desc] of shortcutRows(entryFlow)) {
    frag.append(
      el('div', { class: 'keys__row' }, [
        el('span', { class: 'keys__key', text: key }),
        el('span', { class: 'keys__desc', text: desc }),
      ])
    );
  }
  refs.keysList.replaceChildren(frag);
}

function wireHelp() {
  refs.helpClose.addEventListener('click', () => refs.helpDialog.close());
  refs.helpDialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    refs.helpDialog.close();
  });
}

/** Phone-only pane switcher. */
function wireTabs() {
  for (const tab of [refs.tabSale, refs.tabLedger]) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      refs.app.dataset.view = view;
      refs.tabSale.classList.toggle('tab--on', view === 'sale');
      refs.tabLedger.classList.toggle('tab--on', view === 'ledger');
    });
  }
}

function wireShortcuts({ sale, salePane, drawer }) {
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+Enter completes the sale from anywhere.
    if (
      (e.key === 'Enter' || e.key === 'Return') &&
      (e.ctrlKey || e.metaKey) &&
      !anyDialogOpen()
    ) {
      e.preventDefault();
      sale.completeSale();
      return;
    }

    if (e.key === 'Escape') {
      // A dialog handles its own Esc through the native cancel event;
      // stay out of its way so Esc doesn't also clear the entry.
      if (anyDialogOpen()) return;
      if (isMenuOpen()) {
        closeMenu();
        return;
      }
      e.preventDefault();
      dismissToast();
      salePane.clearEntryWithUndo();
      return;
    }

    if (e.key === 'F1' || e.key === '?') {
      // '?' must stay typable in the free-text fields (a log name, the
      // currency symbol); the numeric line fields reject it anyway.
      if (e.key === '?' && (anyDialogOpen() || inFreeTextField())) return;
      e.preventDefault();
      if (refs.helpDialog.open) refs.helpDialog.close();
      else refs.helpDialog.showModal();
    }
  });
}

function inFreeTextField() {
  const active = document.activeElement;
  if (!active || active.tagName !== 'INPUT') return false;
  return !active.closest('.item-row');
}

function isTouch() {
  return window.matchMedia('(pointer: coarse)').matches;
}

function registerServiceWorker() {
  // Service workers need a secure context, so this quietly does nothing
  // over a plain-http LAN address. The app still works; it just isn't
  // cached for offline use there.
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').catch(() => {
    /* offline caching is a bonus, never a requirement */
  });
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    `<div style="padding:24px;font:16px system-ui">` +
    `<h1>TokoTally could not start</h1><p>${String(err)}</p>` +
    `<p>If you opened this file directly, serve it over http instead — ` +
    `browsers block local storage on <code>file://</code> pages.</p></div>`;
});
