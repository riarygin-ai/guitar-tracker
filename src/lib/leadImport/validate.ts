// GT Lead Log import — row-level validation + classification (Part 6/7/12/13).
//
// Every applicable check runs and accumulates its own issue rather than
// short-circuiting on the first error, so one Preview pass surfaces the
// fullest possible picture of a row's problems (the whole point of this
// phase is to let a human "inspect all valid/invalid legacy rows" in one
// go). Classification is INVALID whenever any 'error'-severity issue
// exists; SOURCE_OLDER is a warning, never an error, and never blocks a
// row from being otherwise well-formed.

import {
  KNOWN_CHANNEL_NAMES,
  LEAD_QUALITY_RANK,
  LEAD_QUALITY_VALUES,
  LEAD_STATUS_VALUES,
  OFFER_TYPE_VALUES,
  OUTCOME_REASON_VALUES,
  type LeadQuality,
  type OfferType,
  type RawSheetRow,
  type RowClassification,
  type RowPreviewResult,
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

export function validateAndClassifyRow(raw: RawSheetRow, ctx: ValidationContext): RowPreviewResult {
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

  // ── cash_component (semantics depend on offer_type — never coerce NULL
  // to 0) ────────────────────────────────────────────────────────────────
  const cashComponentParsed = cellToNumberOrNull(cells.cash_component);
  if (!cashComponentParsed.ok) {
    issues.push(issue('error', ROW_ISSUE.INVALID_CASH_COMPONENT, 'cash_component is not a valid number.', at2()));
  } else if (offerType !== null) {
    const cashComponent = cashComponentParsed.value;
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
  if (statusRaw === null) {
    issues.push(issue('error', ROW_ISSUE.MISSING_STATUS, 'status is required.', at2()));
  } else if (!isKnownEnumValue(LEAD_STATUS_VALUES, statusRaw)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_STATUS, `status "${statusRaw}" is not a recognized value.`, at2()));
  }

  // ── outcome_reason (nullable) ──────────────────────────────────────────
  const outcomeReasonRaw = cellToTrimmedStringOrNull(cells.outcome_reason);
  if (outcomeReasonRaw !== null && !isKnownEnumValue(OUTCOME_REASON_VALUES, outcomeReasonRaw)) {
    issues.push(issue('error', ROW_ISSUE.INVALID_OUTCOME_REASON, `outcome_reason "${outcomeReasonRaw}" is not a recognized value.`, at2()));
  }

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

  return { rowNumber, leadId, itemId, classification, issues: finalIssues };
}
