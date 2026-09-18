// Short ⓘ help copy for the /leads screen (rendered via components/InfoTip).
// Definitions only — never an interpretation of a value.

export const LEAD_HELP = {
  seriousPlus: {
    label: 'Serious+',
    text: 'Leads that reached Serious or High Intent. Quality reflects the highest level the lead has reached.',
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
  attributed: {
    label: 'Channel-attributed',
    text: 'Leads on this channel whose item was actually listed there on the day of first contact — the same set counted on the Listings page.',
  },
} as const;

export type LeadHelpKey = keyof typeof LEAD_HELP;
