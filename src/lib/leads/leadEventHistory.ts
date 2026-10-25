// Pure, client-safe view model for the /leads drawer's Event History:
// stored lead_events -> a readable oldest-first timeline. Nothing here
// infers a value; every line comes from a stored event field or payload key.
//
// Hidden (implementation artifacts, not the business story):
//   • LEGACY_SNAPSHOT — the pre-event baseline the backfill wrote;
//   • source BACKFILL — reconstruction bookkeeping (its timestamp is the
//     backfill run, not when anything happened; the resulting status /
//     outcome is already in the lead snapshot);
//   • voided events.
// Shown: MESSAGE, OFFER, AGREEMENT, LOGISTICS, STATUS_CHANGE, DEAL_LINKED,
// NOTE — including SYSTEM ones (auto-close when the item sold, auto-reopen,
// agreed/completed transitions), which are real moments in the lead's life.
//
// "Substantive" history excludes the contact-name audit NOTE (a rename is
// not conversation evidence): a legacy lead whose only events are renames
// still shows its legacy notes as the primary history.

import { fmtCad, outcomeReasonLabel, STATUS_LABEL } from './leadFormat';
import type { LeadStatus } from './leadTypes';

export interface LeadEventRecord {
  id: number;
  event_type: string;
  direction: string;
  occurred_at: string;
  occurred_at_precision: string;
  summary: string;
  message_count: number;
  payload: Record<string, unknown> | null;
  source: string;
  actor: string;
  voided_at: string | null;
}

export type TimelineWho = 'BUYER' | 'US' | 'INTERNAL';

export interface TimelineDetail {
  text: string;
  href?: string;
}

export interface TimelineEntry {
  id: number;
  date: string;
  /** Local time (America/Toronto) when the event was recorded with a time; null for date-only events. */
  time: string | null;
  who: TimelineWho;
  whoLabel: string;
  typeLabel: string;
  summary: string;
  details: TimelineDetail[];
}

export interface LeadHistory {
  entries: TimelineEntry[];
  /** True when at least one shown event is real lead history (not just a name-change audit). */
  hasSubstantive: boolean;
}

const WHO: Record<string, { who: TimelineWho; label: string }> = {
  INBOUND: { who: 'BUYER', label: 'Buyer' },
  OUTBOUND: { who: 'US', label: 'Us' },
  INTERNAL: { who: 'INTERNAL', label: 'Internal' },
};

const TYPE_LABEL: Record<string, string> = {
  MESSAGE: 'Message', OFFER: 'Offer', AGREEMENT: 'Agreement', LOGISTICS: 'Logistics', STATUS_CHANGE: 'Status', DEAL_LINKED: 'Deal linked', NOTE: 'Note',
};
const LOGISTICS_KIND: Record<string, string> = { MEETUP: 'Meetup', HOLD: 'Hold', ADDRESS: 'Address', SHIPPING: 'Shipping', PAYMENT: 'Payment', ORDER: 'Order' };
const LOGISTICS_STATE: Record<string, string> = { PROPOSED: 'Proposed', CONFIRMED: 'Confirmed', DONE: 'Done', MISSED: 'Missed', CANCELLED: 'Cancelled' };
const NOTE_TOPIC: Record<string, string> = { VALUATION: 'Valuation note', RESEARCH: 'Research note', CONDITION: 'Condition note', OTHER: 'Note' };
const ASSESSMENT: Record<string, string> = { ACCEPTABLE: 'Acceptable', NEAR: 'Near our number', FAR_BELOW: 'Far below', NOT_RELEVANT: 'Not relevant' };
const ACCEPTED_BY: Record<string, string> = { BUYER: 'Accepted by the buyer', US: 'Accepted by us', BOTH: 'Confirmed by both sides' };
const EVIDENCE: Record<string, string> = { PHOTOS: 'Photos', SERIAL: 'Serial', COA: 'COA', VIDEO: 'Video' };

export function isHiddenEvent(e: Pick<LeadEventRecord, 'event_type' | 'source' | 'voided_at'>): boolean {
  return e.event_type === 'LEGACY_SNAPSHOT' || e.source === 'BACKFILL' || e.voided_at != null;
}

export function isContactNameAudit(e: Pick<LeadEventRecord, 'event_type' | 'payload'>): boolean {
  return e.event_type === 'NOTE' && (e.payload as { change?: unknown } | null)?.change === 'CONTACT_NAME';
}

const TZ = 'America/Toronto';
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

function when(e: LeadEventRecord): { date: string; time: string | null } {
  const d = new Date(e.occurred_at);
  if (Number.isNaN(d.getTime())) return { date: '—', time: null };
  return { date: dateFmt.format(d), time: e.occurred_at_precision === 'TIME' ? timeFmt.format(d) : null };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const statusLabel = (v: unknown) => (typeof v === 'string' ? STATUS_LABEL[v as LeadStatus] ?? v : null);

/** The structured lines of an offer payload ({ cash_terms, cash_amount, items: [{ description, est_value? }] }). */
export function offerDetails(offer: unknown): TimelineDetail[] {
  if (!offer || typeof offer !== 'object') return [];
  const o = offer as { cash_terms?: unknown; cash_amount?: unknown; items?: unknown };
  const items = Array.isArray(o.items) ? o.items : [];
  const out: TimelineDetail[] = [];
  for (const it of items) {
    const d = str((it as { description?: unknown })?.description);
    if (!d) continue;
    const est = num((it as { est_value?: unknown }).est_value);
    out.push({ text: est != null ? `${d} — est. value ${fmtCad(est)}` : d });
  }
  const amount = num(o.cash_amount);
  if (items.length === 0) {
    if (amount != null) out.push({ text: `Cash: ${fmtCad(amount)}` });
  } else if (o.cash_terms === 'STRAIGHT' || (o.cash_terms === 'AMOUNT' && amount === 0)) {
    out.push({ text: 'Straight trade — no cash' });
  } else if (o.cash_terms === 'AMOUNT' && amount != null) {
    out.push({ text: amount > 0 ? `Cash to us: ${fmtCad(amount)}` : `Cash from us: ${fmtCad(Math.abs(amount))}` });
  } else if (o.cash_terms === 'OPEN') {
    out.push({ text: 'Cash: amount open' });
  }
  return out;
}

function details(e: LeadEventRecord): TimelineDetail[] {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const out: TimelineDetail[] = [];
  switch (e.event_type) {
    case 'MESSAGE': {
      const ev = Array.isArray(p.evidence) ? p.evidence.map((x) => EVIDENCE[String(x)] ?? String(x)) : [];
      if (ev.length) out.push({ text: `Shared: ${ev.join(', ')}` });
      if (p.follow_up === true) out.push({ text: 'Follow-up' });
      break;
    }
    case 'OFFER':
      out.push(...offerDetails(p.offer));
      if (p.ready_to_execute === true) out.push({ text: 'Ready to proceed' });
      break;
    case 'AGREEMENT':
      if (typeof p.accepted_by === 'string') out.push({ text: ACCEPTED_BY[p.accepted_by] ?? p.accepted_by });
      out.push(...offerDetails(p.terms));
      break;
    case 'LOGISTICS': {
      const at = str(p.scheduled_for);
      if (at) {
        const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T12:00:00Z` : at);
        if (!Number.isNaN(d.getTime())) out.push({ text: `Scheduled: ${dateFmt.format(d)}${/^\d{4}-\d{2}-\d{2}$/.test(at) ? '' : `, ${timeFmt.format(d)}`}` });
      }
      if (p.at_asking_price === true) out.push({ text: 'At asking price' });
      const ref = str(p.reference);
      if (ref) out.push({ text: `Reference: ${ref}` });
      break;
    }
    case 'STATUS_CHANGE': {
      const from = statusLabel(p.from);
      const to = statusLabel(p.to);
      if (to) out.push({ text: from ? `${from} → ${to}` : `→ ${to}` });
      if (typeof p.outcome_reason === 'string') out.push({ text: `Reason: ${outcomeReasonLabel(p.outcome_reason)}` });
      break;
    }
    case 'DEAL_LINKED': {
      const id = num(p.deal_id);
      if (id != null) out.push({ text: `Deal #${id}`, href: `/operations/${id}` });
      break;
    }
  }
  if (e.event_type === 'OFFER' || e.event_type === 'NOTE') {
    if (typeof p.assessment === 'string') out.push({ text: `Assessment: ${ASSESSMENT[p.assessment] ?? p.assessment}` });
    const est = num(p.our_estimate);
    if (est != null) out.push({ text: `Our estimate: ${fmtCad(est)}` });
  }
  if ((e.event_type === 'MESSAGE' || e.event_type === 'OFFER') && e.message_count > 1) out.push({ text: `${e.message_count} messages` });
  return out;
}

function typeLabel(e: LeadEventRecord): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.event_type === 'LOGISTICS') {
    const kind = LOGISTICS_KIND[String(p.kind)] ?? 'Logistics';
    const state = LOGISTICS_STATE[String(p.state)];
    return state ? `${kind} · ${state}` : kind;
  }
  if (e.event_type === 'NOTE') return isContactNameAudit(e) ? 'Name change' : NOTE_TOPIC[String(p.topic)] ?? 'Note';
  return TYPE_LABEL[e.event_type] ?? e.event_type;
}

/** Visible events, oldest first (occurred_at, then id), as timeline entries. */
export function buildLeadHistory(events: LeadEventRecord[]): LeadHistory {
  const shown = events
    .filter((e) => !isHiddenEvent(e))
    .sort((a, b) => (a.occurred_at === b.occurred_at ? a.id - b.id : Date.parse(a.occurred_at) - Date.parse(b.occurred_at)));
  const entries = shown.map((e) => {
    const w = WHO[e.direction] ?? WHO.INTERNAL;
    return { id: e.id, ...when(e), who: w.who, whoLabel: w.label, typeLabel: typeLabel(e), summary: e.summary, details: details(e) };
  });
  return { entries, hasSubstantive: shown.some((e) => !isContactNameAudit(e)) };
}
