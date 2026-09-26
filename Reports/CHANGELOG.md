# GoaTrip — Changelog

_2026-09-26_

## Account menu visibility (`goa-wallet.html`)
- Moved the "Signed in as / Back to trip site / Admin sign-in / Log out" block from the bottom of the sidebar (where `margin-top:auto` pinned it off-screen, at 11px and near-invisible opacity) to the top, right under the logo.
- Bumped its text contrast so it's actually readable against the dark sidebar.

## PWA install icon (`icons/*.png`)
- Regenerated `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, and `apple-touch-icon.png` from `logo-icon.png` (the lotus mark), replacing the old placeholder icon set. Same filenames/sizes, so no manifest or HTML changes needed.
- Root cause of "still shows the generic 'G' icon" turned out to be `manifest.webmanifest` returning a 404 on the live site (not an icon problem at all) — once that file was actually deployed, the install picked up the new icon correctly.
- `sw.js`: bumped `CACHE_NAME` from `goatrip-static-v1` → `v2` so the service worker's own Cache Storage would purge the old cached icons instead of continuing to serve them indefinitely.

## Wallet not syncing without 2–3 manual refreshes
Three layers, all making the same GET request (`/wallet?tripId=&token=`, identical URL for up to 12h per session) explicitly non-cacheable:
- **`goa-wallet.html`** — the fetch call now uses `cache:'no-store'`.
- **`netlify.toml`** — added a `Cache-Control: no-store` header rule for `/.netlify/functions/*`.
- **`http.js`** — the shared `json()` response helper now sets `Cache-Control: no-store` on every function response (wallet, admin, login, registration, etc.), so this is guaranteed at the source regardless of the other two layers.

## "Average spend / person" stuck on `₹NaN` (`goa-wallet.html`)
- Root cause: `avg = total / PARTICIPANTS.length` could momentarily evaluate to `NaN` on an early render (e.g. before participants had loaded), and the counter's `animateValue()` helper stored that `NaN` in `dataset.rawval` — every future call then interpolated **from** that poisoned value (`NaN + (validNumber - NaN)` is still `NaN`), so the display stayed stuck even once the real value was fine.
- Fix: guarded the average calculation (`PARTICIPANTS.length ? total/PARTICIPANTS.length : 0`) and made `animateValue()` fall back to `0` whenever either its start or end value isn't finite, so a bad frame self-heals instead of poisoning every render after it.

## Live auto-refresh (`goa-wallet.html`, `admin.html`)
Added silent background polling so changes made by one person show up for everyone else without a manual reload:
- Both pages now silently re-fetch every **5 seconds** while the tab is open and visible, and immediately again when the tab regains focus.
- **Guarded against interrupting the user** — a poll is skipped entirely whenever:
  - the tab isn't visible, or
  - any input/textarea/select/contenteditable is currently focused anywhere on the page (not just inside a modal) — so an in-progress edit is never silently overwritten.
- **No visible flicker** — `goa-wallet.html`'s poll now compares the freshly-fetched wallet data against what's already on screen and only re-renders when something actually changed, so identical polls (the vast majority) are completely invisible.
  - _Known gap:_ `admin.html`'s 8 dashboard loaders don't yet have the same change-detection, so its lists can still flicker on a poll even with no real change — not fixed in this pass.

## Files touched this session
`goa-wallet.html`, `admin.html`, `netlify.toml`, `http.js`, `sw.js`, `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon-maskable-512.png`, `icons/apple-touch-icon.png`
