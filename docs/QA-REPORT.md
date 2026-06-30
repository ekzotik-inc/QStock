# QStock — QA Report

Full pass over every feature: user stories derived from code, tested, errors
fixed, and re-tested.

## Canonical tracker
`docs/feature-tracker.csv` — 79 user stories across Auth, Users, SKU, Points,
Shifts, Inventory, Analytics, Movements, Audit, Notifications, Realtime, UX.
All currently **Verified / PASS**.

## Test suites (reproducible)
- `npm run test:api`   — 75 HTTP integration checks (`tests/run.js`)
- `npm run test:ui`    — 12 real-browser checks via Playwright (`tests/ui.js`)
- `npm run test:sched` — 2 scheduler checks (`tests/scheduler.js`)

Each suite is run against a throwaway database. Start a server pointed at a
temp `QSTOCK_DB` on a free port, then run with `BASE=http://localhost:PORT`.

Final result: **API 75/75, UI 12/12, scheduler 2/2 — 89 checks, 0 failures.**

## Bugs found and fixed

### BUG-1 (UX, high) — Shift board unreachable in the browser
`renderShell()` reset `App.route` to the first sidebar item whenever the route
was not itself a nav entry. The shift-detail view (`shift`) is never a nav
entry, so opening a shift — the core SE screen, and admin/BRE "Открыть смену" —
bounced straight back to the dashboard. API tests passed because they don't
render the SPA.
**Fix:** added a `DETAIL_ROUTES` allowlist so non-nav detail routes render.
Verified by `UI-SE-SHIFT-BOARD`.

### BUG-2 (logic/runtime, medium) — Crash on realtime refresh during re-render
`viewShift`'s `load()` bound buttons via document-scoped `$('#backBtn')`. Since
`load()` re-runs on every realtime event, a refresh racing with a re-render
(e.g. closing a shift) wrote into a detached view and the document lookup
returned `null` → `TypeError: Cannot set properties of null (setting 'onclick')`.
**Fix:** scoped the lookups to the captured view container and null-guarded
them. Verified by `UI-NO-JS-ERRORS`.

## Test-harness issues corrected (not app bugs)
- SHF-15 needed an actual open shift present to assert the reopen-conflict.
- USER-02/04 required unique logins to be idempotent across reruns.
- Pre-login `GET /api/auth/me` returns 401 by design (session probe); excluded
  from the JS-error gate.

## Known accepted behaviour (not defects)
- A sale may drive current stock negative when morning opening was not entered
  (legitimate in summary-sales mode). Left permissive by design.
