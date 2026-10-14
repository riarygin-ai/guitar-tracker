-- MCP read-only analytics tools (get_inventory_analysis, get_lead_activity)
-- need the SAME two authoritative datasets the existing "Copy/Download
-- Analysis Data" export and the /listings "Lead Activity by Item" section
-- already use — build_listing_evidence_v1_0 and
-- listing_demand_item_activity_v1_0 — but MCP's security model is
-- different on purpose: every MCP query runs through withSupabase({auth:
-- 'user'})'s request-scoped, RLS-bound client, never service_role, and
-- never an application-resolved user id (see src/app/api/mcp). Both
-- existing functions are SECURITY INVOKER but TRUST a p_target_user_id
-- PARAMETER rather than deriving identity internally — exactly why they
-- are service_role-only today (every existing caller is a server route
-- that has already independently resolved its own caller's app_users.id
-- and is trusted to pass it correctly; letting `authenticated` call them
-- directly would let any signed-in user request ANY OTHER user's data by
-- simply passing a different id).
--
-- Rather than loosen those functions' trust model (which would be a real,
-- unnecessary risk to the existing export/Lead-Activity-by-Item features),
-- this migration adds two NEW, zero-argument-identity wrapper functions
-- that hard-code the caller's OWN identity via public.get_app_user_id()
-- (which itself resolves from auth.uid() — the same mechanism every RLS
-- policy in this schema already uses) and delegate everything else,
-- unchanged, to the existing function. A caller of these wrappers can
-- only ever read their own data, by construction — there is no parameter
-- through which a different user id could ever be substituted.
--
-- The two existing functions, their signatures, their SECURITY INVOKER
-- property, and their service_role-only grants are completely untouched —
-- this migration is purely additive. Every existing caller
-- (/api/listing-analysis-export, /api/listing-item-activity, /api/leads)
-- is unaffected.

-- ─── 1. build_listing_evidence_v1_0_for_current_user() ─────────────────
-- Self-scoped wrapper for the Listing Evidence snapshot that already
-- powers Copy/Download Analysis Data. No parameters at all — the only
-- identity source is the caller's own JWT (auth.uid() -> get_app_user_id()).
--
-- SECURITY DEFINER (not INVOKER): verified against the actual applied
-- grants before writing this — build_listing_evidence_v1_0 is
-- service_role-only, and under SECURITY INVOKER the authenticated caller's
-- OWN role (not the definer's) is what the nested call is checked against,
-- so authenticated calling this wrapper failed with "permission denied for
-- function build_listing_evidence_v1_0" even though the wrapper itself was
-- granted to authenticated. SECURITY DEFINER runs the wrapper's body (and
-- everything it calls) as the function's owner, which already has EXECUTE
-- on the inner function — safe here specifically because this wrapper
-- takes NO parameters and its only identity source, get_app_user_id(), is
-- itself SECURITY DEFINER and reads auth.uid() from the session's own JWT,
-- never anything the caller can pass in. There is no argument through
-- which the elevated privilege could be redirected at a different user's
-- data. SET search_path pins name resolution, the standard SECURITY
-- DEFINER hardening get_app_user_id() itself already uses.

CREATE OR REPLACE FUNCTION public.build_listing_evidence_v1_0_for_current_user()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.build_listing_evidence_v1_0(public.get_app_user_id())
$$;

REVOKE ALL ON FUNCTION public.build_listing_evidence_v1_0_for_current_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.build_listing_evidence_v1_0_for_current_user() TO authenticated, service_role;

COMMENT ON FUNCTION public.build_listing_evidence_v1_0_for_current_user() IS
  'Self-scoped wrapper over build_listing_evidence_v1_0, for callers that '
  'only ever hold an RLS-scoped (authenticated) client — e.g. the MCP '
  'get_inventory_analysis tool (src/app/api/mcp). Always computes for the '
  'CALLING user only, via get_app_user_id(); no user id can ever be '
  'supplied or substituted. The underlying build_listing_evidence_v1_0 '
  '(p_target_user_id int) is untouched and remains service_role-only for '
  'its existing trusted-parameter callers.';

-- ─── 2. listing_demand_item_activity_v1_0_for_current_user(start, end) ──
-- Self-scoped wrapper for the per-item buyer-activity dataset that already
-- powers /listings' "Lead Activity by Item" section and its /leads
-- drill-down. Only the period is a parameter — identity is, again, always
-- the caller's own.

-- SECURITY DEFINER for the same reason as #1 above: listing_demand_item_
-- activity_v1_0 is service_role-only, so SECURITY INVOKER would check the
-- nested call against the authenticated caller's own (absent) grant. The
-- period is the only parameter — identity is still always get_app_user_id(),
-- never caller-suppliable, so the elevated privilege still cannot be
-- redirected at another user's data.

CREATE OR REPLACE FUNCTION public.listing_demand_item_activity_v1_0_for_current_user(
  p_period_start date,
  p_period_end   date
)
RETURNS TABLE (
  item_id                        bigint,
  item_display_name              text,
  active_channels                jsonb,
  item_attributed_leads          bigint,
  serious_plus_attributed_leads  bigint,
  offer_attributed_leads         bigint,
  item_listing_days              bigint,
  channel_listing_days           bigint,
  last_attributed_lead_date      date
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.listing_demand_item_activity_v1_0(public.get_app_user_id(), p_period_start, p_period_end)
$$;

REVOKE ALL ON FUNCTION public.listing_demand_item_activity_v1_0_for_current_user(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listing_demand_item_activity_v1_0_for_current_user(date, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.listing_demand_item_activity_v1_0_for_current_user(date, date) IS
  'Self-scoped wrapper over listing_demand_item_activity_v1_0, for callers '
  'that only ever hold an RLS-scoped (authenticated) client — e.g. the MCP '
  'get_lead_activity tool (src/app/api/mcp). Always computes for the '
  'CALLING user only, via get_app_user_id(); no user id can ever be '
  'supplied or substituted. The underlying listing_demand_item_activity_v1_0 '
  '(p_target_user_id int, p_period_start date, p_period_end date) is '
  'untouched and remains service_role-only for its existing trusted-'
  'parameter callers (/api/listing-item-activity, /api/leads).';
