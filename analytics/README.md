# analytics/

This folder holds **experimental analytical queries**, not production dashboard
metrics or proven business rules.

## What this is

Read-only SQL exploring questions against the `analytics_item_lifecycle` view
(see `supabase/migrations/20260723000000_analytics_item_lifecycle.sql`). Files
here are analysis notebooks in SQL form — a way to ask a business question,
look at the numbers, and record the caveats, before anything gets built on top
of them.

## What this is not

- Not a source of truth. Nothing here has been reviewed enough to drive
  pricing, buying, or listing decisions on its own.
- Not wired into the app. No UI, API route, RPC, or AI integration reads from
  these files. They are run manually (SQL Editor / `psql`) against the
  database.
- Not a migration. Files here create no database objects — they only `SELECT`
  from existing views.

## Files

Reusable numbered analysis sequence, under `analytics/sql/`:

- `sql/01_acquisition_value_band_performance.sql` — profit/ROI/DOM/holding
  performance grouped by Acquisition Value Band, plus category, user, and
  acquisition-method robustness checks.
- `sql/02_acquisition_to_exit_analysis.sql` — value movement from
  acquisition_value to exit_value: Acquisition Value Band performance,
  the Acquisition Value Band → Exit Value Band transition matrix, and
  acquisition-method × exit-method breakdowns, including Purchase Price
  Band and Sale Price Band sections. Does not compute holding time — see
  its own header and `analytics/SEMANTIC_CONTRACT.md`.
- `sql/03_brand_performance.sql` — the same profit/ROI/DOM/holding
  methodology as file 01, grouped by brand instead of acquisition value.

One-off scripts (not part of the reusable numbered sequence), under
`analytics/audits/`:

- `audits/historical_import_audit.sql` — one-off, read-only audit of
  Historical Import deal/item edge cases, predates the numbered Phase 1
  analysis sequence above. Moved out of `sql/` because it previously
  shared the `02_` prefix with `02_acquisition_to_exit_analysis.sql`; that
  collision is now resolved by directory, not by number.

## Persistence: analytics_runs (Phase 2 Step 1)

`public.analytics_runs` (`supabase/migrations/20260727000000_analytics_runs.sql`)
records one execution of the analytics autorunner and holds its versioned
JSON snapshot once complete. **No autorunner, orchestrator, API route,
frontend UI, or scheduled job exists yet** — this migration is persistence
and a status contract only. Nothing currently writes to this table; a
future controlled server-side runner will.

Status lifecycle (`status` column, enforced by a table CHECK constraint,
not a trigger):

```
pending → running → completed
                  ↘ failed
```

- `pending` — row created, nothing has run yet (`started_at`/`completed_at`/
  `duration_ms`/`snapshot`/`error_message` all NULL).
- `running` — execution started (`started_at` set; everything that only
  makes sense once finished stays NULL).
- `completed` — finished successfully (`started_at`/`completed_at`/
  `snapshot` all set; `error_message` NULL).
- `failed` — finished unsuccessfully (`started_at`/`completed_at`/
  `error_message` all set).

`snapshot` is versioned by `analytics_version` (the analytical definition
version, e.g. `'1.0'` — not this app's release version), so a future reader
can tell which snapshot shape it's looking at. `snapshot`'s JSON structure
is not enforced by the database yet — that's a later phase.

Every run has both a `requested_by_user_id` (who triggered it) and a
`recommendation_target_user_id` (whose open Business items may appear as
recommendation candidates in the snapshot) — usually the same person today,
but the schema doesn't force that. Item-level recommendation data in a
future snapshot is always scoped to `recommendation_target_user_id` only;
evidence aggregates may be computed over the full shared Business
population. See `analytics/SEMANTIC_CONTRACT.md` sections 9-12 for the full
evidence/recommendation/developer-verification boundary this table is built
to respect.

RLS: an authenticated user may `SELECT` a run where they are the requester
or the target; no `authenticated` INSERT/UPDATE/DELETE policy exists, so
direct client writes are denied.

## Conventions

- One file per analysis, numbered (`01_`, `02_`, ...) in the order they were
  written, under `analytics/sql/`. One-off, non-reusable scripts (audits,
  one-time investigations) live under `analytics/audits/` instead, unnumbered,
  so they never compete for a prefix with the reusable sequence.
- Every query in a file is independently runnable — copy-paste any single
  query out and it should execute on its own, with no dependency on another
  query having run first.
- Every query is read-only (`SELECT` only) and reads from `analytics_item_lifecycle`.
- Medians (`PERCENTILE_CONT(0.5)`) are treated as the primary summary
  statistic; averages are included alongside them but are more easily skewed
  by a handful of unusually cheap/expensive/profitable items.
- Sample sizes are always shown next to any aggregate. A median computed over
  3 items is not a conclusion — it's a data point that needs more items before
  it means anything.
- Findings from these files are associations, not causation, until stated
  otherwise (and probably not even then).
- Terminology: use "Acquisition Value Band" / "Exit Value Band" for
  groupings that include both cash and trade items; reserve "Purchase Price
  Band" / "Sale Price Band" for populations explicitly filtered to cash-only
  purchases/sales. Never write "price band" as a generic term — see
  `analytics/SEMANTIC_CONTRACT.md` for the full definitions and
  `analytics/sql/01_acquisition_value_band_performance.sql` for the
  reference implementation.

## Before treating anything here as a real finding

Check the file's own header comment for its specific limitations, then ask:
does the pattern survive the file's own robustness/sensitivity checks (outlier
exclusion, imported-historical-vs-app-tracked cohort comparison, per-user
breakdown), or does it disappear the moment you slice the data a different
way? Note that "imported historical vs. app-tracked" is a COHORT comparison,
not a data-reliability test — see analytics/SEMANTIC_CONTRACT.md. Historical
imports remain included in profit/ROI/DOM/realization metrics throughout;
only acquisition-date-derived metrics (holding time, ownership age,
acquisition-to-listing delay) exclude them.
