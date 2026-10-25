// Pure Save gate for the Sell / Trade winning-lead field (no React, no I/O).

import type { LeadChoice, OperationLeadCandidate } from './operationLeadsClient';

/** idle = no outgoing items yet; loading / error = lead state unknown; ready = known. */
export type LeadLookupState = 'idle' | 'loading' | 'error' | 'ready';

export interface LeadPickerAvailability {
  lookup: LeadLookupState;
  /** The field is shown and a choice is required before Save. */
  required: boolean;
  /** Edit flow: the lead already linked to this operation (read-only). */
  linked: OperationLeadCandidate | null;
}

/**
 * Why Save must wait, or null. A lookup that is still running or failed means
 * the form does not know whether eligible leads exist — never treated as an
 * implicit "No matching lead".
 */
export function leadSaveBlocker(a: LeadPickerAvailability, choice: LeadChoice): string | null {
  if (a.lookup === 'loading') return 'Still checking this operation\'s leads — try Save again in a moment.';
  if (a.lookup === 'error') return 'Couldn\'t check whether these items have logged leads. Use Retry next to Lead, then save.';
  if (a.required && choice.kind === 'unset') return 'Choose the winning lead, or "No matching lead" if the buyer wasn\'t logged.';
  return null;
}
