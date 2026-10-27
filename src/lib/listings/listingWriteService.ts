// Listing writes — LIST / UPDATE / UNLIST — for both control surfaces:
//   - the item page's listing card (src/components/AiAssistantCard.tsx, via
//     applyItemListingChanges in src/lib/supabase.ts), and
//   - MCP manage_listing (src/app/api/mcp/[[...path]]/route.ts, via
//     manageListing below).
// Both end in ONE call to public.apply_listing_changes (migration
// 20261026000000) through the caller's own RLS-scoped client — never
// a privileged key. That function owns every business decision (which listing a
// platform refers to, review vs apply, the terms rule, dates) and applies a
// batch all-or-nothing, idempotently per mutation_id. This module only
// normalizes input (platform names, dates) and shapes the result.
//
// END is not an action here: a listing ENDS because its item left inventory
// through a Sell/Trade operation (end_reason ITEM_EXITED, set by the
// database). Removing an ad while still owning the item is UNLIST
// (status 'ended', end_reason 'UNLISTED' — still a real listing cycle).

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatListingTerms, fmtListingPrice, LISTING_TERMS_MESSAGE, type ListingTermsErrorCode } from './listingTerms';

export const LISTING_ACTIONS = ['LIST', 'UPDATE', 'UNLIST'] as const;
export type ListingActionKind = (typeof LISTING_ACTIONS)[number];

/** One action as apply_listing_changes receives it. Omitted price/trade = leave unchanged (UPDATE) / default (LIST). */
export interface ListingChangeAction {
  action: ListingActionKind;
  dealChannelId: number;
  /** null = no asking price (Kijiji trade only). */
  askingPrice?: number | null;
  tradeEnabled?: boolean;
  /** YYYY-MM-DD — LIST: listed date (required); UNLIST: unlisted date (default today). */
  date?: string;
}

export interface ApplyListingChangesRequest {
  mutationId: string;
  itemId: number;
  source: 'UI' | 'MCP';
  actions: ListingChangeAction[];
}

export type ListingActionOutcomeKind = 'CREATED' | 'UPDATED' | 'UNLISTED' | 'NO_CHANGE' | 'REVIEW' | 'REJECTED';
export type ListingChangeStatus = 'APPLIED' | 'NO_CHANGE' | 'REVIEW_REQUIRED' | 'REJECTED';

export interface ListingStateSnapshot {
  status: string;
  asking_price: number | null;
  trade_enabled: boolean;
  listed_at: string | null;
  ended_at?: string | null;
  end_reason?: string | null;
}

export interface ListingActionOutcome {
  index: number;
  action: ListingActionKind;
  channel_id: number;
  channel_name: string | null;
  outcome: ListingActionOutcomeKind;
  code: string | null;
  listing_id: number | null;
  before: ListingStateSnapshot | null;
  after: ListingStateSnapshot | null;
}

export interface ApplyListingChangesResult {
  status: ListingChangeStatus;
  replay: boolean;
  item_id: number;
  item_status_before?: string;
  item_status_after?: string;
  active_channel_ids_after?: number[];
  actions: ListingActionOutcome[];
  /** Request-level problem (no per-action detail), e.g. ITEM_NOT_FOUND. */
  code?: string;
  message?: string;
}

const KNOWN_DB_CODES = [
  'LISTING_TRADE_NOT_SUPPORTED', 'LISTING_PRICE_INVALID', 'LISTING_PRICE_OR_TRADE_REQUIRED', 'LISTING_PRICE_REQUIRED',
  'NOT_AUTHENTICATED',
] as const;

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function snapshot(v: unknown): ListingStateSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  return {
    status: String(s.status),
    asking_price: num(s.asking_price),
    trade_enabled: s.trade_enabled === true,
    listed_at: (s.listed_at as string | null) ?? null,
    ...('ended_at' in s ? { ended_at: (s.ended_at as string | null) ?? null } : {}),
    ...('end_reason' in s ? { end_reason: (s.end_reason as string | null) ?? null } : {}),
  };
}

function toRpcAction(a: ListingChangeAction) {
  return {
    action: a.action,
    deal_channel_id: a.dealChannelId,
    set_price: a.askingPrice !== undefined,
    asking_price: a.askingPrice ?? null,
    set_trade: a.tradeEnabled !== undefined,
    trade_enabled: a.tradeEnabled ?? false,
    date: a.date ?? null,
  };
}

/** The one write call. Never throws for business outcomes; a database guard error comes back as REJECTED. */
export async function applyListingChanges(client: SupabaseClient, req: ApplyListingChangesRequest): Promise<ApplyListingChangesResult> {
  const { data, error } = await client.rpc('apply_listing_changes', {
    p_request: { mutation_id: req.mutationId, item_id: req.itemId, source: req.source, actions: req.actions.map(toRpcAction) },
  });
  if (error) {
    const code = KNOWN_DB_CODES.find((c) => error.message.includes(c)) ?? 'WRITE_FAILED';
    const message = code in LISTING_TERMS_MESSAGE ? LISTING_TERMS_MESSAGE[code as ListingTermsErrorCode] : code === 'WRITE_FAILED' ? `Could not save the listing: ${error.message}` : code;
    return { status: 'REJECTED', replay: false, item_id: req.itemId, actions: [], code, message };
  }
  const r = data as Record<string, unknown>;
  const actions = ((r.actions as unknown[] | null) ?? []).map((x) => {
    const a = x as Record<string, unknown>;
    return {
      index: Number(a.index),
      action: a.action as ListingActionKind,
      channel_id: Number(a.channel_id),
      channel_name: (a.channel_name as string | null) ?? null,
      outcome: a.outcome as ListingActionOutcomeKind,
      code: (a.code as string | null) ?? null,
      listing_id: num(a.listing_id),
      before: snapshot(a.before),
      after: snapshot(a.after),
    };
  });
  return {
    status: r.status as ListingChangeStatus,
    replay: r.replay === true,
    item_id: Number(r.item_id ?? req.itemId),
    ...(r.item_status_before !== undefined ? { item_status_before: r.item_status_before as string } : {}),
    ...(r.item_status_after !== undefined ? { item_status_after: r.item_status_after as string } : {}),
    ...(Array.isArray(r.active_channel_ids_after) ? { active_channel_ids_after: (r.active_channel_ids_after as unknown[]).map(Number) } : {}),
    actions,
    ...(r.code ? { code: String(r.code) } : {}),
    ...(r.message ? { message: String(r.message) } : {}),
  };
}

// ── Messages ──────────────────────────────────────────────────────────────

/** Human wording for an action's code (review / rejection / no-change reason). */
export function listingOutcomeMessage(o: Pick<ListingActionOutcome, 'code' | 'channel_name' | 'before'>): string | null {
  const p = o.channel_name ?? 'this platform';
  switch (o.code) {
    case null: return null;
    case 'LISTING_ALREADY_ACTIVE':
      return `An active ${p} listing already exists${o.before ? ` (${formatListingTerms(o.before.asking_price, o.before.trade_enabled)})` : ''}. Use UPDATE to change it.`;
    case 'NO_ACTIVE_LISTING': return `No active ${p} listing exists.`;
    case 'NOT_LISTED': return `No active ${p} listing — nothing to unlist.`;
    case 'INVALID_PLATFORM': return 'Not a listing platform.';
    case 'INVALID_ACTION': return 'Action must be LIST, UPDATE or UNLIST.';
    case 'DUPLICATE_PLATFORM': return `${p} appears more than once in this request.`;
    case 'ITEM_NOT_IN_INVENTORY': return 'This item was sold or traded; its listings ended automatically.';
    case 'DATE_REQUIRED': return 'Pick a listing date.';
    case 'DATE_IN_FUTURE': return 'The date cannot be in the future.';
    case 'LISTED_BEFORE_ACQUIRED': return 'Listing date cannot be before the item was acquired.';
    case 'UNLISTED_BEFORE_LISTED': return 'Unlist date cannot be before the listing date.';
    default:
      return o.code in LISTING_TERMS_MESSAGE ? `${p}: ${LISTING_TERMS_MESSAGE[o.code as ListingTermsErrorCode]}` : o.code;
  }
}

/** First user-facing problem in a non-applied result (for the UI's error banner). */
export function listingResultError(r: ApplyListingChangesResult): string | null {
  if (r.status === 'APPLIED' || r.status === 'NO_CHANGE') return null;
  const bad = r.actions.find((a) => a.outcome === 'REJECTED' || a.outcome === 'REVIEW');
  if (bad) {
    const msg = listingOutcomeMessage(bad);
    // The card is already about one platform — drop the "Kijiji: " prefix there.
    return msg && bad.channel_name && msg.startsWith(`${bad.channel_name}: `) ? msg.slice(bad.channel_name.length + 2) : msg;
  }
  return r.message ?? 'Could not save the listing.';
}

// ── MCP manage_listing ────────────────────────────────────────────────────

export interface ManageListingActionInput {
  action: ListingActionKind;
  platform: string;
  asking_price?: number | null;
  trade_enabled?: boolean;
  occurred_at?: string;
}

export interface ManageListingInput {
  mutation_id: string;
  item_id: number;
  actions: ManageListingActionInput[];
}

export interface ManageListingActionResult {
  platform: string;
  action: ListingActionKind;
  outcome: ListingActionOutcomeKind;
  code: string | null;
  message: string | null;
  listing_id: number | null;
  before: (ListingStateSnapshot & { terms: string }) | null;
  after: (ListingStateSnapshot & { terms: string }) | null;
}

export interface ManageListingResult {
  result: ListingChangeStatus;
  replay: boolean;
  /** e.g. "🟢 Listings: CREATED" — show it, then `lines`. */
  headline: string;
  lines: string[];
  item_id: number;
  item_status_before: string | null;
  item_status_after: string | null;
  active_platforms_after: string[] | null;
  actions: ManageListingActionResult[];
  code?: string;
  message?: string;
  next_step?: string;
}

const PLATFORM_ALIASES: Record<string, string> = {
  'facebook marketplace': 'marketplace',
  'fb marketplace': 'marketplace',
  facebook: 'marketplace',
  fb: 'marketplace',
  fbm: 'marketplace',
};

/** YYYY-MM-DD in Toronto for an ISO date-time; a bare YYYY-MM-DD is kept as given. null = unparseable. */
export function toTorontoDate(value: string | undefined, now: Date = new Date()): string | null {
  if (value === undefined) return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(now);
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Number.isNaN(Date.parse(`${v}T12:00:00Z`)) ? null : v;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date(t));
}

function withTerms(s: ListingStateSnapshot | null) {
  return s ? { ...s, terms: formatListingTerms(s.asking_price, s.trade_enabled) } : null;
}

function priceLabel(p: number | null): string {
  return p == null ? 'no price' : fmtListingPrice(p);
}

export function formatActionLine(a: Pick<ListingActionOutcome, 'outcome' | 'code' | 'before' | 'after' | 'channel_name'> & { platform: string }): string {
  const { before, after } = a;
  switch (a.outcome) {
    case 'CREATED':
      return `${a.platform}: ${after ? formatListingTerms(after.asking_price, after.trade_enabled) : 'listed'}`;
    case 'UPDATED': {
      if (!before || !after) return `${a.platform}: updated`;
      const priceChanged = before.asking_price !== after.asking_price;
      const tradeChanged = before.trade_enabled !== after.trade_enabled;
      if (priceChanged && !tradeChanged && before.asking_price != null && after.asking_price != null) {
        return `${a.platform}: ${priceLabel(before.asking_price)} → ${priceLabel(after.asking_price)}${after.trade_enabled ? ' · Trade' : ''}`;
      }
      if (!priceChanged && tradeChanged) {
        return `${a.platform}: ${formatListingTerms(after.asking_price, after.trade_enabled)} (Trade ${after.trade_enabled ? 'added' : 'removed'})`;
      }
      return `${a.platform}: ${formatListingTerms(before.asking_price, before.trade_enabled)} → ${formatListingTerms(after.asking_price, after.trade_enabled)}`;
    }
    case 'UNLISTED':
      return `${a.platform}: Unlisted${before ? ` (was ${formatListingTerms(before.asking_price, before.trade_enabled)})` : ''}`;
    case 'NO_CHANGE':
      return a.code ? listingOutcomeMessage({ ...a, channel_name: a.platform }) ?? `${a.platform}: no change`
        : `${a.platform}: no change${before ? ` (${formatListingTerms(before.asking_price, before.trade_enabled)})` : ''}`;
    default:
      return listingOutcomeMessage({ ...a, channel_name: a.platform }) ?? `${a.platform}: ${a.outcome}`;
  }
}

const HEADLINE_ICON: Record<ListingChangeStatus, string> = { APPLIED: '🟢', NO_CHANGE: '⚪', REVIEW_REQUIRED: '🟡', REJECTED: '🔴' };

function headline(status: ListingChangeStatus, actions: Pick<ListingActionOutcome, 'outcome'>[]): string {
  let word: string = status === 'REVIEW_REQUIRED' ? 'REVIEW REQUIRED' : status === 'NO_CHANGE' ? 'NO CHANGE' : status;
  if (status === 'APPLIED') {
    const kinds = new Set(actions.map((a) => a.outcome).filter((o) => o !== 'NO_CHANGE'));
    word = kinds.size === 1 ? Array.from(kinds)[0] : 'UPDATED';
  }
  return `${HEADLINE_ICON[status]} Listings: ${word}`;
}

function rejected(itemId: number, code: string, message: string): ManageListingResult {
  return {
    result: 'REJECTED', replay: false, headline: `${HEADLINE_ICON.REJECTED} Listings: REJECTED`, lines: [message],
    item_id: itemId, item_status_before: null, item_status_after: null, active_platforms_after: null, actions: [], code, message,
  };
}

/** MCP manage_listing: normalize platform names/dates, call apply_listing_changes once, shape the reply. */
export async function manageListing(client: SupabaseClient, input: ManageListingInput, now: Date = new Date()): Promise<ManageListingResult> {
  const { data: channelRows, error: channelError } = await client
    .from('deal_channels').select('id, name').eq('is_listing_platform', true).eq('is_active', true);
  if (channelError) return rejected(input.item_id, 'WRITE_FAILED', `Could not load listing platforms: ${channelError.message}`);
  const channels = (channelRows ?? []) as { id: number; name: string }[];
  const byKey = new Map(channels.map((c) => [c.name.trim().toLowerCase(), c]));
  const platformList = channels.map((c) => c.name).join(', ');

  const actions: ListingChangeAction[] = [];
  for (const a of input.actions) {
    const key = a.platform.trim().toLowerCase();
    const ch = byKey.get(PLATFORM_ALIASES[key] ?? key);
    if (!ch) return rejected(input.item_id, 'INVALID_PLATFORM', `Unknown listing platform "${a.platform}". Use one of: ${platformList}.`);
    if (a.action === 'UNLIST' && (a.asking_price !== undefined || a.trade_enabled !== undefined)) {
      return rejected(input.item_id, 'VALIDATION_ERROR', `UNLIST ${ch.name} takes no asking_price/trade_enabled — send a separate UPDATE if the terms changed.`);
    }
    if (a.action === 'UPDATE' && a.asking_price === undefined && a.trade_enabled === undefined) {
      return rejected(input.item_id, 'VALIDATION_ERROR', `UPDATE ${ch.name} needs asking_price and/or trade_enabled.`);
    }
    if (a.action === 'LIST' && a.asking_price === undefined && a.trade_enabled === undefined) {
      return rejected(input.item_id, 'VALIDATION_ERROR', `LIST ${ch.name} needs asking_price (or trade_enabled: true for a Kijiji trade-only ad).`);
    }
    const date = a.action === 'UPDATE' ? undefined : toTorontoDate(a.occurred_at, now);
    if (date === null) return rejected(input.item_id, 'VALIDATION_ERROR', `occurred_at "${a.occurred_at}" is not a valid date.`);
    actions.push({
      action: a.action,
      dealChannelId: ch.id,
      ...(a.asking_price !== undefined ? { askingPrice: a.asking_price } : {}),
      ...(a.trade_enabled !== undefined ? { tradeEnabled: a.trade_enabled } : {}),
      ...(date ? { date } : {}),
    });
  }

  const r = await applyListingChanges(client, { mutationId: input.mutation_id, itemId: input.item_id, source: 'MCP', actions });
  if (r.actions.length === 0) return rejected(input.item_id, r.code ?? 'REJECTED', r.message ?? 'Could not apply the listing change.');

  const nameById = new Map(channels.map((c) => [c.id, c.name]));
  const outActions: ManageListingActionResult[] = r.actions.map((a) => {
    const platform = a.channel_name ?? nameById.get(a.channel_id) ?? input.actions[a.index]?.platform ?? `Channel ${a.channel_id}`;
    return {
      platform,
      action: a.action,
      outcome: a.outcome,
      code: a.code,
      message: listingOutcomeMessage({ ...a, channel_name: platform }),
      listing_id: a.listing_id,
      before: withTerms(a.before),
      after: withTerms(a.after),
    };
  });
  const shown = r.status === 'REVIEW_REQUIRED' || r.status === 'REJECTED'
    ? r.actions.filter((a) => a.outcome === 'REVIEW' || a.outcome === 'REJECTED')
    : r.actions;
  const lines = shown.map((a) => formatActionLine({ ...a, platform: outActions[r.actions.indexOf(a)].platform }));

  const result: ManageListingResult = {
    result: r.status,
    replay: r.replay,
    headline: headline(r.status, r.actions),
    lines,
    item_id: r.item_id,
    item_status_before: r.item_status_before ?? null,
    item_status_after: r.item_status_after ?? null,
    active_platforms_after: r.active_channel_ids_after ? r.active_channel_ids_after.map((id) => nameById.get(id) ?? `Channel ${id}`) : null,
    actions: outActions,
  };
  if (r.status === 'REVIEW_REQUIRED') {
    result.next_step = 'Nothing was written. Ask the user what they meant, then send the corrected actions (e.g. UPDATE instead of LIST, or LIST to create the listing). Reusing the same mutation_id is fine because nothing was applied.';
  } else if (r.status === 'REJECTED') {
    result.next_step = 'Nothing was written. Fix the rejected action (see message) and resend.';
  }
  return result;
}
