/**
 * The settings drawer — the web port of qml/SettingsDrawer.qml, plus the
 * backup pair the desktop app does not need.
 *
 * Every control writes straight through to the settings store, which
 * persists each change, so edits are live and durable. Backup exists
 * because browser storage is per-device: export is how a ledger moves
 * from the phone to the PC.
 */

import { confirmAction } from './common.js';

const ACCENTS = ['#2dd4bf', '#f59e0b', '#60a5fa', '#a78bfa', '#f472b6'];

export class SettingsDrawer {
  constructor({ settings, db, refs, onChanged, onRestored, onToast }) {
    this.settings = settings;
    this.db = db;
    this.refs = refs;
    this.onChanged = onChanged;
    this.onRestored = onRestored;
    this.onToast = onToast;
  }

  init() {
    const { refs, settings } = this;

    refs.themeDark.addEventListener('click', () => settings.setDarkMode(true));
    refs.themeLight.addEventListener('click', () => settings.setDarkMode(false));
    refs.discOn.addEventListener('click', () => settings.setDiscountEnabled(true));
    refs.discOff.addEventListener('click', () =>
      settings.setDiscountEnabled(false)
    );
    refs.decMinus.addEventListener('click', () =>
      settings.setDecimals(settings.decimals - 1)
    );
    refs.decPlus.addEventListener('click', () =>
      settings.setDecimals(settings.decimals + 1)
    );
    refs.currencyField.addEventListener('change', () =>
      settings.setCurrency(refs.currencyField.value)
    );
    refs.settingsClose.addEventListener('click', () => this.close());
    refs.settingsDialog.addEventListener('cancel', (e) => {
      // Let the app's own Esc handling decide; just close cleanly.
      e.preventDefault();
      this.close();
    });

    for (const color of ACCENTS) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'swatch';
      dot.style.background = color;
      dot.setAttribute('aria-label', `Accent ${color}`);
      dot.addEventListener('click', () => settings.setAccent(color));
      dot.dataset.color = color;
      refs.swatches.append(dot);
    }

    refs.exportBtn.addEventListener('click', () => this.exportBackup());
    refs.importBtn.addEventListener('click', () => refs.importFile.click());
    refs.importFile.addEventListener('change', () => this.importBackup());

    settings.on('changed', () => this.render());
    this.render();
  }

  open() {
    this.refs.settingsDialog.showModal();
    this.render();
  }

  close() {
    this.refs.settingsDialog.close();
  }

  get isOpen() {
    return this.refs.settingsDialog.open;
  }

  /** Reflect current values onto the controls (selected state included). */
  render() {
    const { refs, settings } = this;
    refs.themeDark.classList.toggle('btn--accent', settings.darkMode);
    refs.themeLight.classList.toggle('btn--accent', !settings.darkMode);
    refs.discOn.classList.toggle('btn--accent', settings.discountEnabled);
    refs.discOff.classList.toggle('btn--accent', !settings.discountEnabled);
    refs.decValue.textContent = String(settings.decimals);
    if (document.activeElement !== refs.currencyField) {
      refs.currencyField.value = settings.currency;
    }
    refs.moneyPreview.textContent = `Preview:  ${settings.money(1250000)}`;
    for (const dot of refs.swatches.children) {
      dot.classList.toggle('swatch--on', dot.dataset.color === settings.accent);
    }
    this.onChanged();
  }

  async exportBackup() {
    const data = await this.db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `tokotally-${stamp}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has taken the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.onToast('Backup exported');
  }

  async importBackup() {
    const file = this.refs.importFile.files?.[0];
    // Clear the picker either way so re-choosing the same file re-fires.
    this.refs.importFile.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      this.onToast('That file is not valid JSON');
      return;
    }
    const ok = await confirmAction({
      title: 'Replace all data?',
      body:
        'Importing a backup deletes every log and sale currently stored in ' +
        'this browser and replaces them with the file’s contents. This ' +
        'cannot be undone.',
      okLabel: 'Replace',
    });
    if (!ok) return;
    try {
      await this.db.importAll(data);
    } catch (err) {
      this.onToast(err.message || 'Import failed');
      return;
    }
    await this.onRestored();
    this.onToast('Backup restored');
  }
}
