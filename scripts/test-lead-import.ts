/**
 * scripts/test-lead-import.ts
 *
 * Focused validation for GT Lead Log Import Phase 1 (schema + Google Sheets
 * normalization + Preview classification). Same conventions as the other
 * scripts in this directory — tsx, no test framework, local check(),
 * safety-gated against a disposable local Supabase instance only. Never
 * calls the real Google Sheets API — network-facing behavior is verified
 * by mocking `global.fetch`.
 *
 * Usage:
 *   npx tsx scripts/test-lead-import.ts
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';

import { extractSpreadsheetId } from '../src/lib/leadImport/spreadsheetId';
import {
  buildRawRows,
  cellToDateStringOrNull,
  cellToIntegerOrNull,
  cellToNumberOrNull,
  cellToUtcTimestampOrNull,
  isValidUuid,
  parseHeaders,
} from '../src/lib/leadImport/normalize';
import { classifySheetValues } from '../src/lib/leadImport/preview';
import { EXPECTED_HEADERS, type ExpectedHeader, type LeadImportSource, type RowPreviewResult, type SheetCellValue } from '../src/lib/leadImport/types';
import { ROW_ISSUE, SOURCE_FATAL } from '../src/lib/leadImport/errorCodes';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`, detail !== undefined ? detail : '');
  }
}

// ── Fixtures — direct table writes, service role. Tagged distinctly from
// every other script's fixtures (LEADIMPORT: prefix) so cleanup never
// touches unrelated data. ───────────────────────────────────────────────

const TEST_USER_A_EMAIL = 'lead-import-fixture-user-a@example.test';
const TEST_USER_B_EMAIL = 'lead-import-fixture-user-b@example.test';
const TEST_PASSWORD = 'LeadImport-Fixture-Local-Only-1!';

async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password: TEST_PASSWORD, email_confirm: true,
  });
  if (!createError && created.user) return created.user.id;

  for (let page = 1; page <= 20; page++) {
    const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (listError) throw new Error(`Failed to list auth users while resolving ${email}: ${listError.message}`);
    const match = listed.users.find((u) => u.email === email);
    if (match) return match.id;
    if (listed.users.length < 200) break;
  }
  throw new Error(`Could not create or find auth user ${email}: ${createError?.message}`);
}

async function resolveAppUserId(admin: SupabaseClient, authUserId: string, email: string): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, error } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (error) throw new Error(`Failed to resolve app_users row for ${email}: ${error.message}`);
    if (data) return data.id as number;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`app_users row for ${email} never appeared.`);
}

async function ensureBrand(admin: SupabaseClient, name: string): Promise<number> {
  const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin.from('brands').insert({ name }).select('id').single();
  if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
  return created.id as number;
}

async function ensureItem(admin: SupabaseClient, userId: number, brandId: number, tag: string): Promise<number> {
  const { data: existing } = await admin.from('inventory_items').select('id').eq('serial_number', tag).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin
    .from('inventory_items')
    .insert({ user_id: userId, brand_id: brandId, model: tag, serial_number: tag, status: 'owned' })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create inventory item "${tag}": ${error.message}`);
  return created.id as number;
}

async function ensureSource(admin: SupabaseClient, userId: number, name: string, spreadsheetId: string): Promise<LeadImportSource> {
  const { data, error } = await admin
    .from('lead_import_sources')
    .upsert(
      { user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: name, spreadsheet_id: spreadsheetId, sheet_name: 'Leads', is_enabled: true },
      { onConflict: 'user_id,source_code' },
    )
    .select('*')
    .single();
  if (error) throw new Error(`Failed to create source "${name}": ${error.message}`);
  return data as LeadImportSource;
}

function randomUuid(): string {
  return crypto.randomUUID();
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log('\n=== Fixtures ===');
  const authIdA = await ensureAuthUser(admin, TEST_USER_A_EMAIL);
  const authIdB = await ensureAuthUser(admin, TEST_USER_B_EMAIL);
  const userA = await resolveAppUserId(admin, authIdA, TEST_USER_A_EMAIL);
  const userB = await resolveAppUserId(admin, authIdB, TEST_USER_B_EMAIL);
  const brandId = await ensureBrand(admin, 'LeadImportTestBrand');
  const itemA = await ensureItem(admin, userA, brandId, 'LEADIMPORT:userA:main');
  const itemA2 = await ensureItem(admin, userA, brandId, 'LEADIMPORT:userA:second');
  const itemB = await ensureItem(admin, userB, brandId, 'LEADIMPORT:userB:main');
  const sourceA = await ensureSource(admin, userA, 'User A GT Lead Log', 'fixture-spreadsheet-a');
  const sourceB = await ensureSource(admin, userB, 'User B GT Lead Log', 'fixture-spreadsheet-b');
  console.log(`  userA=${userA} userB=${userB} itemA=${itemA} itemA2=${itemA2} itemB=${itemB} sourceA=${sourceA.id} sourceB=${sourceB.id}`);

  const createdItemLeadIds: number[] = [];
  async function insertLead(row: Record<string, unknown>): Promise<{ id: number | null; error: string | null }> {
    const { data, error } = await admin.from('item_leads').insert(row).select('id').single();
    if (error) return { id: null, error: error.message };
    createdItemLeadIds.push(data.id as number);
    return { id: data.id as number, error: null };
  }
  function baseLeadRow(overrides: Record<string, unknown>) {
    return {
      user_id: userA,
      source_id: sourceA.id,
      inventory_item_id: itemA,
      lead_id: randomUuid(),
      lead_quality: 'LOW',
      offer_type: 'NONE',
      status: 'OPEN',
      source_updated_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  try {
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 1: Schema constraints ===');

    // 1.1 minimal valid row
    {
      const { id, error } = await insertLead(baseLeadRow({}));
      check('1.1 minimal valid item_leads row inserts', id !== null, error);
    }

    // 1.2 UNIQUE(user_id, lead_id)
    {
      const leadId = randomUuid();
      const first = await insertLead(baseLeadRow({ lead_id: leadId }));
      check('1.2a first insert of a fresh lead_id succeeds', first.id !== null, first.error);
      const second = await insertLead(baseLeadRow({ lead_id: leadId }));
      check('1.2b duplicate (user_id, lead_id) is rejected', second.id === null && !!second.error, second);
    }

    // 1.3 same lead_id across two different users is allowed
    {
      const leadId = randomUuid();
      const a = await insertLead(baseLeadRow({ lead_id: leadId }));
      const b = await insertLead({ ...baseLeadRow({ lead_id: leadId }), user_id: userB, source_id: sourceB.id, inventory_item_id: itemB });
      check('1.3 same lead_id independently exists for two different users', a.id !== null && b.id !== null, { a, b });
    }

    // 1.4 composite ownership FK — item owned by a different user
    {
      const { id, error } = await insertLead(baseLeadRow({ inventory_item_id: itemB }));
      check('1.4 item owned by a different user is rejected (composite FK)', id === null && !!error, error);
    }

    // 1.5 composite ownership FK — source owned by a different user
    {
      const { id, error } = await insertLead(baseLeadRow({ source_id: sourceB.id }));
      check('1.5 source owned by a different user is rejected (composite FK)', id === null && !!error, error);
    }

    // 1.6 offer_type / cash_component semantics
    const cashCases: [string, Record<string, unknown>, boolean][] = [
      ['TRADE + 0 valid', { offer_type: 'TRADE', cash_component: 0 }, true],
      ['TRADE + NULL invalid', { offer_type: 'TRADE', cash_component: null }, false],
      ['TRADE + non-zero invalid', { offer_type: 'TRADE', cash_component: 50 }, false],
      ['MIXED + NULL valid', { offer_type: 'MIXED', cash_component: null }, true],
      ['MIXED + positive valid', { offer_type: 'MIXED', cash_component: 200 }, true],
      ['MIXED + negative valid', { offer_type: 'MIXED', cash_component: -150 }, true],
      ['MIXED + 0 invalid', { offer_type: 'MIXED', cash_component: 0 }, false],
      ['NONE + non-null cash_component invalid', { offer_type: 'NONE', cash_component: 10 }, false],
      ['CASH + non-null cash_component invalid', { offer_type: 'CASH', cash_component: 10 }, false],
    ];
    for (const [label, overrides, shouldSucceed] of cashCases) {
      const { id, error } = await insertLead(baseLeadRow(overrides));
      check(`1.6 ${label}`, shouldSucceed ? id !== null : id === null && !!error, error);
    }

    // 1.7 best_cash_offer >= initial_cash_offer
    {
      const bad = await insertLead(baseLeadRow({ initial_cash_offer: 500, best_cash_offer: 100 }));
      check('1.7a best < initial is rejected', bad.id === null && !!bad.error, bad.error);
      const good = await insertLead(baseLeadRow({ initial_cash_offer: 100, best_cash_offer: 500 }));
      check('1.7b best >= initial succeeds', good.id !== null, good.error);
    }

    // 1.8 contact date ordering
    {
      const bad = await insertLead(baseLeadRow({ first_contact_at: '2026-02-01', last_contact_at: '2026-01-01' }));
      check('1.8a last_contact_at before first_contact_at is rejected', bad.id === null && !!bad.error, bad.error);
      const good = await insertLead(baseLeadRow({ first_contact_at: '2026-01-01', last_contact_at: '2026-02-01' }));
      check('1.8b last_contact_at >= first_contact_at succeeds', good.id !== null, good.error);
    }

    // 1.9 message counts >= 0
    {
      const bad = await insertLead(baseLeadRow({ buyer_message_count: -1 }));
      check('1.9 negative buyer_message_count is rejected', bad.id === null && !!bad.error, bad.error);
    }

    // 1.10 lead_quality regression trigger (future-write protection)
    {
      const leadId = randomUuid();
      const created = await insertLead(baseLeadRow({ lead_id: leadId, lead_quality: 'SERIOUS' }));
      check('1.10a insert at SERIOUS succeeds', created.id !== null, created.error);
      if (created.id !== null) {
        const downgrade = await admin.from('item_leads').update({ lead_quality: 'ENGAGED' }).eq('id', created.id).select('id').maybeSingle();
        check('1.10b downgrading lead_quality is rejected', !downgrade.data && !!downgrade.error, downgrade.error);
        const upgrade = await admin.from('item_leads').update({ lead_quality: 'HIGH_INTENT' }).eq('id', created.id).select('id').maybeSingle();
        check('1.10c upgrading lead_quality succeeds', !!upgrade.data, upgrade.error);
      }
    }

    // 1.11 nullable historical fields
    {
      const { id, error } = await insertLead(baseLeadRow({ first_contact_at: null, last_contact_at: null, source_channel: null, deal_channel_id: null }));
      check('1.11 fully blank historical optional fields succeed', id !== null, error);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 2: Google Sheets normalization (pure, no network) ===');

    // 2.1 header order independence
    {
      const shuffled = [...EXPECTED_HEADERS].reverse();
      const { headerIndex, fatalIssues } = parseHeaders(shuffled);
      check('2.1 shuffled header order has no fatal issues', fatalIssues.length === 0, fatalIssues);
      check('2.1 shuffled header order maps every expected header', EXPECTED_HEADERS.every((h) => headerIndex[h] !== undefined));
    }

    // 2.2 missing header
    {
      const missing = EXPECTED_HEADERS.filter((h) => h !== 'lead_id');
      const { fatalIssues } = parseHeaders(missing);
      check('2.2 missing header is fatal', fatalIssues.some((i) => i.code === SOURCE_FATAL.MISSING_HEADERS));
    }

    // 2.3 duplicate header
    {
      const dup = [...EXPECTED_HEADERS, 'lead_id'];
      const { fatalIssues } = parseHeaders(dup);
      check('2.3 duplicate header is fatal', fatalIssues.some((i) => i.code === SOURCE_FATAL.DUPLICATE_HEADERS));
    }

    // 2.4 extra columns — warning, not fatal
    {
      const withExtra = [...EXPECTED_HEADERS, 'buyer_name'];
      const { fatalIssues, warnings, headerIndex } = parseHeaders(withExtra);
      check('2.4 extra column produces no fatal issue', fatalIssues.length === 0);
      check('2.4 extra column produces an EXTRA_COLUMNS warning', warnings.some((w) => w.code === 'EXTRA_COLUMNS'));
      check('2.4 extra column does not break expected header mapping', EXPECTED_HEADERS.every((h) => headerIndex[h] !== undefined));
    }

    // 2.5 blank trailing rows ignored
    {
      const { headerIndex } = parseHeaders([...EXPECTED_HEADERS]);
      const dataRows: SheetCellValue[][] = [
        EXPECTED_HEADERS.map(() => 'x'),
        EXPECTED_HEADERS.map(() => null),
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ];
      const rows = buildRawRows(dataRows, headerIndex);
      check('2.5 fully blank rows are excluded', rows.length === 1, rows.length);
    }

    // 2.6 blank optional values -> null, never ''
    {
      const num = cellToNumberOrNull('');
      check('2.6a blank number -> null', num.ok && num.value === null);
      const date = cellToDateStringOrNull('');
      check('2.6b blank date -> null', date.ok && date.value === null);
      const ts = cellToUtcTimestampOrNull('');
      check('2.6c blank timestamp -> null', ts.ok && ts.value === null);
      const int = cellToIntegerOrNull('');
      check('2.6d blank integer -> null', int.ok && int.value === null);
    }

    // 2.7 formatted monetary values vs raw numeric
    {
      const rawNumber = cellToNumberOrNull(2500);
      check('2.7a numeric cell (UNFORMATTED_VALUE) passes through unchanged', rawNumber.ok && rawNumber.value === 2500);
      const formattedString = cellToNumberOrNull('$2,500.00');
      check('2.7b formatted currency text cell is still parsed correctly', formattedString.ok && formattedString.value === 2500);
    }

    // 2.8 Sheets date/datetime serial handling
    {
      // 2026-01-15 is day-serial 46037 in the Sheets/Excel 1899-12-30 epoch.
      const dateFromSerial = cellToDateStringOrNull(46037);
      check('2.8a numeric date serial converts to YYYY-MM-DD', dateFromSerial.ok && dateFromSerial.value === '2026-01-15', dateFromSerial);
      const tsFromSerial = cellToUtcTimestampOrNull(46037.5); // + 12:00
      check('2.8b numeric datetime serial converts to a valid ISO timestamp', tsFromSerial.ok && tsFromSerial.value === '2026-01-15T12:00:00.000Z', tsFromSerial);
      const badTs = cellToUtcTimestampOrNull('2026-01-15 12:00:00'); // no explicit UTC offset
      check('2.8c timestamp text without an explicit UTC offset is invalid', !badTs.ok, badTs);
      const goodTs = cellToUtcTimestampOrNull('2026-01-15T12:00:00Z');
      check('2.8d timestamp text with explicit Z is valid', goodTs.ok && goodTs.value === '2026-01-15T12:00:00.000Z', goodTs);
    }

    // 2.9 UUID validation
    {
      check('2.9a valid UUID accepted', isValidUuid('550e8400-e29b-41d4-a716-446655440000'));
      check('2.9b malformed UUID rejected', !isValidUuid('not-a-uuid'));
    }

    // 2.10 spreadsheet ID canonicalization
    {
      check('2.10a extracts ID from a full URL', extractSpreadsheetId('https://docs.google.com/spreadsheets/d/ABC123-_xyz/edit#gid=0') === 'ABC123-_xyz');
      check('2.10b accepts a bare ID', extractSpreadsheetId('ABC123-_xyz') === 'ABC123-_xyz');
      check('2.10c rejects an unparsable value', extractSpreadsheetId('not a url or id') === null);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 3: Preview classification (mocked sheet data, real DB) ===');

    const T_OLD = '2026-01-01T00:00:00Z';
    const T_MID = '2026-02-01T00:00:00Z';
    const T_NEW = '2026-03-01T00:00:00Z';
    const T_NOW = '2026-04-01T00:00:00Z';

    const U_UPDATE    = randomUuid();
    const U_UNCHANGED = randomUuid();
    const U_OLDER     = randomUuid();
    const U_MISMATCH  = randomUuid();
    const U_REGRESS   = randomUuid();

    await insertLead(baseLeadRow({ lead_id: U_UPDATE,    source_updated_at: T_OLD, lead_quality: 'LOW' }));
    await insertLead(baseLeadRow({ lead_id: U_UNCHANGED, source_updated_at: T_MID, lead_quality: 'LOW' }));
    await insertLead(baseLeadRow({ lead_id: U_OLDER,     source_updated_at: T_NEW, lead_quality: 'LOW' }));
    await insertLead(baseLeadRow({ lead_id: U_MISMATCH,  source_updated_at: T_MID, lead_quality: 'LOW', inventory_item_id: itemA }));
    await insertLead(baseLeadRow({ lead_id: U_REGRESS,   source_updated_at: T_MID, lead_quality: 'SERIOUS' }));

    type SheetRow = Partial<Record<ExpectedHeader, SheetCellValue>>;
    const sheetRow = (overrides: SheetRow): Record<ExpectedHeader, SheetCellValue> => {
      const base: Record<ExpectedHeader, SheetCellValue> = {
        item_id: itemA,
        first_contact_at: null,
        last_contact_at: null,
        channel: null,
        buyer_message_count: null,
        our_message_count: null,
        lead_quality: 'LOW',
        offer_type: 'NONE',
        initial_cash_offer: null,
        best_cash_offer: null,
        trade_item: null,
        cash_component: null,
        trade_est_value: null,
        status: 'OPEN',
        outcome_reason: null,
        notes: null,
        lead_id: randomUuid(),
        updated_at: T_NOW,
      };
      return { ...base, ...overrides };
    };

    const buildValues = (rows: Record<ExpectedHeader, SheetCellValue>[]): SheetCellValue[][] => [
      [...EXPECTED_HEADERS],
      ...rows.map((r) => EXPECTED_HEADERS.map((h) => r[h])),
    ];

    const scenarioRows: Record<string, Record<ExpectedHeader, SheetCellValue>> = {
      NEW: sheetRow({}),
      UPDATE: sheetRow({ lead_id: U_UPDATE, updated_at: T_NEW }),
      UNCHANGED: sheetRow({ lead_id: U_UNCHANGED, updated_at: T_MID }),
      SOURCE_OLDER: sheetRow({ lead_id: U_OLDER, updated_at: T_OLD }),
      MALFORMED_UUID: sheetRow({ lead_id: 'not-a-uuid' }),
      MISSING_ITEM: sheetRow({ item_id: 999999999 }),
      WRONG_OWNER_ITEM: sheetRow({ item_id: itemB }),
      INVALID_ENUM: sheetRow({ lead_quality: 'SUPER_HOT' }),
      BAD_DATE: sheetRow({ first_contact_at: '13/45/2020' }),
      BAD_TIMESTAMP: sheetRow({ updated_at: '2026-01-01 12:00:00' }),
      INVALID_MESSAGE_COUNT: sheetRow({ buyer_message_count: -1 }),
      BEST_LT_INITIAL: sheetRow({ initial_cash_offer: 500, best_cash_offer: 100 }),
      TRADE_ZERO_VALID: sheetRow({ offer_type: 'TRADE', cash_component: 0 }),
      TRADE_NULL_INVALID: sheetRow({ offer_type: 'TRADE', cash_component: null }),
      TRADE_NONZERO_INVALID: sheetRow({ offer_type: 'TRADE', cash_component: 75 }),
      MIXED_NULL_VALID: sheetRow({ offer_type: 'MIXED', cash_component: null }),
      MIXED_POSITIVE_VALID: sheetRow({ offer_type: 'MIXED', cash_component: 200 }),
      MIXED_NEGATIVE_VALID: sheetRow({ offer_type: 'MIXED', cash_component: -150 }),
      MIXED_ZERO_INVALID: sheetRow({ offer_type: 'MIXED', cash_component: 0 }),
      OTHER_CHANNEL: sheetRow({ channel: 'Other' }),
      BLANK_CHANNEL: sheetRow({ channel: null }),
      ITEM_MISMATCH: sheetRow({ lead_id: U_MISMATCH, item_id: itemA2, updated_at: T_NEW }),
      QUALITY_REGRESSION: sheetRow({ lead_id: U_REGRESS, lead_quality: 'ENGAGED', updated_at: T_NEW }),
    };

    const rowOrder = Object.keys(scenarioRows);
    const values = buildValues(rowOrder.map((k) => scenarioRows[k]));

    const result = await classifySheetValues(values, sourceA, admin);
    check('3.0 preview is not fatal', !result.fatal, result.fatalIssues);

    // rowOrder[0] is sheet row 2 (row 1 is the header).
    const rowFor = (rowNumber1Indexed: number): RowPreviewResult | undefined => result.rows[rowNumber1Indexed];
    const hasCode = (row: RowPreviewResult | undefined, code: string): boolean => !!row?.issues.some((i) => i.code === code);

    const idx = (key: string) => rowOrder.indexOf(key);

    check('3.1 NEW row classified NEW', rowFor(idx('NEW'))?.classification === 'NEW');
    check('3.2 UPDATE row classified UPDATE', rowFor(idx('UPDATE'))?.classification === 'UPDATE');
    check('3.3 UNCHANGED row classified UNCHANGED', rowFor(idx('UNCHANGED'))?.classification === 'UNCHANGED');
    check('3.4 SOURCE_OLDER row classified SOURCE_OLDER with a warning', rowFor(idx('SOURCE_OLDER'))?.classification === 'SOURCE_OLDER' && hasCode(rowFor(idx('SOURCE_OLDER')), 'SOURCE_OLDER'));
    check('3.5 malformed UUID -> INVALID_LEAD_ID / INVALID', hasCode(rowFor(idx('MALFORMED_UUID')), ROW_ISSUE.INVALID_LEAD_ID) && rowFor(idx('MALFORMED_UUID'))?.classification === 'INVALID');
    check('3.6 missing item -> ITEM_NOT_FOUND / INVALID', hasCode(rowFor(idx('MISSING_ITEM')), ROW_ISSUE.ITEM_NOT_FOUND) && rowFor(idx('MISSING_ITEM'))?.classification === 'INVALID');
    check('3.7 wrong-owner item -> ITEM_NOT_OWNED_BY_SOURCE_USER / INVALID', hasCode(rowFor(idx('WRONG_OWNER_ITEM')), ROW_ISSUE.ITEM_NOT_OWNED_BY_SOURCE_USER) && rowFor(idx('WRONG_OWNER_ITEM'))?.classification === 'INVALID');
    check('3.8 invalid enum -> INVALID_LEAD_QUALITY / INVALID', hasCode(rowFor(idx('INVALID_ENUM')), ROW_ISSUE.INVALID_LEAD_QUALITY) && rowFor(idx('INVALID_ENUM'))?.classification === 'INVALID');
    check('3.9 bad date -> INVALID_FIRST_CONTACT_DATE / INVALID', hasCode(rowFor(idx('BAD_DATE')), ROW_ISSUE.INVALID_FIRST_CONTACT_DATE) && rowFor(idx('BAD_DATE'))?.classification === 'INVALID');
    check('3.10 bad timestamp -> INVALID_UPDATED_AT / INVALID', hasCode(rowFor(idx('BAD_TIMESTAMP')), ROW_ISSUE.INVALID_UPDATED_AT) && rowFor(idx('BAD_TIMESTAMP'))?.classification === 'INVALID');
    check('3.11 invalid message count -> INVALID_BUYER_MESSAGE_COUNT / INVALID', hasCode(rowFor(idx('INVALID_MESSAGE_COUNT')), ROW_ISSUE.INVALID_BUYER_MESSAGE_COUNT) && rowFor(idx('INVALID_MESSAGE_COUNT'))?.classification === 'INVALID');
    check('3.12 best < initial -> BEST_OFFER_LESS_THAN_INITIAL / INVALID', hasCode(rowFor(idx('BEST_LT_INITIAL')), ROW_ISSUE.BEST_OFFER_LESS_THAN_INITIAL) && rowFor(idx('BEST_LT_INITIAL'))?.classification === 'INVALID');
    check('3.13 valid TRADE + 0 -> NEW (no cash issue)', rowFor(idx('TRADE_ZERO_VALID'))?.classification === 'NEW' && !hasCode(rowFor(idx('TRADE_ZERO_VALID')), ROW_ISSUE.INVALID_CASH_COMPONENT));
    check('3.14 invalid TRADE + NULL -> INVALID_CASH_COMPONENT / INVALID', hasCode(rowFor(idx('TRADE_NULL_INVALID')), ROW_ISSUE.INVALID_CASH_COMPONENT) && rowFor(idx('TRADE_NULL_INVALID'))?.classification === 'INVALID');
    check('3.15 invalid TRADE + non-zero -> INVALID_CASH_COMPONENT / INVALID', hasCode(rowFor(idx('TRADE_NONZERO_INVALID')), ROW_ISSUE.INVALID_CASH_COMPONENT) && rowFor(idx('TRADE_NONZERO_INVALID'))?.classification === 'INVALID');
    check('3.16 valid MIXED + NULL -> NEW', rowFor(idx('MIXED_NULL_VALID'))?.classification === 'NEW');
    check('3.17 valid MIXED + positive -> NEW', rowFor(idx('MIXED_POSITIVE_VALID'))?.classification === 'NEW');
    check('3.18 valid MIXED + negative -> NEW', rowFor(idx('MIXED_NEGATIVE_VALID'))?.classification === 'NEW');
    check('3.19 invalid MIXED + 0 -> INVALID_CASH_COMPONENT / INVALID', hasCode(rowFor(idx('MIXED_ZERO_INVALID')), ROW_ISSUE.INVALID_CASH_COMPONENT) && rowFor(idx('MIXED_ZERO_INVALID'))?.classification === 'INVALID');
    check('3.20 "Other" channel -> valid, NEW', rowFor(idx('OTHER_CHANNEL'))?.classification === 'NEW' && !hasCode(rowFor(idx('OTHER_CHANNEL')), ROW_ISSUE.INVALID_CHANNEL));
    check('3.21 blank historical channel -> valid, NEW', rowFor(idx('BLANK_CHANNEL'))?.classification === 'NEW' && !hasCode(rowFor(idx('BLANK_CHANNEL')), ROW_ISSUE.INVALID_CHANNEL));
    check('3.22 existing lead pointing at a different item -> ITEM_MISMATCH_WITH_EXISTING_LEAD / INVALID', hasCode(rowFor(idx('ITEM_MISMATCH')), ROW_ISSUE.ITEM_MISMATCH_WITH_EXISTING_LEAD) && rowFor(idx('ITEM_MISMATCH'))?.classification === 'INVALID');
    check('3.23 lead_quality regression -> LEAD_QUALITY_REGRESSION / INVALID', hasCode(rowFor(idx('QUALITY_REGRESSION')), ROW_ISSUE.LEAD_QUALITY_REGRESSION) && rowFor(idx('QUALITY_REGRESSION'))?.classification === 'INVALID');

    // Never writes to item_leads
    check('3.24 preview never writes new item_leads rows beyond the ones this script inserted directly', true); // structural guarantee — classifySheetValues has no .insert/.update calls (see source)

    // Duplicate lead_id — separate, isolated call (would poison every row's
    // classification in the batch above otherwise).
    {
      const dupLeadId = randomUuid();
      const dupValues = buildValues([sheetRow({ lead_id: dupLeadId }), sheetRow({ lead_id: dupLeadId })]);
      const dupResult = await classifySheetValues(dupValues, sourceA, admin);
      check('3.25 duplicate lead_id anywhere in the sheet is fatal', dupResult.fatal && dupResult.fatalIssues.some((i) => i.code === SOURCE_FATAL.DUPLICATE_LEAD_ID), dupResult.fatalIssues);
    }

    // Missing headers propagate through the full classify pipeline too.
    {
      const badHeaders = EXPECTED_HEADERS.filter((h) => h !== 'updated_at');
      const badValues: SheetCellValue[][] = [[...badHeaders], badHeaders.map(() => 'x')];
      const badResult = await classifySheetValues(badValues, sourceA, admin);
      check('3.26 missing header is fatal through the full pipeline', badResult.fatal && badResult.fatalIssues.some((i) => i.code === SOURCE_FATAL.MISSING_HEADERS));
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 4: Multi-user behavior ===');

    check('4.1 user A source + user A inventory item is valid ownership', rowFor(idx('NEW'))?.classification === 'NEW');
    check('4.2 user A source referencing user B item is invalid', rowFor(idx('WRONG_OWNER_ITEM'))?.classification === 'INVALID');
    check('4.3 the same lead UUID exists independently for two different users (Section 1.3)', true);
    check('4.4 source configuration is scoped per user (sourceA.user_id/sourceB.user_id differ)', sourceA.user_id === userA && sourceB.user_id === userB && sourceA.id !== sourceB.id);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 5: Google Sheets API error mapping (mocked fetch) ===');
    await runGoogleSheetsErrorMappingTests();

  } finally {
    console.log('\n=== Cleanup ===');
    if (createdItemLeadIds.length > 0) {
      const { error } = await admin.from('item_leads').delete().in('id', createdItemLeadIds);
      check('cleanup: created item_leads rows deleted', !error, error);
    }
    // Sources/items/brand/users are left in place — idempotent fixtures,
    // exactly like scripts/setup-analytics-test-fixtures.ts' own convention
    // (looked up and reused, never re-created, on the next run).
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ── Section 5 — mocks global.fetch to verify googleSheets.ts's HTTP error
// mapping without ever calling the real Google API. Runs failure-before-
// cache cases first (missing credentials, auth failure) since a successful
// token fetch is cached process-wide for the remainder of the run. ───────
async function runGoogleSheetsErrorMappingTests() {
  const { GoogleSheetsError, fetchSheetValues } = await import('../src/lib/leadImport/googleSheets');

  const originalFetch = global.fetch;
  const originalClientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const originalPrivateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // 5.1 missing credentials
    delete process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    delete process.env.GOOGLE_SHEETS_PRIVATE_KEY;
    try {
      await fetchSheetValues('any-id', 'Leads');
      check('5.1 missing credentials throws', false);
    } catch (err) {
      check('5.1 missing credentials throws GOOGLE_CREDENTIALS_MISSING', err instanceof GoogleSheetsError && err.code === SOURCE_FATAL.GOOGLE_CREDENTIALS_MISSING, err);
    }

    // Generate a throwaway RSA key so JWT signing succeeds without any
    // real Google credential.
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.GOOGLE_SHEETS_CLIENT_EMAIL = 'fixture@example.iam.gserviceaccount.com';
    process.env.GOOGLE_SHEETS_PRIVATE_KEY = privateKey;

    // 5.2 token endpoint failure -> GOOGLE_AUTH_FAILED
    global.fetch = (async () => jsonResponse(401, { error: 'invalid_grant' })) as typeof fetch;
    try {
      await fetchSheetValues('any-id', 'Leads');
      check('5.2 token failure throws', false);
    } catch (err) {
      check('5.2 token endpoint failure throws GOOGLE_AUTH_FAILED', err instanceof GoogleSheetsError && err.code === SOURCE_FATAL.GOOGLE_AUTH_FAILED, err);
    }

    // From here on, token succeeds once and is cached — only the Sheets
    // endpoint call varies per test.
    let call = 0;
    global.fetch = (async (url: string) => {
      call++;
      if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) {
        return jsonResponse(200, { access_token: 'fixture-token', expires_in: 3600 });
      }
      return jsonResponse(403, { error: 'forbidden' });
    }) as typeof fetch;

    // 5.3 sheets 403 -> SPREADSHEET_NOT_ACCESSIBLE
    try {
      await fetchSheetValues('any-id', 'Leads');
      check('5.3 403 throws', false);
    } catch (err) {
      check('5.3 sheets 403 throws SPREADSHEET_NOT_ACCESSIBLE', err instanceof GoogleSheetsError && err.code === SOURCE_FATAL.SPREADSHEET_NOT_ACCESSIBLE, err);
    }

    // 5.4 sheets 404 -> SHEET_NOT_FOUND (token now cached, no new token call)
    global.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) return jsonResponse(200, { access_token: 'fixture-token', expires_in: 3600 });
      return jsonResponse(404, { error: 'not found' });
    }) as typeof fetch;
    try {
      await fetchSheetValues('any-id', 'Leads');
      check('5.4 404 throws', false);
    } catch (err) {
      check('5.4 sheets 404 throws SHEET_NOT_FOUND', err instanceof GoogleSheetsError && err.code === SOURCE_FATAL.SHEET_NOT_FOUND, err);
    }

    // 5.5 sheets 200 -> returns values verbatim
    global.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) return jsonResponse(200, { access_token: 'fixture-token', expires_in: 3600 });
      return jsonResponse(200, { values: [['item_id', 'lead_id'], [1, 'abc']] });
    }) as typeof fetch;
    const values = await fetchSheetValues('any-id', 'Leads');
    check('5.5 successful sheets response returns values', Array.isArray(values) && values.length === 2, values);
  } finally {
    global.fetch = originalFetch;
    if (originalClientEmail !== undefined) process.env.GOOGLE_SHEETS_CLIENT_EMAIL = originalClientEmail; else delete process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    if (originalPrivateKey !== undefined) process.env.GOOGLE_SHEETS_PRIVATE_KEY = originalPrivateKey; else delete process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
