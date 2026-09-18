// Deterministic, pure display formatting for the /leads screen. Nothing
// here infers or invents a value: a missing field renders as an explicit
// "not recorded"/"unknown" phrase or an em-dash, never a guess.

import type { LeadRow, LeadQuality, LeadStatus, OfferType } from './leadTypes';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** CAD amount; whole dollars when there are no cents, otherwise exactly 2 decimals (never hides cents in a QA screen). */
export function fmtCad(v: number | null | undefined): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const hasCents = Math.round(abs * 100) % 100 !== 0;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : ''}$${body}`;
}

/** YYYY-MM-DD -> "Sep 18" (plus ", 2025" when not the current year). Pure string parsing — never via Date, so no timezone shift. */
export function fmtLeadDate(dateStr: string | null | undefined, currentYear: number = new Date().getFullYear()): string {
  if (!dateStr) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return '—';
  const label = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  return Number(m[1]) === currentYear ? label : `${label}, ${m[1]}`;
}

/** Always includes the year — used in the detail panel where dates are compared against a real conversation. */
export function fmtLeadDateFull(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return '—';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function fmtTimestamp(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function leadItemName(year: number | null, brand: string | null, model: string | null, itemId: number): string {
  const name = [year, brand, model].filter((p) => p !== null && p !== undefined && p !== '').join(' ');
  return name || `Item #${itemId}`;
}

export function leadChannelLabel(lead: Pick<LeadRow, 'channel_name' | 'source_channel'>): string {
  const canonical = lead.channel_name?.trim();
  if (canonical) return canonical;
  const raw = lead.source_channel?.trim();
  return raw || 'Unknown';
}

/** "5 / 2" — buyer messages / our messages; a missing count is an em-dash, never 0. */
export function fmtMessages(lead: Pick<LeadRow, 'buyer_message_count' | 'our_message_count'>): string {
  const b = lead.buyer_message_count == null ? '—' : String(lead.buyer_message_count);
  const o = lead.our_message_count == null ? '—' : String(lead.our_message_count);
  return `${b} / ${o}`;
}

type OfferFields = Pick<LeadRow, 'offer_type' | 'initial_cash_offer' | 'best_cash_offer' | 'trade_item' | 'cash_component'>;

/**
 * Human-readable one-line offer summary derived ONLY from the structured
 * offer fields (deterministic; no AI, no inference).
 *   NONE  -> "No offer"
 *   CASH  -> "$1,650 cash" (best_cash_offer, else initial_cash_offer)
 *   TRADE -> "Trade: <trade_item>"
 *   MIXED -> "<item> + $500 to us" / "+ $500 from us" / "+ cash amount unknown"
 * trade_est_value is intentionally excluded (detail view only).
 */
export function formatOfferSummary(lead: OfferFields): string {
  const tradeItem = lead.trade_item?.trim() || null;
  switch (lead.offer_type) {
    case 'NONE':
      return 'No offer';
    case 'CASH': {
      const amount = lead.best_cash_offer ?? lead.initial_cash_offer;
      return amount == null ? 'Cash offer (amount not recorded)' : `${fmtCad(amount)} cash`;
    }
    case 'TRADE':
      return tradeItem ? `Trade: ${tradeItem}` : 'Trade (item not recorded)';
    case 'MIXED': {
      const item = tradeItem ?? 'Trade (item not recorded)';
      const cash = lead.cash_component;
      if (cash == null) return `${item} + cash amount unknown`;
      if (cash > 0) return `${item} + ${fmtCad(cash)} to us`;
      if (cash < 0) return `${item} + ${fmtCad(Math.abs(cash))} from us`;
      return `Trade: ${item}`; // 0 cash on MIXED is rejected by the DB; never invent a cash phrase for it
    }
    default:
      return '—';
  }
}

/** Plain-language meaning of the stored cash_component for the detail view (Data QA). */
export function describeCashComponent(lead: Pick<LeadRow, 'offer_type' | 'cash_component'>): string {
  const c = lead.cash_component;
  if (c == null) {
    return lead.offer_type === 'MIXED' ? 'Not recorded — cash is part of the deal, amount unknown' : 'Not applicable';
  }
  if (c > 0) return `${fmtCad(c)} — cash to us`;
  if (c < 0) return `${fmtCad(Math.abs(c))} — cash from us`;
  return '$0 — straight trade, no cash';
}

export const QUALITY_LABEL: Record<LeadQuality, string> = {
  LOW: 'Low',
  ENGAGED: 'Engaged',
  SERIOUS: 'Serious',
  HIGH_INTENT: 'High intent',
};

export const STATUS_LABEL: Record<LeadStatus, string> = {
  OPEN: 'Open',
  GHOSTED: 'Ghosted',
  DECLINED_BY_ME: 'Declined by me',
  DECLINED_BY_THEM: 'Declined by them',
  AGREED: 'Agreed',
  FAILED_AFTER_AGREEMENT: 'Failed after agreement',
  COMPLETED: 'Completed',
};

export const OFFER_TYPE_LABEL: Record<OfferType, string> = {
  NONE: 'None',
  CASH: 'Cash',
  TRADE: 'Trade',
  MIXED: 'Mixed',
};

const OUTCOME_LABEL: Record<string, string> = {
  LOW_OFFER: 'Low offer',
  TRADE_NOT_INTERESTING: 'Trade not interesting',
  PRICE: 'Price',
  CONDITION: 'Condition',
  LOGISTICS: 'Logistics',
  NO_SHOW: 'No show',
  CHANGED_MIND: 'Changed mind',
  FOUND_ANOTHER: 'Found another',
  UNKNOWN: 'Unknown',
};

export function outcomeReasonLabel(reason: string | null): string {
  if (!reason) return '—';
  return OUTCOME_LABEL[reason] ?? reason;
}
