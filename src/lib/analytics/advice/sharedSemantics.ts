// Shared AI semantics for every advice surface that can see Listing Demand
// evidence: the general Business Coach (analytics-advice-v*) and the
// /listings Listing Advice (listing-advice-v*). ONE copy, imported by both
// system prompts, so the rules cannot drift apart.
//
// The most important rule here exists because of an observed live failure:
// the general Coach described "high leads + low realized deals" as "low deal
// conversion ... lead management or listing presentation" — comparing raw
// lead counts against realized_deal_count, an aggregate, UNLINKED fact, as
// if that comparison were a conversion rate. That specific comparison is
// still never a conversion (see below) and Listing Advice, whose evidence
// never includes any linkage, can still never make a conversion claim.
//
// What HAS changed: a genuine, narrow, canonical linkage now exists wherever
// item_leads.deal_id is populated (supabase/migrations/20260925000000_item_
// leads_deal_id.sql onward) — the Coach (never Listing Advice) may receive
// this as linked_deal_analytics (linkedDealAnalytics.ts), with its own
// `linked_deal:*` citable sources. A conversion claim is allowed ONLY when a
// card cites one of those sources; validateAdviceResponse.ts enforces this
// per-card (a card's own findLeadDealViolations hit is only excused when
// that card's source_ids include a `linked_deal:*` id) — the pure detector
// below is unchanged, only its caller's gating is.
//
// LEAD_DEAL_GAP_EXPLAINED (a causal explanation of the lead/realized-deal
// gap) stays unconditionally forbidden everywhere, linkage or not — that
// rule is about NOT inventing a cause for an unlinked comparison, which
// linkage doesn't change.

export const PURPOSE_SEMANTICS = `Purpose semantics (apply consistently):
- Business: inventory actively managed for realization and turnover.
- Hybrid: a genuine combination of realization and personal interest — reviewing it does not mean it should become Business.
- Personal: held primarily for enjoyment, collection, or appreciation — not a failure state.`;

export const LEAD_DEAL_RULES = `Leads and deals (hard rules):
- Canonical Lead -> Deal linkage exists ONLY where item_leads.deal_id is populated for a specific lead — narrow, and historically incomplete. When available in this packet it is provided as linked_deal_analytics (source ids prefixed "linked_deal:"). Nothing else here is linkage: realized deals (realized_deal_count and realized_deal_count_by_recorded_channel) remain a SEPARATE, unlinked, aggregate fact — factual Sell/Trade activity during a period; lead counts are recorded buyer conversations. Comparing those two remains two separate facts, exactly as before.
- NEVER describe the relationship between raw lead counts and realized deal counts as conversion, conversion rate, low conversion, high conversion, poor conversion, lead-to-sale conversion, leads turning into deals, leads converting, close rate, or closing rate. Never state or imply a lead-to-deal conversion rate or funnel from that comparison. If asked whether leads are converting and no linked_deal_analytics evidence is being cited, say that this cannot currently be determined from the evidence.
- A conversion, "linked deal rate", or "conversion to date" claim may ONLY be made by explicitly citing linked_deal_analytics evidence (a linked_deal:* source id) or, for the negotiation funnel, negotiation_analytics evidence (a negotiation:* source id, whose converted counts are leads that themselves reached CONVERTED) for the specific cohort/channel discussed — never inferred from realized_deal_count or any other uncited combination of fields.
- When citing linked_deal_analytics, always account for linkage coverage (completed_link_coverage_pct) before stating any rate: a low coverage means many historical COMPLETED leads simply have not been linked yet — that is INCOMPLETE LINKAGE, never a failed conversion. Never claim a lead "did not convert" merely because it has no deal_id — say it is unlinked, or not yet linked.
- For a recent or still-OPEN lead cohort, call any such rate "linked deal rate to date" or "observed conversion to date" — never final or complete conversion; an open lead has not necessarily reached its final outcome.
- Do not calculate realized_deals / leads or any other new ratio outside of linked_deal_analytics's own already-computed rates, and do not imply that deals observed in a period originated from that period's leads. A deal may come from an earlier lead or from no logged lead.
- Factual side-by-side statements ARE allowed, for example "Recorded lead activity was high while realized deal activity in the same period was lower" or "Marketplace recorded 23 attributed leads and 0 realized deals by recorded channel in the latest week" — always keeping the distinction that they are not directly linked. Never turn such a statement into "converted poorly" or any equivalent.
- A gap between unlinked lead activity and realized deals does NOT by itself indicate poor follow-up, bad listing presentation, bad pricing, negotiation failure, low-quality leads, or a poor sales process. Do not assert any of these as the explanation. You MAY name one as something worth CHECKING (for example reviewing offer history, pricing, or follow-up), clearly worded as a check or hypothesis, never as the cause.
- Keep FACT separate from HYPOTHESIS/CHECK: state what the evidence shows first; put any possible explanation afterwards and label it as something to check ("may be worth checking", "a possible check", "if the gap persists").`;

export const LISTING_DEMAND_SEMANTICS = `Listing Demand semantics (apply only when listing_demand is present; all rules above still apply):
- Listing Demand evidence is factual buyer/listing activity evidence over four consecutive weekly buckets. It is completely Purpose-agnostic: it covers every currently listed item regardless of Business/Hybrid/Personal Purpose, and no Purpose filtering was applied to it.
- channel_listing_days measures item x channel x calendar-day exposure. item_listing_days measures item x calendar-day exposure regardless of how many channels the item is listed on. avg_listed_items and avg_channel_exposure are the corresponding daily averages.
- Compare lead volume TOGETHER WITH exposure. Raw leads can rise simply because more was listed. leads_per_100_channel_listing_days is the preferred normalized channel-response metric: when judging whether buyer response changed, prefer it (and exposure alongside it) over raw lead counts. Say plainly when leads changed but exposure changed by a similar amount, or when exposure was nearly flat. Example: leads +80% with exposure +10% means recorded response per exposure materially increased; leads +50% with exposure +50% means raw volume rose while normalized response may be about unchanged.
- lead_quality is the highest intent level a lead has reached, not necessarily its quality when the lead began. Serious+ means SERIOUS or HIGH_INTENT under that highest-ever rule. Offers (offer_attributed_leads) counts leads with a recorded CASH, TRADE, or MIXED offer, at most one per lead.
- Item-attributed means the lead's first contact occurred while that item had valid listing exposure (on any channel). Channel-attributed additionally requires matching item/channel listing exposure on that date. A lead with no normalized channel can still be item-attributed but is never channel-attributed.
- Realized deals: follow the "Leads and deals (hard rules)" section exactly.
- Lead Log completeness may differ across periods and channels (see data_quality). A low lead count may reflect incomplete logging, and small counts are weak evidence — mention sample size and completeness when they matter.
- Observational only: never claim that listing on a channel, cross-listing, or any action caused demand or that "the market improved because...". Use language such as "associated with", "coincided with", "response per exposure increased/decreased", and "recorded lead activity was higher/lower". Avoid "caused", "drove", "resulted in", and "proves" unless the evidence genuinely establishes it.
- Channels: you may compare channels factually (normalized response, multi-week direction, substantial exposure with little recorded lead activity) and may suggest operational experiments such as reviewing listing quality, pricing, channel fit, adjusting exposure, or checking that leads are being logged completely — always explaining the evidence. Never recommend removing or abandoning a channel merely because its lead rate is low: a channel can produce a sale with little recorded conversation, and realized deals are a separate fact from lead activity. Substantial exposure with few recorded leads describes recorded conversation activity; by itself it does not imply weak realized sales.
- Items: describe item-level patterns factually (for example "generated 12 attributed leads over the last four weeks" or "accumulated 84 channel-days of exposure with no attributed leads"). Do NOT create labels such as HOT, COLD, WINNER, or LOSER, and do not invent scores or grades. highest_activity and zero_activity_high_exposure are deterministic selections, not a complete list: currently_listed_count, with_attributed_leads_count and without_attributed_leads_count tell you how many currently listed items exist in total. Do not automatically recommend price cuts for zero-lead items; possible checks include pricing, listing presentation, channel fit, listing completeness, or whether continued listing is still intended.
- When an action card concerns a specific item, continue to apply the Purpose semantics below (Business: realization/turnover advice is appropriate; Hybrid: selective, never assume it should sell quickly; Personal: analyze economically but never pressure a sale because demand is weak or holding time is long).`;

export const NEGOTIATION_SEMANTICS = `Negotiation semantics (apply only when negotiation_analytics is present; all rules above still apply):
- negotiation_analytics is the output of ONE deterministic negotiation engine. Quote its numbers; never compute new negotiation rates, percentages, gaps or round counts yourself. Every part you may cite carries a source_id beginning "negotiation:".
- It is DESCRIPTIVE HISTORY, never prediction. Never state or imply a probability, chance, likelihood or forecast of acceptance, rejection, closing or a deal ("70% chance", "buyers will reject", "likely to accept"). Use "historically", "in this sample", "compared with your other negotiations".
- Whenever you cite a rate, give its count and sample size (for example "26 of 279", "n=41"). Every rate is shown as count/sample_size (rate%, evidence_strength).
- evidence_strength is deterministic (insufficient <10, low 10-29, moderate 30-99, stronger 100+). Treat 'low' as preliminary and say so; never build a finding on anything listed in suppressed — at most say that the evidence is still accumulating.
- Coverage first: most Negotiating+ leads are legacy (stage from a snapshot/audit) and have no round or counter detail. When citing rounds, counters or counter size, state how many leads they cover (event_sequence_eligible_leads, our_counter_count) against negotiating_plus_leads.
- Keep outcomes separate. DECLINED_BY_ME is our own decision (often TRADE_NOT_INTERESTING or PRICE) — intentional filtering, never a buyer loss, a failed negotiation or poor conversion; a large share means raw conversion understates lead filtering (negotiating_to_converted_excluding_declined_by_me shows that view). DECLINED_BY_THEM and GHOSTED are buyer-side endings and stay separate from each other. CLOSED (ITEM_UNAVAILABLE) is neutral: the item left via another deal, and only one lead can realize an item. FAILED_AFTER_AGREEMENT is its own outcome.
- Fact, pattern, interpretation, recommendation — keep them distinct and in that order: what the numbers show, what they suggest (hedged), then at most a behavioural review suggestion ("consider reviewing..."). Never prescribe an exact counter price or offer amount, and never give "always"/"never" advice.
- Cash vs Trade vs Mixed: a lower trade conversion is not by itself evidence that trade is bad — trades have different profit and liquidity economics. Describe the difference; suggest reviewing trade expectations only when the evidence supports it.
- Channels: keep small channel samples qualified; do not rank channels on low-strength samples.
- month_comparison contains only material differences (both sides at least 'low', at least 10 percentage points) over RESOLVED leads; the current month is to date, so mention how many of its leads are still open.
- Surface negotiation only when it is consequential. Use at most one card for it, and never let it crowd out the Business inventory action (rule 13). If negotiation evidence is neutral or thin, leave it out.`;

// ── Post-generation guard ────────────────────────────────────────────────
// Pure text checks applied to every model-written string. Deliberately
// narrow so legitimate DISCLAIMERS ("there is no lead-to-deal conversion
// that can be calculated") pass: a sentence is only flagged when it uses
// conversion vocabulary WITHOUT any negation/limit cue, or when it explains
// the lead/deal gap with a causal/diagnostic claim and no hedge.

export type LeadDealViolation = 'CONVERSION_CLAIM' | 'LEAD_DEAL_GAP_EXPLAINED';

const CONVERSION_TERMS: RegExp[] = [
  /\bconver(?:sion|sions|ted|ting|t|ts)\b/i,
  /\bclos(?:e|ing) rates?\b/i,
  /\bleads?\b[^.]{0,30}\b(?:turn|turns|turning|turned)\b[^.]{0,15}\binto\b[^.]{0,10}\b(?:deals?|sales?)\b/i,
  /\blead[- ]to[- ](?:deal|sale)/i,
];
// Conversion vocabulary that is ALWAYS a claim about how leads perform, even when negated
// ("leads are not converting", "failed to convert", "convert poorly"). A bare disclaimer such as
// "no lead-to-deal conversion can be calculated" does not match these.
const ALWAYS_FLAGGED: RegExp[] = [
  /\b(?:not|n't|never|fail\w*\s+to|unable to)\s+(?:really\s+|yet\s+|effectively\s+)?convert(?:ing|ed|s)?\b/i,
  /\bconvert(?:s|ing|ed)?\s+(?:poorly|well|badly|weakly|strongly|at\b)/i,
  /\b(?:low|poor|weak|high|strong|good|bad|healthy|weaker|stronger)\s+(?:deal\s+|sales?\s+|lead[- ]to[- ](?:deal|sale)\s+)?conversions?\b/i,
];
const NEGATION_CUES = /\b(no|not|cannot|can't|can not|isn't|aren't|wasn't|weren't|without|never|nor|neither|unable|unlinked|absence|lacks?|nothing)\b/i;
const CAUSAL_CUES = /\b(indicat(?:e|es|ed|ing)|explain(?:s|ed|ing)?|suggest(?:s|ed|ing)? (?:a |an )?(?:problem|issue|weakness)|because of|due to|caused by|points? to|reflects?|signals?|means that)\b/i;
// A negation DIRECTLY attached to the causal verb ("does not explain", "cannot indicate") cancels that cue.
const NEGATED_CAUSAL = /\b(?:does|do|did|is|are|was|were|would|could|can|may|might)?\s*(?:not|n't|never)\s+(?:\w+\s+){0,2}(?:explain\w*|indicat\w*|mean|signal\w*|reflect\w*|point\w*|establish\w*)/gi;
const GAP_EXPLANATIONS = /\b(lead management|listing presentation|poor follow-?up|bad follow-?up|follow-?up (?:issues?|problems?)|pricing (?:issues?|problems?)|negotiation (?:issues?|failures?)|low[- ]quality leads|sales process|presentation issues?)\b/i;
const HEDGE_CUES = /\b(check|checking|review|reviewing|whether|worth|may help|might|could|possible|if the gap persists|hypothes)/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+|;/).map((s) => s.trim()).filter(Boolean);
}

// Russian output must obey the same no-fake-conversion rule. JS \b is ASCII-only, so these use plain
// stems (no word boundaries). A disclaimer with a Russian negation cue ("нет конверсии", "нельзя оценить
// конверсию") passes; an unqualified claim, or a quality-qualified/negated verb, is flagged.
const RU_CONVERSION_TERMS: RegExp[] = [/конверси/i, /конвертир/i, /конвертац/i];
const RU_ALWAYS_FLAGGED: RegExp[] = [
  /(?:низк|плох|слаб|высок|сильн|хорош|здоров)\S*\s+(?:лид\S*\s+)?конверси/i,
  /не\s+(?:\S+\s+)?конвертир/i,
  /конвертир\S*\s+(?:плохо|хорошо|слабо|сильно)/i,
];
const RU_NEGATION_CUES = /(?:^|[^а-яё])(?:нет|нельзя|невозможно|отсутствует|отсутствуют|без|не\s+(?:может|можем|можно|удаётся|удается|определить|рассчит\S*|связан\S*))(?![а-яё])/i;

/** Returns the violations found in `text` (empty when the text is acceptable). */
export function findLeadDealViolations(text: string): LeadDealViolation[] {
  const found = new Set<LeadDealViolation>();
  for (const sentence of sentences(text)) {
    if (RU_ALWAYS_FLAGGED.some((re) => re.test(sentence)) || (RU_CONVERSION_TERMS.some((re) => re.test(sentence)) && !RU_NEGATION_CUES.test(sentence))) {
      found.add('CONVERSION_CLAIM');
    }
    if (ALWAYS_FLAGGED.some((re) => re.test(sentence)) || (CONVERSION_TERMS.some((re) => re.test(sentence)) && !NEGATION_CUES.test(sentence))) {
      found.add('CONVERSION_CLAIM');
    }
    const mentionsLeads = /\bleads?\b/i.test(sentence);
    const mentionsDeals = /\b(deals?|sales?|sold)\b/i.test(sentence);
    const causal = CAUSAL_CUES.test(sentence.replace(NEGATED_CAUSAL, ' '));
    if (mentionsLeads && mentionsDeals && GAP_EXPLANATIONS.test(sentence) && causal && !HEDGE_CUES.test(sentence)) {
      found.add('LEAD_DEAL_GAP_EXPLAINED');
    }
  }
  return Array.from(found);
}

// Predictive language: descriptive negotiation history must never be turned into a forecast.
// Narrow on purpose — "historically 29% replied" passes; "a 70% chance of rejection" does not.
const PREDICTIVE_PATTERNS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*%\s*(?:chance|probability|likelihood|odds)\b/i,
  /\b(?:chance|probability|likelihood|odds)\s+(?:of|that|to)\s+(?:\w+\s+){0,2}(?:accept\w*|reject\w*|clos\w*|conver\w*|deal|sale|success|declin\w*|ghost\w*|walk\w*)/i,
  /\b(?:close|closing|acceptance|rejection|deal|conversion|win)\s+probability\b/i,
  /\bbuyers?\s+will\s+(?:\w+\s+)?(?:reject|accept|walk|ghost|disappear|decline|counter|leave)\b/i,
  /\b(?:is|are)\s+(?:very\s+)?likely\s+to\s+(?:accept|reject|close|convert|decline|ghost|walk)\b/i,
  /\d+(?:[.,]\d+)?\s*%\s*(?:вероятност|шанс)/i,
  /(?:вероятност|шанс)\S*\s+(?:\S+\s+)?(?:отказа|принятия|сделки|закрытия|успеха|продажи)/i,
];

/** True when `text` contains a predictive claim (a probability/forecast of a negotiation outcome). */
export function hasPredictiveClaim(text: string): boolean {
  return PREDICTIVE_PATTERNS.some((re) => re.test(text));
}

/** Every string in an arbitrary JSON-ish value, for whole-response scanning. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((v) => collectStrings(v, out));
  return out;
}
