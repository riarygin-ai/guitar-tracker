// GT Lead Log import — row-level validation + classification (Part 6/7/12/13).
//
// Every applicable check runs and accumulates its own issue rather than
// short-circuiting on the first error, so one Preview pass surfaces the
// fullest possible picture of a row's problems (the whole point of this
// phase is to let a human "inspect all valid/invalid legacy rows" in one
// go). Classification is INVALID whenever any 'error'-severity issue
// exists; SOURCE_OLDER is a warning, never an error, and never blocks a
// row from being otherwise well-formed.
//
// Phase 2 note: this function additionally returns the row's `normalized`
// payload (non-null only for rows with no error-severity issue), so the
// importer applies exactly the values this validation pass accepted rather
// than re-parsing the sheet through a second set of rules. Preview strips
// that field before anything reaches a browser — see preview.ts.

import {
  KNOWN_CHANNEL_NAMES,
  LEAD_QUALITY_RANK,
  LEAD_QUALITY_VALUES,
  LEAD_STATUS_VALUES,
  OFFER_TYPE_VALUES,
  OUTCOME_REASON_VALUES,
  type LeadQuality,
  type LeadStatus,
  type NormalizedLeadRow,
  type OfferType,
  type OutcomeReason,
  type RawSheetRow,
  type RowClassification,
  type RowValidationResult,
  type ValidationIssue,
} from './types';
import { ROW_ISSUE, ROW_WARNING } from './errorCodes';
import {
  cellToDateStringOrNull,
  cellToIntegerOrNull,
  cellToNumberOrNull,
  cellToTrimmedStringOrNull,
  cellToUtcTimestampOrNull,
  isValidUuid,
} from './normalize';

export interface ExistingLeadInfo {
  inventoryItemId: number;
  sourceUpdatedAt: string; // ISO 8601 UTC
  leadQuality: LeadQuality;
}

export interface ValidationContext {
  sourceUserId: number;
  // Canonical channel name (lowercased) -> deal_channels.id. Only entries
  // for KNOWN_CHANNEL_NAMES are expected here.
  channelNameToId: Map<string, number>;
  // Existing item_leads for this source's user, keyed by lowercased lead_id.
  existingLeadsByLeadId: Map<string, ExistingLeadInfo>;
  // inventory_items.id -> owning app_users.id, for every item_id referenced
  // anywhere in the sheet.
  itemOwnerByItemId: Map<number, number>;
  // deals.id -> owning app_users.id, for every deal_id referenced anywhere
  // in the sheet.
  dealOwnerByDealId: Map<number, number>;
  // deals.id -> the set of inventory_items.id on that deal's OUTGOING
  // ('out') side — a Sell's sold item(s), or a Trade's given-away item(s).
  // Never the incoming/acquired side. Only entries for deal ids referenced
  // anywhere in the sheet.
  dealOutgoingItemIdsByDealId: Map<number, Set<number>>;
  // inventory_items.id -> the lowercased lead_id of the ONE existing
  // item_leads row (for this source's user) whose deal_id is currently
  // non-null — the item's current winning/linked lead, if any. Used to
  // reject a DIFFERENT lead trying to claim an already-linked item
  // (ITEM_ALREADY_LINKED_TO_ANOTHER_LEAD) while still allowing that same
  // winning lead to be updated/relinked (its own leadId matches).
  existingLinkedLeadIdByItemId: Map<number, string>;
}

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  ctx: { rowNumber: number; leadId: string | null; itemId: number | null; classification: RowClassification | null },
): ValidationIssue {
  return { severity, code, message, ...ctx };
}

function isKnownEnumValue<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

export function validateAndClassifyRow(raw: RawSheetRow, ctx: ValidationContext): RowValidationResult {
  const { rowNumber, cells } = raw;
  const issues: ValidationIssue[] = [];

  const at = (leadId: string | null, itemId: number | null) => ({ rowNumber, leadId, itemId, classification: null });

  // ── lead_id ────────────────────────────────────────────────────────────
  const leadIdRaw = cellToTrimmedStringOrNull(cells.lead_id);
  let leadId: string | null = null;
  if (leadIdRaw === null) {
    issues.push(issue('error', ROW_ISSUE.MISSING_LEAD_ID, 'lead_id is required.', at(null, null)));
  } else if (!isValidUuid(leadIdRaw)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_LEAD_ID, 'lead_id is not a valid UUID.', at(leadIdRaw, null)));
  } else {
    leadId = leadIdRaw.toLowerCase();
  }

  // ── item_id ────────────────────────────────────────────────────────────
  const itemIdParsed = cellToIntegerOrNull(cells.item_id);
  let itemId: number | null = null;
  if (!itemIdParsed.ok) {
    issues.push(issue('error', ROW_ISSUE.INVALID_ITEM_ID, 'item_id is not a valid integer.', at(leadId, null)));
  } else if (itemIdParsed.value === null) {
    issues.push(issue('error', ROW_ISSUE.MISSING_ITEM_ID, 'item_id is required.', at(leadId, null)));
  } else if (itemIdParsed.value <= 0) {
    issues.push(issue('error', ROW_ISSUE.INVALID_ITEM_ID, 'item_id must be a positive integer.', at(leadId, null)));
  } else {
    itemId = itemIdParsed.value;
  }

  const at2 = () => at(leadId, itemId);

  // ── updated_at (required) ─────────────────────────────────────────────
  const updatedAtParsed = cellToUtcTimestampOrNull(cells.updated_at);
  let sourceUpdatedAt: string | null = null;
  if (!updatedAtParsed.ok) {
    issues.push(issue('error', ROW_ISSUE.INVALID_UPDATED_AT, 'updated_at is not a valid UTC ISO-8601 timestamp.', at2()));
  } else if (updatedAtParsed.value === null) {
    issues.push(issue('error', ROW_ISSUE.MISSING_UPDATED_AT, 'updated_at is required.', at2()));
  } else {
    sourceUpdatedAt = updatedAtParsed.value;
  }

  // ── first/last contact dates ──────────────────────────────────────────
  const firstContactParsed = cellToDateStringOrNull(cells.first_contact_at);
  if (!firstContactParsed.ok) {
    issues.push(issue('error', ROW_ISSUE.INVALID_FIRST_CONTACT_DATE, 'first_contact_at is not a valid date (expected YYYY-MM-DD).', at2()));
  }
  const lastContactParsed = cellToDateStringOrNull(cells.last_contact_at);
  if (!lastContactParsed.ok) {
    issues.push(issue('error', ROW_ISSUE.INVALID_LAST_CONTACT_DATE, 'last_contact_at is not a valid date (expected YYYY-MM-DD).', at2()));
  }
  if (firstContactParsed.ok && lastContactParsed.ok && firstContactParsed.value && lastContactParsed.value) {
    if (lastContactParsed.value < firstContactParsed.value) {
      issues.push(issue('error', ROW_ISSUE.CONTACT_DATE_ORDER_INVALID, 'last_contact_at is before first_contact_at.', at2()));
    }
  }

  // ── channel ────────────────────────────────────────────────────────────
  const sourceChannel = cellToTrimmedStringOrNull(cells.channel);
  let dealChannelId: number | null = null;
  if (sourceChannel !== null) {
    const lower = sourceChannel.toLowerCase();
    if (lower === 'other') {
      dealChannelId = null;
    } else {
      const matchedId = ctx.channelNameToId.get(lower);
      if (matchedId !== undefined) {
        dealChannelId = matchedId;
      } else if (!KNOWN_CHANNEL_NAMES.some((n) => n.toLowerCase() === lower)) {
        issues.push(
          issue(
            'error',
            ROW_ISSUE.INVALID_CHANNEL,
            `channel "${sourceChannel}" is not one of ${KNOWN_CHANNEL_NAMES.join('/')}/Other or blank.`,
            at2(),
          ),
        );
      }
      // A known channel name with no matching deal_channels row (e.g. it
      // was renamed/deactivated) intentionally falls back to NULL rather
      // than being flagged invalid — the raw value is still preserved in
      // source_channel either way.
    }
  }

  // ── message counts ────────────────────────────────────────────────────
  const buyerCountParsed = cellToIntegerOrNull(cells.buyer_message_count);
  if (!buyerCountParsed.ok || (buyerCountParsed.value !== null && buyerCountParsed.value < 0)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_BUYER_MESSAGE_COUNT, 'buyer_message_count must be blank or a non-negative integer.', at2()));
  }
  const ourCountParsed = cellToIntegerOrNull(cells.our_message_count);
  if (!ourCountParsed.ok || (ourCountParsed.value !== null && ourCountParsed.value < 0)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_OUR_MESSAGE_COUNT, 'our_message_count must be blank or a non-negative integer.', at2()));
  }

  // ── lead_quality ───────────────────────────────────────────────────────
  const leadQualityRaw = cellToTrimmedStringOrNull(cells.lead_quality);
  let leadQuality: LeadQuality | null = null;
  if (leadQualityRaw === null) {
    issues.push(issue('error', ROW_ISSUE.MISSING_LEAD_QUALITY, 'lead_quality is required.', at2()));
  } else if (!isKnownEnumValue(LEAD_QUALITY_VALUES, leadQualityRaw)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_LEAD_QUALITY, `lead_quality "${leadQualityRaw}" is not a recognized value.`, at2()));
  } else {
    leadQuality = leadQualityRaw;
  }

  // ── offer_type ─────────────────────────────────────────────────────────
  const offerTypeRaw = cellToTrimmedStringOrNull(cells.offer_type);
  let offerType: OfferType | null = null;
  if (offerTypeRaw === null) {
    issues.push(issue('error', ROW_ISSUE.MISSING_OFFER_TYPE, 'offer_type is required.', at2()));
  } else if (!isKnownEnumValue(OFFER_TYPE_VALUES, offerTypeRaw)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_OFFER_TYPE, `offer_type "${offerTypeRaw}" is not a recognized value.`, at2()));
  } else {
    offerType = offerTypeRaw;
  }

  // ── cash offers ────────────────────────────────────────────────────────
  const initialCashParsed = cellToNumberOrNull(cells.initial_cash_offer);
  if (!initialCashParsed.ok || (initialCashParsed.ok && initialCashParsed.value !== null && initialCashParsed.value < 0)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_INITIAL_CASH_OFFER, 'initial_cash_offer must be blank or a non-negative number.', at2()));
  }
  const bestCashParsed = cellToNumberOrNull(cells.best_cash_offer);
  if (!bestCashParsed.ok || (bestCashParsed.ok && bestCashParsed.value !== null && bestCashParsed.value < 0)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_BEST_CASH_OFFER, 'best_cash_offer must be blank or a non-negative number.', at2()));
  }
  if (
    initialCashParsed.ok && bestCashParsed.ok &&
    initialCashParsed.value !== null && bestCashParsed.value !== null &&
    bestCashParsed.value < initialCashParsed.value
  ) {
    issues.push(issue('error', ROW_ISSUE.BEST_OFFER_LESS_THAN_INITIAL, 'best_cash_offer is less than initial_cash_offer.', at2()));
  }

  // ── cash_component (semantics depend on offer_type) ──────────────────
  // Canonical rule: offer_type TRADE means cash_component = 0 by
  // definition (1-for-1, 2-for-1, bundles — any straight trade). A BLANK
  // cash_component on a TRADE row is therefore NORMALIZED to 0 (with a
  // non-blocking warning) here, before classification/comparison/payload
  // construction, so the stored canonical value is 0 and a re-import of the
  // same unchanged Sheet row stays idempotent. The Sheet itself is never
  // written. Every other case keeps its strict semantics: an explicit
  // non-zero on TRADE is invalid (that is MIXED); MIXED + blank stays NULL
  // (cash involved, amount unknown), MIXED + 0 is invalid (known zero cash
  // is a TRADE); NONE/CASH must be blank.
  const cashComponentParsed = cellToNumberOrNull(cells.cash_component);
  let cashComponentValue: number | null = cashComponentParsed.ok ? cashComponentParsed.value : null;
  if (!cashComponentParsed.ok) {
    issues.push(issue('error', ROW_ISSUE.INVALID_CASH_COMPONENT, 'cash_component is not a valid number.', at2()));
  } else if (offerType === 'TRADE' && cashComponentValue === null) {
    cashComponentValue = 0;
    issues.push(issue('warning', ROW_WARNING.TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO, 'cash_component was blank for TRADE and was normalized to 0.', at2()));
  }
  if (cashComponentParsed.ok && offerType !== null) {
    const cashComponent = cashComponentValue;
    let semanticsOk = true;
    switch (offerType) {
      case 'TRADE':
        semanticsOk = cashComponent === 0;
        break;
      case 'MIXED':
        semanticsOk = cashComponent === null || cashComponent !== 0;
        break;
      case 'NONE':
      case 'CASH':
        semanticsOk = cashComponent === null;
        break;
    }
    if (!semanticsOk) {
      issues.push(
        issue(
          'error',
          ROW_ISSUE.INVALID_CASH_COMPONENT,
          `cash_component (${cashComponent ?? 'blank'}) is not valid for offer_type ${offerType}.`,
          at2(),
        ),
      );
    }
  }

  // ── trade_est_value ────────────────────────────────────────────────────
  const tradeEstValueParsed = cellToNumberOrNull(cells.trade_est_value);
  if (!tradeEstValueParsed.ok || (tradeEstValueParsed.ok && tradeEstValueParsed.value !== null && tradeEstValueParsed.value < 0)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_TRADE_EST_VALUE, 'trade_est_value must be blank or a non-negative number.', at2()));
  }

  // ── status ─────────────────────────────────────────────────────────────
  const statusRaw = cellToTrimmedStringOrNull(cells.status);
  let leadStatus: LeadStatus | null = null;
  if (statusRaw === null) {
    issues.push(issue('error', ROW_ISSUE.MISSING_STATUS, 'status is required.', at2()));
  } else if (!isKnownEnumValue(LEAD_STATUS_VALUES, statusRaw)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_STATUS, `status "${statusRaw}" is not a recognized value.`, at2()));
  } else {
    leadStatus = statusRaw;
  }

  // ── outcome_reason (nullable) ──────────────────────────────────────────
  const outcomeReasonRaw = cellToTrimmedStringOrNull(cells.outcome_reason);
  let outcomeReason: OutcomeReason | null = null;
  if (outcomeReasonRaw !== null && !isKnownEnumValue(OUTCOME_REASON_VALUES, outcomeReasonRaw)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_OUTCOME_REASON, `outcome_reason "${outcomeReasonRaw}" is not a recognized value.`, at2()));
  } else {
    outcomeReason = outcomeReasonRaw as OutcomeReason | null;
  }

  // ── deal_id (nullable; Sheet column S — optional header, absent on an
  // old A:R sheet, where every row's cells.deal_id is NULL) ───────────────
  const dealIdParsed = cellToIntegerOrNull(cells.deal_id);
  let dealId: number | null = null;
  if (!dealIdParsed.ok) {
    issues.push(issue('error', ROW_ISSUE.INVALID_DEAL_ID, 'deal_id is not a valid integer.', at2()));
  } else if (dealIdParsed.value !== null && dealIdParsed.value <= 0) {
    issues.push(issue('error', ROW_ISSUE.INVALID_DEAL_ID, 'deal_id must be a positive integer.', at2()));
  } else {
    dealId = dealIdParsed.value;
  }

  // ── deal_id <-> status semantics ──────────────────────────────────────
  // A) deal_id set requires status COMPLETED — never silently changed here.
  if (dealId !== null && leadStatus !== null && leadStatus !== 'COMPLETED') {
    issues.push(
      issue(
        'error',
        ROW_ISSUE.DEAL_ID_REQUIRES_COMPLETED_STATUS,
        `deal_id is set but status is "${leadStatus}", not COMPLETED.`,
        at2(),
      ),
    );
  }
  // B) COMPLETED with no deal_id stays VALID (historical rows predate
  // linking) — a non-blocking warning only, so links can be backfilled
  // gradually.
  if (dealId === null && leadStatus === 'COMPLETED') {
    issues.push(
      issue(
        'warning',
        ROW_WARNING.COMPLETED_WITHOUT_DEAL_ID,
        'status is COMPLETED with no deal_id — this lead has not yet been linked to a deal.',
        at2(),
      ),
    );
  }

  // ── deal ownership + item-role validation ─────────────────────────────
  // A lead represents buyer interest in the item being sold/traded OUT, so
  // the deal must both belong to this source's own user (never trust the
  // FK alone) and actually contain the lead's item on its OUTGOING side —
  // never merely as a trade's incoming/acquired item.
  if (dealId !== null) {
    const dealOwnerUserId = ctx.dealOwnerByDealId.get(dealId);
    if (dealOwnerUserId === undefined) {
      issues.push(issue('error', ROW_ISSUE.DEAL_NOT_FOUND, `Deal ${dealId} was not found.`, at2()));
    } else if (dealOwnerUserId !== ctx.sourceUserId) {
      // Never reveal anything about the other user's deal beyond its id.
      issues.push(issue('error', ROW_ISSUE.DEAL_NOT_OWNED_BY_SOURCE_USER, `Deal ${dealId} is not owned by this source's user.`, at2()));
    } else if (itemId !== null) {
      const outgoingItemIds = ctx.dealOutgoingItemIdsByDealId.get(dealId);
      if (!outgoingItemIds || !outgoingItemIds.has(itemId)) {
        issues.push(
          issue(
            'error',
            ROW_ISSUE.DEAL_ITEM_MISMATCH,
            `Deal ${dealId} does not have inventory item ${itemId} on its outgoing (sold/traded-away) side.`,
            at2(),
          ),
        );
      }
    }
  }

  // ── one linked lead per item ──────────────────────────────────────────
  // At most one lead may hold item ${itemId}'s link. A DIFFERENT existing
  // lead already holding it is rejected; the SAME lead relinking (e.g.
  // deal_id 500 -> 501) is allowed — it is not "another" lead. Sheet-
  // internal conflicts (two rows in this same import both claiming the
  // same item) are caught separately, after every row has been classified
  // once — see preview.ts's applyDealLinkConflicts().
  if (dealId !== null && itemId !== null) {
    const existingLinkedLeadId = ctx.existingLinkedLeadIdByItemId.get(itemId);
    if (existingLinkedLeadId !== undefined && existingLinkedLeadId !== leadId) {
      issues.push(
        issue(
          'error',
          ROW_ISSUE.ITEM_ALREADY_LINKED_TO_ANOTHER_LEAD,
          `Inventory item ${itemId} is already linked to a different lead's completed deal.`,
          at2(),
        ),
      );
    }
  }

  // ── free-text passthrough fields (never validated beyond blank -> NULL) ─
  const tradeItem = cellToTrimmedStringOrNull(cells.trade_item);
  const notes = cellToTrimmedStringOrNull(cells.notes);

  // ── item ownership (Part 5) — runs whenever item_id parsed, regardless
  // of other field errors ───────────────────────────────────────────────
  if (itemId !== null) {
    const ownerUserId = ctx.itemOwnerByItemId.get(itemId);
    if (ownerUserId === undefined) {
      issues.push(issue('error', ROW_ISSUE.ITEM_NOT_FOUND, `Inventory item ${itemId} was not found.`, at2()));
    } else if (ownerUserId !== ctx.sourceUserId) {
      issues.push(issue('error', ROW_ISSUE.ITEM_NOT_OWNED_BY_SOURCE_USER, `Inventory item ${itemId} is not owned by this source's user.`, at2()));
    }
  }

  // ── existing-lead cross-check + classification (Part 12) ─────────────
  let classification: RowClassification = 'NEW';
  const existing = leadId !== null ? ctx.existingLeadsByLeadId.get(leadId) : undefined;

  if (existing) {
    if (itemId !== null && existing.inventoryItemId !== itemId) {
      issues.push(
        issue(
          'error',
          ROW_ISSUE.ITEM_MISMATCH_WITH_EXISTING_LEAD,
          `This lead_id already exists for inventory item ${existing.inventoryItemId}, not ${itemId}.`,
          at2(),
        ),
      );
    }
    if (leadQuality !== null && LEAD_QUALITY_RANK[leadQuality] < LEAD_QUALITY_RANK[existing.leadQuality]) {
      issues.push(
        issue(
          'error',
          ROW_ISSUE.LEAD_QUALITY_REGRESSION,
          `lead_quality would regress from ${existing.leadQuality} to ${leadQuality}.`,
          at2(),
        ),
      );
    }

    if (sourceUpdatedAt !== null) {
      if (sourceUpdatedAt > existing.sourceUpdatedAt) {
        classification = 'UPDATE';
      } else if (sourceUpdatedAt === existing.sourceUpdatedAt) {
        classification = 'UNCHANGED';
      } else {
        classification = 'SOURCE_OLDER';
        issues.push(
          issue(
            'warning',
            ROW_WARNING.SOURCE_OLDER,
            'This sheet row is older than the stored version — it will not be applied.',
            at2(),
          ),
        );
      }
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  if (hasErrors) classification = 'INVALID';

  const finalIssues = issues.map((i) => ({ ...i, classification }));

  // ── Normalized payload (Phase 2) ──────────────────────────────────────
  // Built only from values this very pass accepted, and only when the row
  // carries no error-severity issue — so an INVALID row can never produce
  // something writable. Every non-null assertion below is guarded by
  // `!hasErrors`: each of these fields raises an error-severity issue when
  // it fails to parse or is missing.
  const normalized: NormalizedLeadRow | null =
    hasErrors ||
    leadId === null ||
    itemId === null ||
    sourceUpdatedAt === null ||
    leadQuality === null ||
    offerType === null ||
    leadStatus === null
      ? null
      : {
          sheetRowNumber: rowNumber,
          leadId,
          inventoryItemId: itemId,
          firstContactAt: firstContactParsed.ok ? firstContactParsed.value : null,
          lastContactAt: lastContactParsed.ok ? lastContactParsed.value : null,
          sourceChannel,
          dealChannelId,
          buyerMessageCount: buyerCountParsed.ok ? buyerCountParsed.value : null,
          ourMessageCount: ourCountParsed.ok ? ourCountParsed.value : null,
          leadQuality,
          offerType,
          initialCashOffer: initialCashParsed.ok ? initialCashParsed.value : null,
          bestCashOffer: bestCashParsed.ok ? bestCashParsed.value : null,
          tradeItem,
          cashComponent: cashComponentValue,
          tradeEstValue: tradeEstValueParsed.ok ? tradeEstValueParsed.value : null,
          status: leadStatus,
          outcomeReason,
          notes,
          dealId,
          sourceUpdatedAt,
        };

  return {
    rowNumber,
    leadId,
    itemId,
    classification,
    issues: finalIssues,
    normalized,
    parsedSourceUpdatedAt: sourceUpdatedAt,
  };
}
