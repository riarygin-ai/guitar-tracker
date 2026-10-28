// Business Coach (Auditable AI Advice) — compact Negotiation Intelligence
// context.
//
// Consumes the shared NegotiationAnalyticsResult (../negotiationAnalytics.ts)
// and only SELECTS and RESHAPES it for the Coach packet: no metric is
// computed here. Each module is gated by its own deterministic
// evidence_strength — a module or segment below 'low' (fewer than
// STRENGTH_MIN_SAMPLE.low cases) is never citable; it is listed under
// `suppressed` with its sample size so the Coach can say the evidence is
// still accumulating instead of drawing a finding from it.
//
// Never included: lead ids, item ids, names, notes, message text, offer
// amounts, per-counter records (drilldown) — the Coach reads aggregates only.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  STRENGTH_MIN_SAMPLE, buildNegotiationAnalytics, loadNegotiationAnalyticsInputs, strengthAtLeast,
  type NegotiationAnalyticsInputs, type NegotiationAnalyticsResult, type NegotiationComparisonMetric, type RateMetric,
} from '../negotiationAnalytics';
import { torontoLocalDate } from '../automation/torontoSchedule';

export const NEGOTIATION_CONTEXT_VERSION = '1.0';

export interface NegotiationSuppressedModule {
  module: string;
  reason: 'INSUFFICIENT_SAMPLE';
  sample_size: number;
  min_required: number;
}

type Lifetime = NegotiationAnalyticsResult;

export interface NegotiationCoachContext {
  context_version: typeof NEGOTIATION_CONTEXT_VERSION;
  engine_version: string;
  as_of: string;
  coverage: { source_id: string } & Lifetime['coverage'] & { stage_definition: string };
  funnel: ({ source_id: string } & Lifetime['funnel']) | null;
  outcomes: ({ source_id: string } & Lifetime['outcomes']) | null;
  by_offer_type: { source_id: string; segments: Lifetime['by_offer_type'] } | null;
  by_channel: { source_id: string; segments: Lifetime['by_channel'] } | null;
  rounds: ({ source_id: string } & Omit<Lifetime['rounds'], 'definition'>) | null;
  counter_behavior: ({ source_id: string } & Omit<Lifetime['counter_behavior'], 'definition'>) | null;
  counter_size: ({ source_id: string } & Omit<Lifetime['counter_size_buckets'], 'definition'>) | null;
  /** Current calendar month to date vs the previous full month; only material metrics. */
  month_comparison: ({ source_id: string } & NonNullable<Lifetime['comparison']>) | null;
  suppressed: NegotiationSuppressedModule[];
  limitations: string[];
}

const MIN = STRENGTH_MIN_SAMPLE.low;
const citable = (n: number) => n >= MIN;

/** Calendar month containing `asOf` (to date) and the full month before it. */
export function monthPeriods(asOf: string): { current: { start_date: string; end_date: string; label: string }; previous: { start_date: string; end_date: string; label: string } } {
  const y = Number(asOf.slice(0, 4)), m = Number(asOf.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return {
    current: { start_date: `${y}-${pad(m)}-01`, end_date: asOf, label: `${y}-${pad(m)} to date` },
    previous: { start_date: `${py}-${pad(pm)}-01`, end_date: `${py}-${pad(pm)}-${pad(lastDay)}`, label: `${py}-${pad(pm)}` },
  };
}

/** Pure: lifetime result + current-month result (with comparison) -> the compact Coach block. */
export function buildNegotiationCoachContext(lifetime: NegotiationAnalyticsResult, month: NegotiationAnalyticsResult | null, asOf: string): NegotiationCoachContext {
  const suppressed: NegotiationSuppressedModule[] = [];
  const gate = <T>(module: string, n: number, value: () => T): T | null => {
    if (citable(n)) return value();
    suppressed.push({ module, reason: 'INSUFFICIENT_SAMPLE', sample_size: n, min_required: MIN });
    return null;
  };

  const funnel = gate('funnel', lifetime.funnel.negotiating_count, () => ({ source_id: 'negotiation:funnel', ...lifetime.funnel }));
  const outcomes = gate('outcomes', lifetime.funnel.negotiating_count, () => ({ source_id: 'negotiation:outcomes', ...lifetime.outcomes }));

  const offerSegments = lifetime.by_offer_type.filter((s) => citable(s.lead_count));
  for (const s of lifetime.by_offer_type) if (!citable(s.lead_count) && s.lead_count > 0) suppressed.push({ module: `by_offer_type:${s.offer_type}`, reason: 'INSUFFICIENT_SAMPLE', sample_size: s.lead_count, min_required: MIN });
  const channelSegments = lifetime.by_channel.filter((s) => citable(s.lead_count));
  for (const s of lifetime.by_channel) if (!citable(s.lead_count) && s.lead_count > 0) suppressed.push({ module: `by_channel:${s.channel}`, reason: 'INSUFFICIENT_SAMPLE', sample_size: s.lead_count, min_required: MIN });

  const { definition: _rd, ...rounds } = lifetime.rounds;
  const roundsWithOffers = rounds.rounds_known_count - rounds.zero_round_count;
  const { definition: _cd, ...counters } = lifetime.counter_behavior;
  const { definition: _sd, ...size } = lifetime.counter_size_buckets;

  let monthComparison: NegotiationCoachContext['month_comparison'] = null;
  if (month?.comparison) {
    const material = month.comparison.metrics.filter((m: NegotiationComparisonMetric) => m.material);
    if (material.length > 0) monthComparison = { source_id: 'negotiation:comparison:month', ...month.comparison, metrics: material };
    else suppressed.push({ module: 'month_comparison', reason: 'INSUFFICIENT_SAMPLE', sample_size: Math.min(month.comparison.current_period.negotiating_count, month.comparison.comparison_period.negotiating_count), min_required: MIN });
  }

  return {
    context_version: NEGOTIATION_CONTEXT_VERSION,
    engine_version: lifetime.analytics_version,
    as_of: asOf,
    coverage: {
      source_id: 'negotiation:coverage',
      ...lifetime.coverage,
      stage_definition: 'Negotiating+ = peak_stage NEGOTIATING, HIGH_INTENT or CONVERTED (a concrete economic proposal existed). High Intent+ = HIGH_INTENT or CONVERTED. CONVERTED = a completed transaction.',
    },
    funnel,
    outcomes,
    by_offer_type: offerSegments.length > 0 ? { source_id: 'negotiation:offer_type', segments: offerSegments } : null,
    by_channel: channelSegments.length > 0 ? { source_id: 'negotiation:channel', segments: channelSegments } : null,
    rounds: gate('rounds', roundsWithOffers, () => ({ source_id: 'negotiation:rounds', ...rounds })),
    counter_behavior: gate('counter_behavior', counters.our_counter_count, () => ({ source_id: 'negotiation:counters', ...counters })),
    counter_size: gate('counter_size', size.numeric_counter_analysis_eligible, () => ({
      source_id: 'negotiation:counter_size', ...size, buckets: size.buckets.filter((b) => strengthAtLeast(b.evidence_strength, 'low')),
    })),
    month_comparison: monthComparison,
    suppressed,
    limitations: [...lifetime.limitations],
  };
}

// ── Citable sources ─────────────────────────────────────────────────────────

export interface NegotiationSource {
  source_id: string;
  item_id: null;
  headline: string;
  summary: string;
  confidence: string | null;
  key_metrics: Record<string, unknown>;
  limitations: string[];
}

/** "26/279 (9.3%, stronger)" — a rate always travels with its denominator. */
export function fmtRate(r: RateMetric): string {
  return `${r.count}/${r.sample_size}${r.rate_pct != null ? ` (${r.rate_pct}%)` : ''}, ${r.evidence_strength}`;
}

export function buildNegotiationSources(ctx: NegotiationCoachContext): NegotiationSource[] {
  const out: NegotiationSource[] = [];
  const cov = ctx.coverage;
  out.push({
    source_id: cov.source_id, item_id: null, confidence: null,
    headline: 'Negotiation evidence — coverage',
    summary: `${cov.negotiating_plus_leads} of ${cov.total_leads} leads reached Negotiating+. Only ${cov.event_sequence_eligible_leads} have complete event history for round/counter analysis; ${cov.our_counter_count} counters recorded, ${cov.numeric_counter_analysis_eligible} with comparable cash terms.`,
    key_metrics: {
      total_leads: cov.total_leads, negotiating_plus_leads: cov.negotiating_plus_leads,
      event_sequence_eligible_leads: cov.event_sequence_eligible_leads, event_sequence_ineligible_leads: cov.event_sequence_ineligible_leads,
      our_counter_count: cov.our_counter_count, numeric_counter_analysis_eligible: cov.numeric_counter_analysis_eligible,
      suppressed_modules: ctx.suppressed.map((s) => `${s.module} (n=${s.sample_size})`).join(', ') || 'none',
    },
    limitations: ctx.limitations,
  });
  if (ctx.funnel) {
    const f = ctx.funnel;
    out.push({
      source_id: f.source_id, item_id: null, confidence: f.negotiating_to_converted.evidence_strength,
      headline: 'Negotiation funnel — lifetime',
      summary: `Negotiating ${f.negotiating_count} → High Intent ${f.high_intent_count} → Converted ${f.converted_count} (${f.still_open_count} still open). Historical, descriptive.`,
      key_metrics: {
        negotiating_to_high_intent: fmtRate(f.negotiating_to_high_intent), high_intent_to_converted: fmtRate(f.high_intent_to_converted),
        negotiating_to_converted: fmtRate(f.negotiating_to_converted),
        negotiating_to_converted_excluding_declined_by_me: fmtRate(f.negotiating_to_converted_excluding_declined_by_me),
        negotiating_to_converted_resolved_only: fmtRate(f.negotiating_to_converted_resolved_only),
        items_realized_via_negotiating_lead: fmtRate(f.items_realized_via_negotiating_lead),
      },
      limitations: [],
    });
  }
  if (ctx.outcomes) {
    const o = ctx.outcomes;
    out.push({
      source_id: o.source_id, item_id: null, confidence: o.by_status.OPEN.evidence_strength,
      headline: 'Negotiation outcomes — lifetime',
      summary: 'Outcome of every Negotiating+ lead, kept separate: our declines, buyer declines, ghosting, neutral closes (item sold via another lead), completions.',
      key_metrics: Object.fromEntries([
        ...Object.entries(o.by_status).map(([k, v]) => [k.toLowerCase(), fmtRate(v)]),
        ['declined_by_me_reasons', JSON.stringify(o.declined_by_me_reasons)],
        ['declined_by_them_reasons', JSON.stringify(o.declined_by_them_reasons)],
      ]),
      limitations: [],
    });
  }
  if (ctx.by_offer_type) {
    out.push({
      source_id: ctx.by_offer_type.source_id, item_id: null, confidence: null,
      headline: 'Negotiation by offer type — lifetime',
      summary: 'Cash / Trade / Mixed negotiations (structured offer_type), each with its own sample size.',
      key_metrics: Object.fromEntries(ctx.by_offer_type.segments.flatMap((s) => [
        [`${s.offer_type.toLowerCase()}_to_high_intent`, fmtRate(s.negotiating_to_high_intent)],
        [`${s.offer_type.toLowerCase()}_to_converted`, fmtRate(s.negotiating_to_converted)],
        [`${s.offer_type.toLowerCase()}_declined_by_me`, s.declined_by_me],
      ])),
      limitations: [],
    });
  }
  if (ctx.by_channel) {
    out.push({
      source_id: ctx.by_channel.source_id, item_id: null, confidence: null,
      headline: 'Negotiation by channel — lifetime',
      summary: 'Negotiating+ leads per normalized channel, each with its own sample size.',
      key_metrics: Object.fromEntries(ctx.by_channel.segments.flatMap((s) => [
        [`${s.channel}: to converted`, fmtRate(s.negotiating_to_converted)],
        [`${s.channel}: declined by them`, `${s.declined_by_them}/${s.lead_count}`],
      ])),
      limitations: [],
    });
  }
  if (ctx.rounds) {
    out.push({
      source_id: ctx.rounds.source_id, item_id: null, confidence: ctx.rounds.evidence_strength,
      headline: 'Negotiation rounds',
      summary: `Rounds known for ${ctx.rounds.rounds_known_count} leads (unknown for ${ctx.rounds.rounds_unknown_count} legacy leads).`,
      key_metrics: { median_rounds: ctx.rounds.median_rounds, average_rounds: ctx.rounds.average_rounds, ...Object.fromEntries(ctx.rounds.distribution.map((d) => [`rounds_${d.bucket}`, `${d.lead_count} leads, converted ${fmtRate(d.conversion)}`])) },
      limitations: [],
    });
  }
  if (ctx.counter_behavior) {
    const c = ctx.counter_behavior;
    out.push({
      source_id: c.source_id, item_id: null, confidence: c.evidence_strength,
      headline: 'What happened after our counters',
      summary: `${c.our_counter_count} counters on ${c.leads_with_our_counter} leads (of ${c.eligible_leads} event-eligible / ${c.total_negotiating_leads} Negotiating+ leads).`,
      key_metrics: {
        buyer_replied: fmtRate(c.buyer_replied), buyer_improved: fmtRate(c.buyer_improved), buyer_high_intent_or_accepted: fmtRate(c.buyer_high_intent_or_accepted),
        buyer_declined: fmtRate(c.buyer_declined), buyer_ghosted: fmtRate(c.buyer_ghosted), we_declined: fmtRate(c.we_declined), unresolved: c.unresolved_count,
      },
      limitations: [],
    });
  }
  if (ctx.counter_size) {
    out.push({
      source_id: ctx.counter_size.source_id, item_id: null, confidence: ctx.counter_size.evidence_strength,
      headline: 'Counter size vs buyer offer (cash only)',
      summary: `${ctx.counter_size.numeric_counter_analysis_eligible} cash counters with a comparable buyer cash offer. Historical rates per bucket, not probabilities.`,
      key_metrics: Object.fromEntries(ctx.counter_size.buckets.map((b) => [`${b.bucket}%`, `n=${b.sample_size}; reply ${fmtRate(b.buyer_reply)}; ghosted ${fmtRate(b.ghosted)}`])),
      limitations: [],
    });
  }
  if (ctx.month_comparison) {
    const mc = ctx.month_comparison;
    out.push({
      source_id: mc.source_id, item_id: null, confidence: null,
      headline: `Negotiation — ${mc.current_period.label} vs ${mc.comparison_period.label}`,
      summary: `Material differences only, over resolved leads. ${mc.current_period.still_open_count} of ${mc.current_period.negotiating_count} current-period leads are still open (to date).`,
      key_metrics: Object.fromEntries(mc.metrics.map((m) => [m.metric, `${fmtRate(m.current)} vs ${fmtRate(m.comparison)}; ${m.difference_pp! > 0 ? '+' : ''}${m.difference_pp}pp`])),
      limitations: [],
    });
  }
  return out;
}

// ── Server loader ───────────────────────────────────────────────────────────

/** Pure: inputs + as-of date -> Coach context (lifetime + current month vs previous month). */
export function negotiationCoachContextFromInputs(inputs: NegotiationAnalyticsInputs, asOf: string): NegotiationCoachContext {
  const { current, previous } = monthPeriods(asOf);
  const lifetime = buildNegotiationAnalytics(inputs, {});
  const month = buildNegotiationAnalytics(inputs, { period: current, comparisonPeriod: previous });
  return buildNegotiationCoachContext(lifetime, month, asOf);
}

export async function loadNegotiationCoachContext(params: { appUserId: number; serviceClient: SupabaseClient; asOf?: string }): Promise<NegotiationCoachContext> {
  const inputs = await loadNegotiationAnalyticsInputs({ client: params.serviceClient, appUserId: params.appUserId });
  return negotiationCoachContextFromInputs(inputs, params.asOf ?? torontoLocalDate());
}
