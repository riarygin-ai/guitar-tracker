// Short contextual-help copy for the Listings dashboard's ⓘ controls
// (src/components/InfoTip.tsx). Kept in a plain module so tests can assert
// the definitions exist without rendering React. Wording is factual —
// definitions only, never an interpretation of a value.

export const LISTING_HELP = {
  leadsPer100ChannelDays: {
    label: 'Leads / 100 Channel-Days',
    text: 'Attributed leads per 100 days of listing exposure across channels. This normalizes lead activity so periods with different listing exposure can be compared.',
  },
  channelListingDays: {
    label: 'Channel Listing Days',
    text: 'One item listed on one channel for one calendar day equals one Channel Listing Day. Example: 10 items listed for 7 days equals 70 Channel Listing Days.',
  },
  avgChannelExposure: {
    label: 'Avg Channel Exposure',
    text: 'Average number of active item-channel listings per day during the week.',
  },
  seriousPlus: {
    label: 'Serious+',
    text: 'Leads that reached Serious or High Intent. Lead quality reflects the highest level the lead has reached, not necessarily its initial state.',
  },
  realizedDeals: {
    label: 'Realized Deals',
    text: 'Completed Sell/Trade activity during the week. Deals are shown alongside leads but are not treated as lead conversions.',
  },
  leadActivityByItem: {
    label: 'Lead Activity by Item',
    text: 'Open inventory items (listed or not) that have generated leads. Counts cover each item’s full lead history; sorted by most recent buyer activity by default.',
  },
  itemLeads: {
    label: 'Leads',
    text: 'All leads ever recorded for the item.',
  },
  itemNegotiatingPlus: {
    label: 'Negotiating+',
    text: 'Leads that reached Negotiating, High Intent or Converted (peak stage — the highest stage reached, not the current one).',
  },
  itemOffers: {
    label: 'Offers',
    text: 'Leads with a recorded CASH, TRADE, or MIXED offer.',
  },
  itemChannelDays: {
    label: 'Channel Days',
    text: 'Total days the item has been listed, summed across every channel and listing cycle. One item listed on one channel for one day equals one Channel Day.',
  },
  itemLastActivity: {
    label: 'Last Activity',
    text: 'The most recent contact on any of the item’s leads (messages or offers), not when the newest lead first appeared.',
  },
  channelDays: {
    label: 'Channel Days',
    text: 'Total item-channel listing exposure during the selected Trend Window. One item listed on one channel for one day equals one Channel Day.',
  },
  offersAttributed: {
    label: 'Offers',
    text: 'Attributed leads with a recorded CASH, TRADE, or MIXED offer.',
  },
} as const;

export type ListingHelpKey = keyof typeof LISTING_HELP;
