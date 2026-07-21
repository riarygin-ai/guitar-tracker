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

## Conventions

- One file per analysis, numbered (`01_`, `02_`, ...) in the order they were
  written, under `analytics/sql/`.
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

## Before treating anything here as a real finding

Check the file's own header comment for its specific limitations, then ask:
does the pattern survive the file's own robustness/sensitivity checks (outlier
exclusion, Historical Import exclusion, per-user breakdown), or does it
disappear the moment you slice the data a different way?
