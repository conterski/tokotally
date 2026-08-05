# TokoTally — web

A browser build of the TokoTally desktop app. Same sale entry, same
ledger, same money rules — laid out for a PC and for an iPhone.

No build step, no framework, no dependencies. Plain ES modules, plain
CSS, and IndexedDB for storage.

## Running it

Browsers block IndexedDB and ES modules on `file://` pages, so it has to
come off an http server even locally:

```bash
python serve.py
```

That prints two addresses — one for this PC, one for your phone on the
same Wi-Fi. Open either.

To use it on an iPhone: open the phone address in Safari, then
**Share → Add to Home Screen**. It launches full-screen with no browser
chrome.

> Offline caching (the service worker) only activates in a secure
> context — `localhost` or an https host. Over a plain-http LAN address
> the app works fine, it just isn't cached for offline use. To get
> offline on the phone, host the folder anywhere with https.

## Layout

One DOM, two layouts, switching at 900px.

**PC** — the desktop app's two-pane split: the sale on the left (60%),
the ledger on the right (40%), line items as a real table. The whole UI
is scaled off the window against a 1100x720 reference, the same
proportional sizing `Theme.uiScale` does in the Qt app.

**iPhone** — the panes stack into one column with a bottom tab bar. Each
line item stays on a single line, scaled down to fit a 320px screen with
the discount column on: the ×1000 hint is dropped (the Line Total beside
it already shows the money), and the Line Total column has a `ch`-based
floor so figures line up across rows without ever being truncated. The
bottom bar
stacks its total above two full-width buttons. Touch targets are at
least 32–46px, inputs are 16px so iOS doesn't zoom on focus, and the
layout tracks `visualViewport` so the Grand Total and Complete Sale
button stay above the soft keyboard.

Safe-area insets are honoured, so the notch and home indicator don't
overlap anything.

## Number pad (touch only)

On a touch device the line-item fields set `inputmode="none"`, so iOS
never raises its own keyboard; a built-in pad takes its place, docked
under the Grand Total so the running figure stays visible while typing.
It replaces the tab bar while open, the way a system keyboard would.

```
7 8 9 ⌫
4 5 6 ±
1 2 3 ⏎
. 0 0 ⏎
```

The fourth-column key adapts to the focused field, offering the one
non-digit character that field accepts: `−` on Qty (so returns and
refunds are still enterable), `+` on Discount (for chains like `10+5`),
and disabled on Price, which takes digits only. Backspace is there
because without it a mistyped figure could not be corrected.

Keys write through the same path a keystroke takes — validate against
the field's own pattern, set, dispatch `input` — and Enter dispatches a
real Enter keydown, so the whole Enter flow is reused rather than
reimplemented. A device with a physical keyboard never sees the pad and
keeps `inputmode="decimal"`.

**Showing and hiding.** Tapping any line-item field opens the pad, and a
**Show/Hide numpad** button above Complete Sale dismisses or restores it
by hand. Hiding also blurs the field, so tapping that same input again
brings the pad straight back — otherwise a field that still held focus
could never reopen it. Restoring returns to the field you were last in.

Anything that moves focus reopens the pad, so completing a sale — which
refocuses the first Qty — leaves you ready to type the next one. The
sale pane tells the pad directly when it moves focus rather than relying
on the focus event alone, since iOS is choosy about honouring a
programmatic `focus()` outside a user gesture.

## Keyboard

Unchanged from the desktop app. `Enter` walks Qty → Price → next line
(creating it as it goes); `Enter` on the last line's empty Price
completes the sale; `Shift+Enter` walks back; `Ctrl+Enter` completes
from anywhere; arrows move around the grid; `3*80` types a whole line in
one field; `Esc` clears with undo; `?` or `F1` shows the cheatsheet.

## Storage

Everything lives in IndexedDB in the browser, which means **per-device,
per-browser** — the phone and the PC keep separate ledgers, and neither
sees the desktop app's SQLite file.

Settings → **Export** writes a JSON backup; **Import** replaces
everything in that browser with a backup's contents. That is how a
ledger moves between devices.

## Layout of the code

```
index.html            markup + the SVG icon sprite
css/theme.css         design tokens (port of qml/Theme.qml)
css/app.css           layout and components, both breakpoints
js/core.js            money/date rules (port of backend/{constants,discounts,dates}.py)
js/db.js              IndexedDB layer (port of backend/database.py)
js/store.js           view-models (port of backend/*_viewmodel.py, settings.py)
js/ui/common.js       toast, popup menus, modal dialogs
js/ui/salepane.js     sale entry     (port of SalePane.qml + LineItemRow.qml)
js/ui/ledgerpane.js   ledger         (port of LedgerPane.qml)
js/ui/numpad.js       in-app number pad for touch devices
js/ui/settings.js     settings drawer (port of SettingsDrawer.qml) + backup
js/ui/tween.js        number easing for the money readouts
js/app.js             bootstrap, theme, scale, shortcuts (port of Main.qml)
sw.js                 offline caching
serve.py              local/LAN dev server
```

## Tests

`tools/gen_fixture.py` runs the **real Python backend** over a spread of
inputs and writes what it produces to `tests/fixture.json`.
`tests/tests.html` then asserts the JavaScript agrees, case for case —
so the two implementations can't quietly drift on discount chains, date
parsing, or the ×1000 price rule.

```bash
python tools/gen_fixture.py
python serve.py
# then open http://localhost:8000/tests/tests.html
```

Regenerate the fixture whenever the Python rules change.

## Deliberate differences from the desktop app

- **Accent button text stays dark in both themes.** The Qt app paints it
  in `Theme.bg`, which in light mode is near-white on a mid-tone accent
  (~1.8:1). Every accent in the palette is light enough that dark text is
  the readable choice either way.
- **Export/import exists here and not there.** The desktop app has one
  SQLite file you can copy; browser storage needs an explicit way out.
- **No window-geometry persistence** — not a thing on the web.
