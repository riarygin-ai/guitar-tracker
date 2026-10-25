// Short ⓘ help copy for the /leads screen (rendered via components/InfoTip).
// Definitions only — never an interpretation of a value.

export const LEAD_HELP = {
  negotiatingPlus: {
    label: 'Negotiating+',
    text: 'Leads whose peak stage reached Negotiating, High Intent or Converted. Older Lead Log leads without a peak stage count when their legacy quality was Serious or High Intent.',
  },
  stage: {
    label: 'Stage',
    text: 'Peak stage: the highest point the lead has reached — Inquiry, Engaged, Negotiating, High intent, Converted.',
  },
  messages: {
    label: 'Messages',
    text: 'Buyer messages / our messages. Counts are the current lifetime totals stored for this lead.',
  },
  tradeEstValue: {
    label: 'Trade Estimated Value',
    text: 'Working estimated value recorded for the offered trade item. It is not necessarily the buyer’s asking price.',
  },
  cashComponent: {
    label: 'Cash Component',
    text: 'Positive means cash to us. Negative means cash from us.',
  },
  itemAttributed: {
    label: 'Listing-attributed',
    text: 'Only leads whose first contact occurred while this item had active listing exposure during the selected period.',
  },
  attributed: {
    label: 'Channel-attributed',
    text: 'Leads on this channel whose item was actually listed there on the day of first contact — the same set counted on the Listings page.',
  },
} as const;

export type LeadHelpKey = keyof typeof LEAD_HELP;
