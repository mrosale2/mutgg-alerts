# Session log — mutgg-alerts

## 2026-05-17 — 1-min cron + program-watches design

Resumed work on the always-on Cloudflare Worker after a 5-day pause. Production check confirmed cron firing and KV state healthy (5 GT watches, no errors). Dropped the cron interval from 2 min to 1 min (deployed live, verified via tail). Refreshed stale doc references to the old cadence and the obsolete fingerprint-based dedup model (the rule has been `lastAlertedPrice`-based for a while). Confirmed the Workers Paid plan was already active and re-scoped the worker limits accordingly.

Then brainstormed → spec'd → planned a new **program-wide watch** feature: a single watch covers every card in a mut.gg program (e.g. Golden Ticket, 18 cards) at a per-card **percent-off-median** target, with a daily cron refreshing program membership. Did a Playwright spike to confirm the parsing approach: program pages are slug-routed (`/programs/golden-ticket/`), the player list is in the HTML, and the existing bulk-medians endpoint accepts comma-separated externalId lists. Wrote an 11-task TDD implementation plan with full code blocks and real-fixture parser tests. Paused at the plan stage — execution deferred.

Also flagged a quiet bug for separate handling: the `recurring` flag on per-player watches is stored and displayed but never read by the alert rule (ONE-SHOT and RECURRING behave identically today).

Main artifacts:
- Spec: [docs/superpowers/specs/2026-05-17-mutgg-alerts-program-watches.md](docs/superpowers/specs/2026-05-17-mutgg-alerts-program-watches.md)
- Plan: [docs/superpowers/plans/2026-05-17-mutgg-alerts-program-watches.md](docs/superpowers/plans/2026-05-17-mutgg-alerts-program-watches.md)
- Live URL (unchanged): https://mutgg-alerts.mrosale2.workers.dev/

Commits this session (all on local `main`, not yet pushed):
- `857d0ba` docs(worker): describe actual lastAlertedPrice alert rule
- `8707ed0` feat(worker): drop poll interval from 2 min to 1 min
- `7c1fa88` docs(spec): program-wide watches design
- `acb6989` docs(plan): program-wide watches implementation plan
