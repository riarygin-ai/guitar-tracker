// Shared AI semantics for every advice surface that can see Listing Demand
// evidence: the general Business Coach (analytics-advice-v*) and the
// /listings Listing Advice (listing-advice-v*). ONE copy, imported by both
// system prompts, so the rules cannot drift apart.
//
// The most important rule here exists because of an observed live failure:
// the general Coach described "high leads + low realized deals" as "low deal
// conversion ... lead management or listing presentation". There is NO
// canonical lead_id -> deal_id linkage, so no conversion exists to be low or
// high, and a gap between the two counts explains nothing on its own.
//
// The same rules are enforced AFTER generation by findLeadDealViolations()
// (pure, below): a response that asserts conversion or explains the
// lead/deal gap as a cause is rejected by the validators rather than shown.

export const PURPOSE_SEMANTICS = `Purpose semantics (apply consistently):
- Business: inventory actively managed for realization and turnover.
- Hybrid: a genuine combination of realization and personal interest — reviewing it does not mean it should become Business.
- Personal: held primarily for enjoyment, collection, or appreciation — not a failure state.`;

export const LEAD_DEAL_RULES = `Leads and deals (hard rules):
- There is currently NO canonical lead_id -> deal_id linkage. Realized deals (realized_deal_count and realized_deal_count_by_recorded_channel) are factual Sell/Trade activity during a period; lead counts are recorded buyer conversations. They are two separate facts.
- NEVER describe the relationship between lead counts and realized deal counts as conversion, conversion rate, low conversion, high conversion, poor conversion, lead-to-sale conversion, leads turning into deals, leads converting, close rate, or closing rate. Never state or imply a lead-to-deal conversion rate or funnel. If asked whether leads are converting, say that this cannot currently be determined from the evidence.
- Do not calculate realized_deals / leads or any equivalent ratio, and do not imply that deals observed in a period originated from that period's leads. A deal may come from an earlier lead or from no logged lead.
- Factual side-by-side statements ARE allowed, for example "Recorded lead activity was high while realized deal activity in the same period was lower" or "Marketplace recorded 23 attributed leads and 0 realized deals by recorded channel in the latest week" — always keeping the distinction that they are not directly linked. Never turn such a statement into "converted poorly" or any equivalent.
- A gap between lead activity and realized deals does NOT by itself indicate poor follow-up, bad listing presentation, bad pricing, negotiation failure, low-quality leads, or a poor sales process. Do not assert any of these as the explanation. You MAY name one as something worth CHECKING (for example reviewing offer history, pricing, or follow-up), clearly worded as a check or hypothesis, never as the cause.
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

/** Every string in an arbitrary JSON-ish value, for whole-response scanning. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((v) => collectStrings(v, out));
  return out;
}
