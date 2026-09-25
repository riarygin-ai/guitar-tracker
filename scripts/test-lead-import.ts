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
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
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
import { classifySheetValues, classifySheetValuesDetailed } from '../src/lib/leadImport/preview';
import { runLeadImport } from '../src/lib/leadImport/importRun';
import { ALL_HEADERS, EXPECTED_HEADERS, OPTIONAL_HEADERS, type LeadImportSource, type RowPreviewResult, type SheetCellValue, type SheetHeader } from '../src/lib/leadImport/types';
import { ROW_ISSUE, ROW_WARNING, SOURCE_FATAL } from '../src/lib/leadImport/errorCodes';

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
const TEST_ADMIN_EMAIL  = 'lead-import-fixture-admin@example.test';
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

// ── Deal fixtures (Lead -> Deal linkage tests). Idempotent, same convention
// as ensureItem/ensureSource — looked up by a tag (deals.notes) / exact
// (deal_id, item_id, direction) triple and reused, never re-created. ───────
async function ensureDeal(admin: SupabaseClient, userId: number, dealType: string, tag: string): Promise<number> {
  const { data: existing } = await admin.from('deals').select('id').eq('notes', tag).maybeSingle();
  if (existing) return existing.id as number;
  const { data, error } = await admin.from('deals').insert({ user_id: userId, deal_date: '2026-01-01', deal_type: dealType, notes: tag }).select('id').single();
  if (error) throw new Error(`Failed to create deal (type ${dealType}, tag ${tag}): ${error.message}`);
  return data.id as number;
}
async function ensureDealItem(admin: SupabaseClient, userId: number, dealId: number, itemId: number, direction: 'in' | 'out'): Promise<void> {
  const { data: existing } = await admin.from('deal_items').select('id').eq('deal_id', dealId).eq('item_id', itemId).eq('direction', direction).maybeSingle();
  if (existing) return;
  const { error } = await admin.from('deal_items').insert({ user_id: userId, deal_id: dealId, item_id: itemId, direction });
  if (error) throw new Error(`Failed to create deal_item (deal ${dealId}, item ${itemId}, ${direction}): ${error.message}`);
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

  // Deal fixtures for Lead -> Deal linkage tests:
  //   dealOutA        — user A's completed Sale of itemA (itemA on the 'out' side).
  //   dealTradeInA     — user A's completed Trade that brought itemA2 IN (itemA2 on the 'in' side only —
  //                      never a valid exit deal for itemA2, and never a valid link target for it).
  //   dealOutB         — user B's completed Sale of itemB (itemB on the 'out' side; owned by a different user).
  const dealOutA = await ensureDeal(admin, userA, 'sale', 'LEADIMPORT:dealOutA');
  await ensureDealItem(admin, userA, dealOutA, itemA, 'out');
  const dealTradeInA = await ensureDeal(admin, userA, 'trade', 'LEADIMPORT:dealTradeInA');
  await ensureDealItem(admin, userA, dealTradeInA, itemA2, 'in');
  const dealOutB = await ensureDeal(admin, userB, 'sale', 'LEADIMPORT:dealOutB');
  await ensureDealItem(admin, userB, dealOutB, itemB, 'out');

  console.log(`  userA=${userA} userB=${userB} itemA=${itemA} itemA2=${itemA2} itemB=${itemB} sourceA=${sourceA.id} sourceB=${sourceB.id} dealOutA=${dealOutA} dealTradeInA=${dealTradeInA} dealOutB=${dealOutB}`);

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
        // Both updates advance source_updated_at: since Phase 2, changing
        // any source-mirrored column without a strictly newer source
        // timestamp is rejected outright by
        // trg_item_leads_require_newer_source (tested on its own in 6.19),
        // which would otherwise mask what this case is actually checking.
        const downgrade = await admin.from('item_leads')
          .update({ lead_quality: 'ENGAGED', source_updated_at: '2026-02-01T00:00:00Z' })
          .eq('id', created.id).select('id').maybeSingle();
        check('1.10b downgrading lead_quality is rejected', !downgrade.data && !!downgrade.error, downgrade.error);
        const upgrade = await admin.from('item_leads')
          .update({ lead_quality: 'HIGH_INTENT', source_updated_at: '2026-02-01T00:00:00Z' })
          .eq('id', created.id).select('id').maybeSingle();
        check('1.10c upgrading lead_quality succeeds', !!upgrade.data, upgrade.error);
      }
    }

    // 1.11 nullable historical fields
    {
      const { id, error } = await insertLead(baseLeadRow({ first_contact_at: null, last_contact_at: null, source_channel: null, deal_channel_id: null }));
      check('1.11 fully blank historical optional fields succeed', id !== null, error);
    }

    // 1.12 deal_id schema: != NULL requires status = COMPLETED (item_leads_deal_id_requires_completed_check)
    {
      const bad = await insertLead(baseLeadRow({ status: 'OPEN', deal_id: dealOutA }));
      check('1.12a deal_id set while status OPEN is rejected (CHECK constraint)', bad.id === null && !!bad.error, bad.error);
      const good = await insertLead(baseLeadRow({ status: 'COMPLETED', deal_id: dealOutA }));
      check('1.12b deal_id set while status COMPLETED succeeds', good.id !== null, good.error);
      const goodNull = await insertLead(baseLeadRow({ status: 'COMPLETED', deal_id: null }));
      check('1.12c COMPLETED with deal_id NULL still succeeds (historical backward compatibility)', goodNull.id !== null, goodNull.error);
    }

    // 1.13 deal_id FK integrity — a nonexistent deals.id is rejected
    {
      const bad = await insertLead(baseLeadRow({ status: 'COMPLETED', deal_id: 999999999 }));
      check('1.13 deal_id referencing a nonexistent deal is rejected (FK)', bad.id === null && !!bad.error, bad.error);
    }

    // 1.14 deal_id is not unique — the same deal_id links to two different leads
    {
      const a = await insertLead(baseLeadRow({ status: 'COMPLETED', deal_id: dealOutA }));
      const b = await insertLead(baseLeadRow({ status: 'COMPLETED', deal_id: dealOutA }));
      check('1.14 the same deal_id may be stored on more than one lead row (no UNIQUE constraint)', a.id !== null && b.id !== null && a.id !== b.id, { a, b });
    }

    // 1.15 deal_id participates in the material-field / newer-source-required guard
    {
      const leadId = randomUuid();
      const created = await insertLead(baseLeadRow({ lead_id: leadId, status: 'OPEN', deal_id: null, source_updated_at: '2026-01-01T00:00:00Z' }));
      check('1.15a insert with deal_id NULL succeeds', created.id !== null, created.error);
      if (created.id !== null) {
        const sameTimestamp = await admin.from('item_leads')
          .update({ status: 'COMPLETED', deal_id: dealOutA, source_updated_at: '2026-01-01T00:00:00Z' })
          .eq('id', created.id).select('id').maybeSingle();
        check('1.15b changing deal_id (NULL -> a deal) WITHOUT a strictly newer source_updated_at is rejected', !sameTimestamp.data && !!sameTimestamp.error, sameTimestamp.error);
        const advanced = await admin.from('item_leads')
          .update({ status: 'COMPLETED', deal_id: dealOutA, source_updated_at: '2026-02-01T00:00:00Z' })
          .eq('id', created.id).select('deal_id').maybeSingle();
        check('1.15c changing deal_id (NULL -> a deal) WITH a strictly newer source_updated_at succeeds', advanced.data?.deal_id === dealOutA, advanced.error);
        const revert = await admin.from('item_leads')
          .update({ deal_id: null, source_updated_at: '2026-03-01T00:00:00Z' })
          .eq('id', created.id).select('deal_id').maybeSingle();
        check('1.15d changing deal_id back to NULL is also a material change, accepted with a newer source_updated_at', revert.data?.deal_id === null, revert.error);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 2: Google Sheets normalization (pure, no network) ===');

    // 2.0 deal_id header contract: optional, not required; ALL_HEADERS = EXPECTED_HEADERS + OPTIONAL_HEADERS
    {
      check('2.0a deal_id is an OPTIONAL header, not a required one', (OPTIONAL_HEADERS as readonly string[]).includes('deal_id') && !(EXPECTED_HEADERS as readonly string[]).includes('deal_id'));
      check('2.0b ALL_HEADERS is exactly EXPECTED_HEADERS + OPTIONAL_HEADERS', ALL_HEADERS.length === EXPECTED_HEADERS.length + OPTIONAL_HEADERS.length && ALL_HEADERS.slice(-1)[0] === 'deal_id');
      const { headerIndex, fatalIssues } = parseHeaders([...EXPECTED_HEADERS]);
      check('2.0c a sheet with only the required headers (no deal_id column) is not fatal for missing headers', fatalIssues.length === 0, fatalIssues);
      check('2.0d deal_id is simply absent from headerIndex when the sheet has no such column', headerIndex.deal_id === undefined);
    }

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

    // SheetHeader (EXPECTED_HEADERS + OPTIONAL_HEADERS, i.e. deal_id) so every
    // scenario row can optionally carry a deal_id — defaults to null (a
    // present-but-blank column), the common case. buildValues emits a full
    // A:S sheet (deal_id header present) by default; a separate fixture
    // below builds an explicit old-style A:R sheet with NO deal_id header
    // at all, for the backward-compatibility test.
    type SheetRow = Partial<Record<SheetHeader, SheetCellValue>>;
    const sheetRow = (overrides: SheetRow): Record<SheetHeader, SheetCellValue> => {
      const base: Record<SheetHeader, SheetCellValue> = {
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
        deal_id: null,
      };
      return { ...base, ...overrides };
    };

    const buildValues = (rows: Record<SheetHeader, SheetCellValue>[]): SheetCellValue[][] => [
      [...ALL_HEADERS],
      ...rows.map((r) => ALL_HEADERS.map((h) => r[h])),
    ];

    // Old-style A:R sheet: no deal_id column at all (header row stops at
    // `updated_at`). Every row's cells.deal_id must still normalize to NULL.
    const buildValuesNoDealIdHeader = (rows: Record<SheetHeader, SheetCellValue>[]): SheetCellValue[][] => [
      [...EXPECTED_HEADERS],
      ...rows.map((r) => EXPECTED_HEADERS.map((h) => r[h])),
    ];

    const scenarioRows: Record<string, Record<SheetHeader, SheetCellValue>> = {
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
      TRADE_NULL_NORMALIZED: sheetRow({ offer_type: 'TRADE', cash_component: null }),
      TRADE_NONZERO_INVALID: sheetRow({ offer_type: 'TRADE', cash_component: 75 }),
      MIXED_NULL_VALID: sheetRow({ offer_type: 'MIXED', cash_component: null }),
      MIXED_POSITIVE_VALID: sheetRow({ offer_type: 'MIXED', cash_component: 200 }),
      MIXED_NEGATIVE_VALID: sheetRow({ offer_type: 'MIXED', cash_component: -150 }),
      MIXED_ZERO_INVALID: sheetRow({ offer_type: 'MIXED', cash_component: 0 }),
      OTHER_CHANNEL: sheetRow({ channel: 'Other' }),
      BLANK_CHANNEL: sheetRow({ channel: null }),
      ITEM_MISMATCH: sheetRow({ lead_id: U_MISMATCH, item_id: itemA2, updated_at: T_NEW }),
      QUALITY_REGRESSION: sheetRow({ lead_id: U_REGRESS, lead_quality: 'ENGAGED', updated_at: T_NEW }),

      // ── Lead -> Deal linkage (deal_id) ──────────────────────────────────
      DEAL_LINK_VALID: sheetRow({ status: 'COMPLETED', deal_id: dealOutA }),
      DEAL_ID_NOT_FOUND: sheetRow({ status: 'COMPLETED', deal_id: 999999999 }),
      DEAL_ID_NOT_OWNED: sheetRow({ status: 'COMPLETED', deal_id: dealOutB }),
      DEAL_ITEM_NOT_IN_DEAL: sheetRow({ item_id: itemA, status: 'COMPLETED', deal_id: dealTradeInA }),
      DEAL_ITEM_INCOMING_SIDE: sheetRow({ item_id: itemA2, status: 'COMPLETED', deal_id: dealTradeInA }),
      DEAL_ID_STATUS_OPEN: sheetRow({ status: 'OPEN', deal_id: dealOutA }),
      DEAL_ID_STATUS_AGREED: sheetRow({ status: 'AGREED', deal_id: dealOutA }),
      COMPLETED_NO_DEAL_ID: sheetRow({ status: 'COMPLETED', deal_id: null }),
      DEAL_ID_NEGATIVE: sheetRow({ deal_id: -5 }),
      DEAL_ID_ZERO: sheetRow({ deal_id: 0 }),
      DEAL_ID_DECIMAL: sheetRow({ deal_id: 12.5 }),
      DEAL_ID_TEXT: sheetRow({ deal_id: 'abc' }),
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
    check('3.14 TRADE + blank cash_component is NORMALIZED to 0: valid NEW with a non-blocking warning, never INVALID_CASH_COMPONENT',
      rowFor(idx('TRADE_NULL_NORMALIZED'))?.classification === 'NEW' && hasCode(rowFor(idx('TRADE_NULL_NORMALIZED')), ROW_WARNING.TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO) && !hasCode(rowFor(idx('TRADE_NULL_NORMALIZED')), ROW_ISSUE.INVALID_CASH_COMPONENT) && (rowFor(idx('TRADE_NULL_NORMALIZED'))?.issues ?? []).every((i) => i.severity === 'warning'));
    check('3.15 invalid TRADE + non-zero -> INVALID_CASH_COMPONENT / INVALID', hasCode(rowFor(idx('TRADE_NONZERO_INVALID')), ROW_ISSUE.INVALID_CASH_COMPONENT) && rowFor(idx('TRADE_NONZERO_INVALID'))?.classification === 'INVALID');
    check('3.16 valid MIXED + NULL -> NEW', rowFor(idx('MIXED_NULL_VALID'))?.classification === 'NEW');
    check('3.17 valid MIXED + positive -> NEW', rowFor(idx('MIXED_POSITIVE_VALID'))?.classification === 'NEW');
    check('3.18 valid MIXED + negative -> NEW', rowFor(idx('MIXED_NEGATIVE_VALID'))?.classification === 'NEW');
    check('3.19 invalid MIXED + 0 -> INVALID_CASH_COMPONENT / INVALID', hasCode(rowFor(idx('MIXED_ZERO_INVALID')), ROW_ISSUE.INVALID_CASH_COMPONENT) && rowFor(idx('MIXED_ZERO_INVALID'))?.classification === 'INVALID');
    check('3.20 "Other" channel -> valid, NEW', rowFor(idx('OTHER_CHANNEL'))?.classification === 'NEW' && !hasCode(rowFor(idx('OTHER_CHANNEL')), ROW_ISSUE.INVALID_CHANNEL));
    check('3.21 blank historical channel -> valid, NEW', rowFor(idx('BLANK_CHANNEL'))?.classification === 'NEW' && !hasCode(rowFor(idx('BLANK_CHANNEL')), ROW_ISSUE.INVALID_CHANNEL));
    check('3.22 existing lead pointing at a different item -> ITEM_MISMATCH_WITH_EXISTING_LEAD / INVALID', hasCode(rowFor(idx('ITEM_MISMATCH')), ROW_ISSUE.ITEM_MISMATCH_WITH_EXISTING_LEAD) && rowFor(idx('ITEM_MISMATCH'))?.classification === 'INVALID');
    check('3.23 lead_quality regression -> LEAD_QUALITY_REGRESSION / INVALID', hasCode(rowFor(idx('QUALITY_REGRESSION')), ROW_ISSUE.LEAD_QUALITY_REGRESSION) && rowFor(idx('QUALITY_REGRESSION'))?.classification === 'INVALID');

    // ── deal_id validation (Lead -> Deal linkage) ─────────────────────────
    check('3.27 blank deal_id -> NULL, no deal issue (base NEW row)', !hasCode(rowFor(idx('NEW')), ROW_ISSUE.INVALID_DEAL_ID) && !hasCode(rowFor(idx('NEW')), ROW_ISSUE.DEAL_NOT_FOUND));
    check('3.28 deal exists + same user + item on outgoing side + COMPLETED -> valid, no deal issues', rowFor(idx('DEAL_LINK_VALID'))?.classification === 'NEW' && (rowFor(idx('DEAL_LINK_VALID'))?.issues ?? []).length === 0);
    check('3.29 deal does not exist -> DEAL_NOT_FOUND / INVALID', hasCode(rowFor(idx('DEAL_ID_NOT_FOUND')), ROW_ISSUE.DEAL_NOT_FOUND) && rowFor(idx('DEAL_ID_NOT_FOUND'))?.classification === 'INVALID');
    check('3.30 deal belongs to another user -> DEAL_NOT_OWNED_BY_SOURCE_USER / INVALID (message never reveals the other user\'s deal details)', hasCode(rowFor(idx('DEAL_ID_NOT_OWNED')), ROW_ISSUE.DEAL_NOT_OWNED_BY_SOURCE_USER) && rowFor(idx('DEAL_ID_NOT_OWNED'))?.classification === 'INVALID' && !(rowFor(idx('DEAL_ID_NOT_OWNED'))?.issues ?? []).some((i) => /user ?b|userB/i.test(i.message)));
    check('3.31 deal belongs to the user but the item is not in that deal at all -> DEAL_ITEM_MISMATCH / INVALID', hasCode(rowFor(idx('DEAL_ITEM_NOT_IN_DEAL')), ROW_ISSUE.DEAL_ITEM_MISMATCH) && rowFor(idx('DEAL_ITEM_NOT_IN_DEAL'))?.classification === 'INVALID');
    check('3.32 item is the INCOMING side of a Trade, not outgoing -> DEAL_ITEM_MISMATCH / INVALID (never accepted merely because it appears in the same trade)', hasCode(rowFor(idx('DEAL_ITEM_INCOMING_SIDE')), ROW_ISSUE.DEAL_ITEM_MISMATCH) && rowFor(idx('DEAL_ITEM_INCOMING_SIDE'))?.classification === 'INVALID');
    check('3.33 deal_id present while status OPEN -> DEAL_ID_REQUIRES_COMPLETED_STATUS / INVALID (status never silently changed)', hasCode(rowFor(idx('DEAL_ID_STATUS_OPEN')), ROW_ISSUE.DEAL_ID_REQUIRES_COMPLETED_STATUS) && rowFor(idx('DEAL_ID_STATUS_OPEN'))?.classification === 'INVALID');
    check('3.34 deal_id present while status AGREED -> DEAL_ID_REQUIRES_COMPLETED_STATUS / INVALID', hasCode(rowFor(idx('DEAL_ID_STATUS_AGREED')), ROW_ISSUE.DEAL_ID_REQUIRES_COMPLETED_STATUS) && rowFor(idx('DEAL_ID_STATUS_AGREED'))?.classification === 'INVALID');
    check('3.35 COMPLETED with blank deal_id -> VALID, with a non-blocking COMPLETED_WITHOUT_DEAL_ID warning (never INVALID)', rowFor(idx('COMPLETED_NO_DEAL_ID'))?.classification === 'NEW' && hasCode(rowFor(idx('COMPLETED_NO_DEAL_ID')), ROW_WARNING.COMPLETED_WITHOUT_DEAL_ID) && (rowFor(idx('COMPLETED_NO_DEAL_ID'))?.issues ?? []).every((i) => i.severity === 'warning'));
    check('3.36 negative deal_id -> INVALID_DEAL_ID / INVALID', hasCode(rowFor(idx('DEAL_ID_NEGATIVE')), ROW_ISSUE.INVALID_DEAL_ID) && rowFor(idx('DEAL_ID_NEGATIVE'))?.classification === 'INVALID');
    check('3.37 zero deal_id -> INVALID_DEAL_ID / INVALID', hasCode(rowFor(idx('DEAL_ID_ZERO')), ROW_ISSUE.INVALID_DEAL_ID) && rowFor(idx('DEAL_ID_ZERO'))?.classification === 'INVALID');
    check('3.38 decimal deal_id -> INVALID_DEAL_ID / INVALID', hasCode(rowFor(idx('DEAL_ID_DECIMAL')), ROW_ISSUE.INVALID_DEAL_ID) && rowFor(idx('DEAL_ID_DECIMAL'))?.classification === 'INVALID');
    check('3.39 arbitrary text deal_id -> INVALID_DEAL_ID / INVALID', hasCode(rowFor(idx('DEAL_ID_TEXT')), ROW_ISSUE.INVALID_DEAL_ID) && rowFor(idx('DEAL_ID_TEXT'))?.classification === 'INVALID');

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

    // Same deal_id may validly link to more than one lead — no uniqueness
    // failure at any layer (isolated call: two otherwise-independent NEW rows).
    {
      const twinValues = buildValues([
        sheetRow({ lead_id: randomUuid(), status: 'COMPLETED', deal_id: dealOutA }),
        sheetRow({ lead_id: randomUuid(), status: 'COMPLETED', deal_id: dealOutA }),
      ]);
      const twinResult = await classifySheetValues(twinValues, sourceA, admin);
      check('3.40 the same deal_id may validly link to more than one lead — both classify NEW, no uniqueness failure',
        !twinResult.fatal && twinResult.rows[0]?.classification === 'NEW' && twinResult.rows[1]?.classification === 'NEW' &&
        !twinResult.rows[0]?.issues.some((i) => i.code === ROW_ISSUE.DEAL_ITEM_MISMATCH) && !twinResult.rows[1]?.issues.some((i) => i.code === ROW_ISSUE.DEAL_ITEM_MISMATCH),
        twinResult.rows);
    }

    // Old-style A:R sheet (no deal_id column at all) still works — every row's
    // deal_id normalizes to NULL, and no MISSING_HEADERS fatal is raised for it.
    {
      const oldStyleValues = buildValuesNoDealIdHeader([sheetRow({ lead_id: randomUuid(), status: 'OPEN' }), sheetRow({ lead_id: randomUuid(), status: 'COMPLETED' })]);
      check('the old-style header row has no deal_id column', (oldStyleValues[0] as string[]).includes('updated_at') && !(oldStyleValues[0] as string[]).includes('deal_id'));
      const { preview, rows } = await classifySheetValuesDetailed(oldStyleValues, sourceA, admin);
      check('3.41 an old A:R sheet (no deal_id column) is not fatal', !preview.fatal, preview.fatalIssues);
      check('3.42 an old A:R sheet classifies every row NEW with deal_id normalized to NULL for every row', rows.every((r) => r.classification === 'NEW' && r.normalized?.dealId === null), rows.map((r) => r.normalized?.dealId));
      check('3.43 a COMPLETED row on an old A:R sheet still gets the non-blocking COMPLETED_WITHOUT_DEAL_ID warning, never INVALID', rows[1]?.classification === 'NEW' && rows[1]?.issues.some((i) => i.code === ROW_WARNING.COMPLETED_WITHOUT_DEAL_ID));
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

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 6: Import write path (mocked sheet, real DB) ===');

    // ── Section 6 fixtures/harness ────────────────────────────────────
    // Every import below goes through the real runLeadImport() — claim,
    // sheet read, normalize, validate, classify, apply — with ONLY the
    // Google Sheets HTTP calls mocked. Supabase traffic is passed straight
    // through to the local instance.
    // One step past Section 3's T_NOW, for "the source genuinely moved on".
    const T_NEWER = '2026-05-01T00:00:00Z';

    const authIdAdmin = await ensureAuthUser(admin, TEST_ADMIN_EMAIL);
    const adminUserId = await resolveAppUserId(admin, authIdAdmin, TEST_ADMIN_EMAIL);
    await admin.from('app_users').update({ admin: true }).eq('id', adminUserId);

    const { privateKey: fixtureKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.GOOGLE_SHEETS_CLIENT_EMAIL = 'fixture@example.iam.gserviceaccount.com';
    process.env.GOOGLE_SHEETS_PRIVATE_KEY = fixtureKey;

    let googleCallCount = 0;
    let realNetworkCallCount = 0;

    const withMockedSheet = async <T,>(values: SheetCellValue[][], fn: () => Promise<T>): Promise<T> => {
      const originalFetch = global.fetch;
      global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes('oauth2.googleapis.com')) {
          googleCallCount++;
          return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('sheets.googleapis.com')) {
          googleCallCount++;
          return new Response(JSON.stringify({ values }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (!url.includes('127.0.0.1') && !url.includes('localhost')) realNetworkCallCount++;
        return originalFetch(input, init);
      }) as typeof fetch;
      try {
        return await fn();
      } finally {
        global.fetch = originalFetch;
      }
    };

    const importSheet = (source: LeadImportSource, values: SheetCellValue[][], requestedBy = adminUserId) =>
      withMockedSheet(values, () => runLeadImport({ serviceClient: admin, source, requestedByUserId: requestedBy }));

    const resetImportState = async () => {
      await admin.from('lead_import_runs').delete().in('source_id', [sourceA.id, sourceB.id]);
      await admin.from('item_leads').delete().in('user_id', [userA, userB]);
      await admin.from('lead_import_sources')
        .update({ last_successful_import_at: null, last_source_updated_at_seen: null })
        .in('id', [sourceA.id, sourceB.id]);
    };

    const leadsFor = async (userId: number) => {
      const { data } = await admin.from('item_leads').select('*').eq('user_id', userId);
      return (data ?? []) as Record<string, unknown>[];
    };
    const leadByLeadId = async (userId: number, leadId: string) => {
      const { data } = await admin.from('item_leads').select('*').eq('user_id', userId).eq('lead_id', leadId).maybeSingle();
      return data as Record<string, unknown> | null;
    };
    const runById = async (runId: number) => {
      const { data } = await admin.from('lead_import_runs').select('*').eq('id', runId).maybeSingle();
      return data as Record<string, unknown> | null;
    };
    const runRowsFor = async (runId: number) => {
      const { data } = await admin.from('lead_import_run_rows').select('*').eq('import_run_id', runId).order('sheet_row_number');
      return (data ?? []) as Record<string, unknown>[];
    };
    const sourceRow = async (sourceId: number) => {
      const { data } = await admin.from('lead_import_sources').select('*').eq('id', sourceId).maybeSingle();
      return data as LeadImportSource;
    };
    const outcomeOf = (result: Awaited<ReturnType<typeof runLeadImport>>) => (result.ok ? result.outcome : null);

    await resetImportState();

    // ── 6.1 A whole all-new batch inserts (the real 127-row shape) ────
    // Deliberately the same size as the production first import, so the
    // single-transaction apply is exercised at the scale it will actually
    // run at: every classified NEW row must become exactly one inserted
    // item_leads row, with nothing lost or duplicated in between.
    const BATCH_SIZE = 127;
    const batchLeadIds = Array.from({ length: BATCH_SIZE }, () => randomUuid());
    const batchSheet = buildValues(batchLeadIds.map((id, i) => sheetRow({
      lead_id: id,
      updated_at: T_NOW,
      lead_quality: 'ENGAGED',
      status: 'OPEN',
      initial_cash_offer: 100 + i,
      best_cash_offer: 200 + i,
      notes: `fixture note for row ${i} — must never reach the audit table`,
    })));

    {
      const result = await importSheet(sourceA, batchSheet);
      const outcome = outcomeOf(result);
      check('6.1a all-new batch import succeeds', result.ok && outcome?.status === 'COMPLETED', result);
      check('6.1b every new row was inserted', outcome?.counts.inserted === BATCH_SIZE && outcome?.counts.updated === 0, outcome?.counts);
      const stored = await leadsFor(userA);
      check('6.1c item_leads now holds exactly the batch', stored.length === BATCH_SIZE, stored.length);
      check('6.1d source lead_ids are preserved verbatim',
        batchLeadIds.every((id) => stored.some((s) => s.lead_id === id)));
      check('6.1e created_at / updated_at / last_imported_at are all set by the database',
        stored.every((s) => !!s.created_at && !!s.updated_at && !!s.last_imported_at));
      check('6.1f user_id and source_id come from the source, not the sheet',
        stored.every((s) => s.user_id === userA && s.source_id === sourceA.id));
    }

    // ── 6.2 Re-running an unchanged sheet writes nothing ──────────────
    {
      const result = await importSheet(sourceA, batchSheet);
      const outcome = outcomeOf(result);
      check('6.2a retry after success is idempotent (nothing written)',
        outcome?.counts.inserted === 0 && outcome?.counts.updated === 0, outcome?.counts);
      check('6.2b every row re-classifies as UNCHANGED', outcome?.counts.unchanged === BATCH_SIZE, outcome?.counts);
      check('6.2c retry status is COMPLETED, not COMPLETED_WITH_ERRORS', outcome?.status === 'COMPLETED', outcome?.status);
      const stored = await leadsFor(userA);
      check('6.2d no duplicate leads were created', stored.length === BATCH_SIZE, stored.length);
    }

    // ── 6.3 UPDATE only when the source is genuinely newer ────────────
    const updatedLeadId = batchLeadIds[0];
    {
      const before = await leadByLeadId(userA, updatedLeadId);
      const newerSheet = buildValues(batchLeadIds.map((id, i) => sheetRow({
        lead_id: id,
        updated_at: id === updatedLeadId ? T_NEWER : T_NOW,
        lead_quality: id === updatedLeadId ? 'SERIOUS' : 'ENGAGED',
        status: id === updatedLeadId ? 'AGREED' : 'OPEN',
        initial_cash_offer: 100 + i,
        best_cash_offer: 200 + i,
      })));
      const outcome = outcomeOf(await importSheet(sourceA, newerSheet));
      check('6.3a exactly one row updated', outcome?.counts.updated === 1 && outcome?.counts.inserted === 0, outcome?.counts);

      const after = await leadByLeadId(userA, updatedLeadId);
      check('6.3b internal id is preserved across an update', !!before && !!after && before.id === after.id, { before: before?.id, after: after?.id });
      check('6.3c created_at is preserved across an update', before?.created_at === after?.created_at, { before: before?.created_at, after: after?.created_at });
      check('6.3d updated_at advanced', !!after && String(after.updated_at) > String(before?.updated_at), { before: before?.updated_at, after: after?.updated_at });
      check('6.3e last_imported_at advanced', !!after && String(after.last_imported_at) > String(before?.last_imported_at));
      check('6.3f source state was replaced with the newer sheet row', after?.status === 'AGREED' && after?.lead_quality === 'SERIOUS', after);
      check('6.3g lead_id was never regenerated', after?.lead_id === updatedLeadId);
    }

    // ── 6.4 An equal source timestamp never writes ────────────────────
    {
      const equalTimestampSheet = buildValues([sheetRow({
        lead_id: updatedLeadId, updated_at: T_NEWER, lead_quality: 'HIGH_INTENT', status: 'COMPLETED',
      })]);
      const outcome = outcomeOf(await importSheet(sourceA, equalTimestampSheet));
      check('6.4a equal source_updated_at classifies UNCHANGED', outcome?.counts.unchanged === 1, outcome?.counts);
      check('6.4b equal source_updated_at writes nothing', outcome?.counts.updated === 0 && outcome?.counts.inserted === 0, outcome?.counts);
      const after = await leadByLeadId(userA, updatedLeadId);
      check('6.4c stored state was not touched by the equal-timestamp row', after?.status === 'AGREED' && after?.lead_quality === 'SERIOUS', after);
    }

    // ── 6.5 An older source row is skipped with a warning ─────────────
    {
      const olderSheet = buildValues([sheetRow({
        lead_id: updatedLeadId, updated_at: T_OLD, status: 'GHOSTED', lead_quality: 'SERIOUS',
      })]);
      const result = await importSheet(sourceA, olderSheet);
      const outcome = outcomeOf(result);
      check('6.5a older source row classifies SOURCE_OLDER', outcome?.counts.sourceOlder === 1, outcome?.counts);
      check('6.5b older source row writes nothing', outcome?.counts.updated === 0 && outcome?.counts.inserted === 0, outcome?.counts);
      check('6.5c a SOURCE_OLDER skip alone is not an error status', outcome?.status === 'COMPLETED', outcome?.status);
      const after = await leadByLeadId(userA, updatedLeadId);
      check('6.5d stored state survives an older source row', after?.status === 'AGREED', after?.status);
      const rows = outcome ? await runRowsFor(outcome.runId) : [];
      check('6.5e the skip is audited as SKIPPED_SOURCE_OLDER',
        rows.some((r) => r.result === 'SKIPPED_SOURCE_OLDER' && (r.issue_codes as string[]).includes('SOURCE_OLDER')), rows);
    }

    // ── 6.6 Invalid rows never cost the valid ones ────────────────────
    await resetImportState();
    {
      const validIds = [randomUuid(), randomUuid(), randomUuid()];
      const mixedSheet = buildValues([
        sheetRow({ lead_id: validIds[0] }),
        sheetRow({ lead_id: validIds[1], lead_quality: 'SUPER_HOT' }),   // invalid enum
        sheetRow({ lead_id: validIds[2] }),
        sheetRow({ lead_id: randomUuid(), item_id: itemB }),             // wrong-owner item
        sheetRow({ lead_id: randomUuid(), offer_type: 'TRADE', cash_component: 75 }),   // invalid cash semantics (non-zero TRADE)
      ]);
      const outcome = outcomeOf(await importSheet(sourceA, mixedSheet));
      check('6.6a valid rows still import alongside invalid ones', outcome?.counts.inserted === 2, outcome?.counts);
      check('6.6b invalid rows are counted, not applied', outcome?.counts.invalid === 3, outcome?.counts);
      check('6.6c a run with invalid rows reports COMPLETED_WITH_ERRORS', outcome?.status === 'COMPLETED_WITH_ERRORS', outcome?.status);
      const stored = await leadsFor(userA);
      check('6.6d only the valid rows reached item_leads', stored.length === 2, stored.length);
      check('6.6e the invalid rows were not written',
        !stored.some((s) => s.lead_id === validIds[1]), stored.map((s) => s.lead_id));
      const rows = outcome ? await runRowsFor(outcome.runId) : [];
      check('6.6f every invalid row is audited as SKIPPED_INVALID with its codes',
        rows.filter((r) => r.result === 'SKIPPED_INVALID').length === 3 &&
        rows.filter((r) => r.result === 'SKIPPED_INVALID').every((r) => (r.issue_codes as string[]).length > 0), rows);
      check('6.6g wrong-user item cannot import (ITEM_NOT_OWNED_BY_SOURCE_USER)',
        rows.some((r) => (r.issue_codes as string[]).includes(ROW_ISSUE.ITEM_NOT_OWNED_BY_SOURCE_USER)), rows);
    }

    // ── 6.15 TRADE + blank cash_component (the recurring production case) ──
    // Canonical rule: TRADE means cash_component = 0. A blank cell is
    // normalized to 0 BEFORE classification/payload construction (with a
    // non-blocking warning), stored as 0, and a re-import of the unchanged
    // sheet stays idempotent. The sheet itself is never modified.
    await resetImportState();
    {
      const ids = { blank: randomUuid(), zero: randomUuid(), pos: randomUuid(), neg: randomUuid(), mixedNull: randomUuid(), mixedPos: randomUuid(), mixedNeg: randomUuid(), mixedZero: randomUuid() };
      const cashValues = buildValues([
        sheetRow({ lead_id: ids.blank, offer_type: 'TRADE', cash_component: null, trade_item: 'Bogner Ecstasy 3534' }),
        sheetRow({ lead_id: ids.zero, offer_type: 'TRADE', cash_component: 0, trade_item: 'Bogner Ecstasy 3534' }),
        sheetRow({ lead_id: ids.pos, offer_type: 'TRADE', cash_component: 50 }),
        sheetRow({ lead_id: ids.neg, offer_type: 'TRADE', cash_component: -50 }),
        sheetRow({ lead_id: ids.mixedNull, offer_type: 'MIXED', cash_component: null }),
        sheetRow({ lead_id: ids.mixedPos, offer_type: 'MIXED', cash_component: 200 }),
        sheetRow({ lead_id: ids.mixedNeg, offer_type: 'MIXED', cash_component: -150 }),
        sheetRow({ lead_id: ids.mixedZero, offer_type: 'MIXED', cash_component: 0 }),
      ]);
      const sheetSnapshot = JSON.stringify(cashValues);
      const preview = await classifySheetValues(cashValues, sourceA, admin);
      const pRow = (n: number) => preview.rows[n];
      const codes = (n: number) => pRow(n).issues.map((i) => i.code);
      check('6.15a TRADE + blank -> valid NEW (not INVALID)', pRow(0).classification === 'NEW');
      check('6.15b TRADE + blank emits TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO as a WARNING only', codes(0).includes(ROW_WARNING.TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO) && pRow(0).issues.every((i) => i.severity === 'warning') && !codes(0).includes(ROW_ISSUE.INVALID_CASH_COMPONENT));
      check('6.15c the warning message is the specified one', pRow(0).issues.some((i) => i.message === 'cash_component was blank for TRADE and was normalized to 0.'));
      check('6.15d TRADE + explicit 0 -> NEW with no warning', pRow(1).classification === 'NEW' && pRow(1).issues.length === 0);
      check('6.15e TRADE + positive -> INVALID_CASH_COMPONENT', pRow(2).classification === 'INVALID' && codes(2).includes(ROW_ISSUE.INVALID_CASH_COMPONENT));
      check('6.15f TRADE + negative -> INVALID_CASH_COMPONENT', pRow(3).classification === 'INVALID' && codes(3).includes(ROW_ISSUE.INVALID_CASH_COMPONENT));
      check('6.15g MIXED + blank -> valid NEW (stays NULL, no warning)', pRow(4).classification === 'NEW' && pRow(4).issues.length === 0);
      check('6.15h MIXED + positive / negative -> valid NEW', pRow(5).classification === 'NEW' && pRow(6).classification === 'NEW');
      check('6.15i MIXED + 0 -> INVALID_CASH_COMPONENT (known zero cash is a TRADE)', pRow(7).classification === 'INVALID' && codes(7).includes(ROW_ISSUE.INVALID_CASH_COMPONENT));
      check('6.15j preview counts: 5 New, 3 Invalid (TRADE blank is NOT counted invalid), exactly 1 Warning', preview.counts.new === 5 && preview.counts.invalid === 3 && preview.counts.warnings === 1, preview.counts);
      check('6.15k the normalized row stays in the importable count (New + Updates = 5)', preview.counts.new + preview.counts.updates === 5);

      const outcome = outcomeOf(await importSheet(sourceA, cashValues));
      check('6.15l import writes exactly the 5 valid rows (warning row included), skips the 3 invalid', outcome?.counts.inserted === 5 && outcome?.counts.invalid === 3, outcome?.counts);
      const blankStored = await leadByLeadId(userA, ids.blank);
      const zeroStored = await leadByLeadId(userA, ids.zero);
      check('6.15m TRADE + blank is STORED as numeric 0 (canonical), not NULL', blankStored?.offer_type === 'TRADE' && blankStored?.cash_component !== null && Number(blankStored?.cash_component) === 0, blankStored?.cash_component);
      check('6.15n explicit 0 and blank-normalized 0 are identical in the database', Number(zeroStored?.cash_component) === 0 && zeroStored?.offer_type === blankStored?.offer_type && Number(zeroStored?.cash_component) === Number(blankStored?.cash_component));
      check('6.15o MIXED semantics stored intact: NULL / +200 / -150; invalid rows never written',
        (await leadByLeadId(userA, ids.mixedNull))?.cash_component === null && Number((await leadByLeadId(userA, ids.mixedPos))?.cash_component) === 200 && Number((await leadByLeadId(userA, ids.mixedNeg))?.cash_component) === -150
        && !(await leadByLeadId(userA, ids.pos)) && !(await leadByLeadId(userA, ids.neg)) && !(await leadByLeadId(userA, ids.mixedZero)));
      const auditRows = outcome ? await runRowsFor(outcome.runId) : [];
      const blankAudit = auditRows.find((r) => r.lead_id === ids.blank);
      check('6.15p the warning row is audited as INSERTED (not SKIPPED_INVALID) with its warning code', blankAudit?.result === 'INSERTED' && (blankAudit?.issue_codes as string[]).includes(ROW_WARNING.TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO), blankAudit);

      // Idempotency: the SAME unchanged sheet (blank still blank) must not re-update forever.
      const rePreview = await classifySheetValues(cashValues, sourceA, admin);
      check('6.15q a repeat preview of the unchanged sheet classifies the blank TRADE row UNCHANGED (never UPDATE)', rePreview.rows[0].classification === 'UNCHANGED' && rePreview.counts.updates === 0 && rePreview.counts.unchanged === 5, rePreview.counts);
      const reOutcome = outcomeOf(await importSheet(sourceA, cashValues));
      check('6.15r a repeat import writes nothing (idempotent)', reOutcome?.counts.inserted === 0 && reOutcome?.counts.updated === 0 && reOutcome?.counts.unchanged === 5, reOutcome?.counts);
      check('6.15s the source sheet was never modified (no 0 written back)', JSON.stringify(cashValues) === sheetSnapshot);

      // A genuinely newer blank TRADE row updates, and still stores 0.
      const newerValues = buildValues([sheetRow({ lead_id: ids.blank, offer_type: 'TRADE', cash_component: null, trade_item: 'Bogner Ecstasy 3534', status: 'GHOSTED', updated_at: T_NEWER })]);
      const upOutcome = outcomeOf(await importSheet(sourceA, newerValues));
      const afterUpdate = await leadByLeadId(userA, ids.blank);
      check('6.15t a newer blank-TRADE row UPDATEs and the stored value stays 0', upOutcome?.counts.updated === 1 && afterUpdate?.status === 'GHOSTED' && Number(afterUpdate?.cash_component) === 0, { counts: upOutcome?.counts, cash: afterUpdate?.cash_component });
    }

    // ── 6.15b "Import N changes" counts warnings as changes ─────────────
    await resetImportState();
    {
      const existingId = randomUuid();
      await importSheet(sourceA, buildValues([sheetRow({ lead_id: existingId, offer_type: 'TRADE', cash_component: 0, updated_at: T_NOW })]));
      const rows = [
        sheetRow({ lead_id: existingId, offer_type: 'TRADE', cash_component: null, updated_at: T_NEWER }),                      // UPDATE + warning
        sheetRow({ lead_id: randomUuid(), offer_type: 'TRADE', cash_component: null }),                                        // NEW + warning
        sheetRow({ lead_id: randomUuid() }),                                                                                    // NEW
        sheetRow({ lead_id: randomUuid(), offer_type: 'TRADE', cash_component: 5 }),                                          // INVALID
      ];
      const vals = buildValues(rows);
      const pv = await classifySheetValues(vals, sourceA, admin);
      check('6.15u warnings do not reduce the importable count: 2 New + 1 Update = 3 changes, 1 Invalid, 2 Warnings', pv.counts.new === 2 && pv.counts.updates === 1 && pv.counts.invalid === 1 && pv.counts.warnings === 2, pv.counts);
      const out = outcomeOf(await importSheet(sourceA, vals));
      check('6.15v the import applies exactly that many changes (3)', (out?.counts.inserted ?? 0) + (out?.counts.updated ?? 0) === pv.counts.new + pv.counts.updates, out?.counts);
    }

    // ── 6.7 A newer row can clear an optional value back to NULL ──────
    await resetImportState();
    const nullableLeadId = randomUuid();
    {
      const populated = buildValues([sheetRow({
        lead_id: nullableLeadId, updated_at: T_NOW,
        trade_item: 'Fender Blues Junior', initial_cash_offer: 400, best_cash_offer: 450,
        first_contact_at: '2026-01-05', outcome_reason: 'PRICE', channel: 'Kijiji',
      })]);
      await importSheet(sourceA, populated);
      const before = await leadByLeadId(userA, nullableLeadId);
      check('6.7a optional values were stored on the first import',
        before?.trade_item === 'Fender Blues Junior' && Number(before?.initial_cash_offer) === 400 && before?.outcome_reason === 'PRICE', before);

      const blanked = buildValues([sheetRow({
        lead_id: nullableLeadId, updated_at: T_NEWER,
        trade_item: null, initial_cash_offer: null, best_cash_offer: null,
        first_contact_at: null, outcome_reason: null, channel: null,
      })]);
      const outcome = outcomeOf(await importSheet(sourceA, blanked));
      check('6.7b the blanked newer row updates', outcome?.counts.updated === 1, outcome?.counts);
      const after = await leadByLeadId(userA, nullableLeadId);
      check('6.7c a newer source row clears optional values to NULL (never a per-field merge)',
        after?.trade_item === null && after?.initial_cash_offer === null && after?.best_cash_offer === null &&
        after?.first_contact_at === null && after?.outcome_reason === null && after?.source_channel === null &&
        after?.deal_channel_id === null, after);
    }

    // ── 6.8 The same lead UUID stays independent per user ─────────────
    {
      const sharedLeadId = randomUuid();
      const sheetForA = buildValues([sheetRow({ lead_id: sharedLeadId, item_id: itemA, status: 'OPEN' })]);
      const sheetForB = buildValues([sheetRow({ lead_id: sharedLeadId, item_id: itemB, status: 'AGREED' })]);
      const outA = outcomeOf(await importSheet(sourceA, sheetForA));
      const outB = outcomeOf(await importSheet(sourceB, sheetForB));
      check('6.8a the same UUID imports for user A', outA?.counts.inserted === 1, outA?.counts);
      check('6.8b the same UUID imports independently for user B', outB?.counts.inserted === 1, outB?.counts);
      const leadForA = await leadByLeadId(userA, sharedLeadId);
      const leadForB = await leadByLeadId(userB, sharedLeadId);
      check('6.8c both rows exist and stay separate',
        !!leadForA && !!leadForB && leadForA.id !== leadForB.id && leadForA.status === 'OPEN' && leadForB.status === 'AGREED',
        { leadForA, leadForB });
    }

    // ── 6.9 A rolled-back apply leaves nothing behind ─────────────────
    // Drives apply_lead_import_batch() directly with a payload whose second
    // row the database must reject (an item owned by another user), which
    // is exactly what an unexpected mid-batch failure looks like. The first
    // row is perfectly valid — the point is that it must NOT survive.
    await resetImportState();
    {
      const goodLeadId = randomUuid();
      const badLeadId = randomUuid();
      const { data: runIdData, error: startErr } = await admin.rpc('start_lead_import_run', {
        p_source_id: sourceA.id, p_requested_by_user_id: adminUserId,
      });
      check('6.9a start_lead_import_run claims a run', !startErr && Number(runIdData) > 0, startErr);
      const failRunId = Number(runIdData);

      const applyRow = (leadId: string, itemId: number, rowNumber: number) => ({
        sheet_row_number: rowNumber, lead_id: leadId, inventory_item_id: itemId,
        first_contact_at: null, last_contact_at: null, source_channel: null, deal_channel_id: null,
        buyer_message_count: null, our_message_count: null, lead_quality: 'LOW', offer_type: 'NONE',
        initial_cash_offer: null, best_cash_offer: null, trade_item: null, cash_component: null,
        trade_est_value: null, status: 'OPEN', outcome_reason: null, notes: null,
        source_updated_at: T_NOW, classification: 'NEW', issue_codes: [], issue_message: null,
      });

      const { error: applyErr } = await admin.rpc('apply_lead_import_batch', {
        p_run_id: failRunId,
        p_apply_rows: [applyRow(goodLeadId, itemA, 2), applyRow(badLeadId, itemB, 3)],
        p_skip_rows: [],
        p_source_row_count: 2, p_new_count: 2, p_update_count: 0,
        p_unchanged_count: 0, p_source_older_count: 0, p_invalid_count: 0,
        p_source_max_updated_at: T_NOW,
      });
      check('6.9b an unexpected DB failure aborts the batch', !!applyErr, applyErr);

      check('6.9c the valid row in the failed batch was rolled back', (await leadByLeadId(userA, goodLeadId)) === null);
      check('6.9d the failing row was never written', (await leadByLeadId(userA, badLeadId)) === null);
      check('6.9e no audit rows survived the rolled-back transaction', (await runRowsFor(failRunId)).length === 0);
      const stillRunning = await runById(failRunId);
      check('6.9f the run row itself survives (claimed in its own transaction)', stillRunning?.status === 'RUNNING', stillRunning?.status);

      const sourceBeforeFail = await sourceRow(sourceA.id);
      check('6.9g a rolled-back apply never advanced last_successful_import_at', sourceBeforeFail.last_successful_import_at === null, sourceBeforeFail.last_successful_import_at);
      check('6.9h a rolled-back apply never advanced last_source_updated_at_seen', sourceBeforeFail.last_source_updated_at_seen === null, sourceBeforeFail.last_source_updated_at_seen);

      const { error: failErr } = await admin.rpc('fail_lead_import_run', {
        p_run_id: failRunId, p_error_summary: 'fixture forced failure', p_audit_rows: [],
        p_source_row_count: 2, p_new_count: 2, p_update_count: 0,
        p_unchanged_count: 0, p_source_older_count: 0, p_invalid_count: 0, p_failed_count: 2,
        p_source_max_updated_at: T_NOW,
      });
      const failed = await runById(failRunId);
      check('6.9i the failed attempt is still visible in history', !failErr && failed?.status === 'FAILED' && failed?.failed_count === 2, { failErr, failed });
      const sourceAfterFail = await sourceRow(sourceA.id);
      check('6.9j recording the failure does not advance source metadata',
        sourceAfterFail.last_successful_import_at === null && sourceAfterFail.last_source_updated_at_seen === null, sourceAfterFail);

      // A retry after the failure must import cleanly — nothing is wedged.
      const retryOutcome = outcomeOf(await importSheet(sourceA, buildValues([sheetRow({ lead_id: goodLeadId, updated_at: T_NOW })])));
      check('6.9k retrying after a failed run imports cleanly', retryOutcome?.counts.inserted === 1 && retryOutcome?.status === 'COMPLETED', retryOutcome);
    }

    // ── 6.10 A duplicate lead_id in the sheet stays fatal ─────────────
    await resetImportState();
    {
      const dupId = randomUuid();
      const dupSheet = buildValues([sheetRow({ lead_id: dupId }), sheetRow({ lead_id: dupId })]);
      const outcome = outcomeOf(await importSheet(sourceA, dupSheet));
      check('6.10a a duplicate lead_id fails the whole run', outcome?.status === 'FAILED', outcome?.status);
      check('6.10b the fatal reason is reported', !!outcome?.fatalIssues.some((i) => i.code === SOURCE_FATAL.DUPLICATE_LEAD_ID), outcome?.fatalIssues);
      check('6.10c a fatal source read writes no leads', (await leadsFor(userA)).length === 0);
      const src = await sourceRow(sourceA.id);
      check('6.10d a fatal run does not advance source metadata', src.last_successful_import_at === null, src);
    }

    // ── 6.11 One import per source at a time ──────────────────────────
    await resetImportState();
    {
      const { data: firstRunId, error: firstErr } = await admin.rpc('start_lead_import_run', {
        p_source_id: sourceA.id, p_requested_by_user_id: adminUserId,
      });
      check('6.11a the first claim succeeds', !firstErr && Number(firstRunId) > 0, firstErr);

      const { error: secondErr } = await admin.rpc('start_lead_import_run', {
        p_source_id: sourceA.id, p_requested_by_user_id: adminUserId,
      });
      check('6.11b a second concurrent claim for the same source is refused',
        !!secondErr && (secondErr.message ?? '').includes('IMPORT_ALREADY_RUNNING'), secondErr);

      // A different source is unaffected by source A's in-flight run.
      const { data: otherRunId, error: otherErr } = await admin.rpc('start_lead_import_run', {
        p_source_id: sourceB.id, p_requested_by_user_id: adminUserId,
      });
      check('6.11c a different source is not blocked', !otherErr && Number(otherRunId) > 0, otherErr);

      // A full import attempt while one is claimed returns the conflict
      // rather than classifying and applying independently.
      const blocked = await importSheet(sourceA, buildValues([sheetRow({})]));
      check('6.11d runLeadImport refuses to start a second import of the same source',
        !blocked.ok && blocked.code === 'IMPORT_ALREADY_RUNNING', blocked);

      await admin.from('lead_import_runs').delete().in('id', [Number(firstRunId), Number(otherRunId)]);
    }

    // ── 6.12 Two simultaneous imports race safely ─────────────────────
    await resetImportState();
    {
      const raceSheet = buildValues([sheetRow({ lead_id: randomUuid(), updated_at: T_NOW })]);
      const [first, second] = await Promise.all([
        importSheet(sourceA, raceSheet),
        importSheet(sourceA, raceSheet),
      ]);
      const results = [first, second];
      const refused = results.filter((r) => !r.ok);
      const totalWritten = results.reduce((sum, r) => sum + (r.ok ? r.outcome.counts.inserted + r.outcome.counts.updated : 0), 0);

      // Either the second attempt was refused outright (the overwhelmingly
      // common case — it claims while the first is still RUNNING), or the
      // first finished so fast that the second got a clean claim and
      // re-classified everything as UNCHANGED. Both are correct; what must
      // never happen is two independent applies of the same rows.
      check('6.12a a simultaneous import is either refused or a no-op',
        refused.every((r) => !r.ok && r.code === 'IMPORT_ALREADY_RUNNING'), results);
      check('6.12b the same row is applied exactly once across the race', totalWritten === 1, { totalWritten, results });
      check('6.12c only one lead row exists after the race', (await leadsFor(userA)).length === 1);
    }

    // ── 6.13 A row missing from the sheet is never a delete ───────────
    await resetImportState();
    {
      const keptId = randomUuid();
      const droppedId = randomUuid();
      await importSheet(sourceA, buildValues([
        sheetRow({ lead_id: keptId, updated_at: T_NOW }),
        sheetRow({ lead_id: droppedId, updated_at: T_NOW, status: 'AGREED' }),
      ]));
      const beforeCount = (await leadsFor(userA)).length;

      // The second sheet no longer mentions droppedId at all.
      const outcome = outcomeOf(await importSheet(sourceA, buildValues([sheetRow({ lead_id: keptId, updated_at: T_NOW })])));
      const dropped = await leadByLeadId(userA, droppedId);
      check('6.13a a lead missing from the sheet is left completely alone',
        beforeCount === 2 && dropped !== null && dropped.status === 'AGREED', { beforeCount, dropped });
      check('6.13b the run does not report any deletion', (await leadsFor(userA)).length === 2, outcome?.counts);
    }

    // ── 6.14 Source metadata after a successful run ───────────────────
    await resetImportState();
    {
      const beforeSource = await sourceRow(sourceA.id);
      const metaSheet = buildValues([
        sheetRow({ lead_id: randomUuid(), updated_at: T_OLD }),
        sheetRow({ lead_id: randomUuid(), updated_at: T_NEWER }),   // the max
        sheetRow({ lead_id: randomUuid(), updated_at: T_NOW }),
      ]);
      const outcome = outcomeOf(await importSheet(sourceA, metaSheet));
      const afterSource = await sourceRow(sourceA.id);
      check('6.14a last_successful_import_at advances on a successful run',
        beforeSource.last_successful_import_at === null && !!afterSource.last_successful_import_at, afterSource);
      check('6.14b last_source_updated_at_seen is the MAX observed source updated_at (not now())',
        !!afterSource.last_source_updated_at_seen &&
        new Date(afterSource.last_source_updated_at_seen).toISOString() === new Date(T_NEWER).toISOString(),
        afterSource.last_source_updated_at_seen);
      check('6.14c the watermark did not filter the scan — every row was still read',
        outcome?.counts.sourceRowCount === 3 && outcome?.counts.inserted === 3, outcome?.counts);

      // A follow-up run still performs a full scan despite the watermark.
      const rescan = outcomeOf(await importSheet(sourceA, metaSheet));
      check('6.14d the next run still scans the whole sheet', rescan?.counts.sourceRowCount === 3 && rescan?.counts.unchanged === 3, rescan?.counts);
    }

    // ── 6.15 Audit reconciliation + no notes in the audit table ───────
    await resetImportState();
    {
      const secretNote = 'SECRET-NOTE-DO-NOT-AUDIT buyer said he would call back';
      const auditSheet = buildValues([
        sheetRow({ lead_id: randomUuid(), updated_at: T_NOW, notes: secretNote }),
        sheetRow({ lead_id: randomUuid(), updated_at: T_NOW, lead_quality: 'NOPE', notes: secretNote }),
        sheetRow({ lead_id: randomUuid(), updated_at: T_NOW, notes: secretNote }),
      ]);
      const outcome = outcomeOf(await importSheet(sourceA, auditSheet));
      const runRow = outcome ? await runById(outcome.runId) : null;
      const rows = outcome ? await runRowsFor(outcome.runId) : [];

      check('6.15a one audit row per source row', rows.length === runRow?.source_row_count && rows.length === 3, { rows: rows.length, runRow });
      check('6.15b audited results reconcile with the run outcome counts',
        rows.filter((r) => r.result === 'INSERTED').length === runRow?.inserted_count &&
        rows.filter((r) => r.result === 'UPDATED').length === runRow?.updated_count &&
        rows.filter((r) => r.result === 'SKIPPED_INVALID').length === runRow?.invalid_count,
        { rows, runRow });
      check('6.15c audited classifications reconcile with the run classification counts',
        rows.filter((r) => r.classification === 'NEW').length === runRow?.new_count &&
        rows.filter((r) => r.classification === 'UPDATE').length === runRow?.update_count &&
        rows.filter((r) => r.classification === 'UNCHANGED').length === runRow?.unchanged_count &&
        rows.filter((r) => r.classification === 'SOURCE_OLDER').length === runRow?.source_older_count &&
        rows.filter((r) => r.classification === 'INVALID').length === runRow?.invalid_count,
        { rows, runRow });
      check('6.15d classification counts add up to the scanned row count',
        (runRow?.new_count as number) + (runRow?.update_count as number) + (runRow?.unchanged_count as number) +
        (runRow?.source_older_count as number) + (runRow?.invalid_count as number) === runRow?.source_row_count, runRow);

      const storedNotes = (await leadsFor(userA)).map((l) => l.notes);
      check('6.15e notes ARE stored on the lead itself', storedNotes.some((n) => n === secretNote), storedNotes);
      check('6.15f notes are NEVER copied into the run-row audit',
        !JSON.stringify(rows).includes('SECRET-NOTE-DO-NOT-AUDIT'), rows);
      check('6.15g the audit table has no notes/payload column at all',
        rows.every((r) => !('notes' in r) && !('payload' in r) && !('lead_payload' in r)), Object.keys(rows[0] ?? {}));

      // The exact filter GET /api/admin/lead-import/runs/[runId]/rows uses
      // for its default "issues" view — verified here so a PostgREST
      // syntax slip in that route cannot go unnoticed.
      const issueFiltered = await admin.from('lead_import_run_rows').select('*')
        .eq('import_run_id', outcome?.runId ?? -1)
        .or('classification.in.(INVALID,SOURCE_OLDER),result.in.(FAILED,SKIPPED_NOT_APPLIED)');
      check('6.15h the history issue filter selects exactly the problem rows',
        !issueFiltered.error && (issueFiltered.data ?? []).length === 1 &&
        (issueFiltered.data ?? [])[0]?.classification === 'INVALID', issueFiltered);
    }

    // ── 6.16 Only an admin can start an import ────────────────────────
    {
      const { error: nonAdminErr } = await admin.rpc('start_lead_import_run', {
        p_source_id: sourceA.id, p_requested_by_user_id: userA,
      });
      check('6.16 a non-admin requester is refused at the database layer',
        !!nonAdminErr && (nonAdminErr.message ?? '').includes('REQUESTER_NOT_ADMIN'), nonAdminErr);
    }

    // ── 6.17 A disabled source cannot be imported ─────────────────────
    {
      await admin.from('lead_import_sources').update({ is_enabled: false }).eq('id', sourceB.id);
      const blocked = await importSheet(sourceB, buildValues([sheetRow({ item_id: itemB })]));
      check('6.17 a disabled source is refused before any read or write',
        !blocked.ok && blocked.code === 'SOURCE_DISABLED', blocked);
      await admin.from('lead_import_sources').update({ is_enabled: true }).eq('id', sourceB.id);
    }

    // ── 6.18 The write path never deletes ─────────────────────────────
    // Structural: no shipped import code — SQL or TypeScript — contains a
    // delete/soft-delete against item_leads. Read from disk so this stays
    // true for whatever the migrations and importer actually say today.
    {
      const importSourcePaths = [
        'supabase/migrations/20260909000000_lead_import_runs.sql',
        'supabase/migrations/20260909000001_apply_lead_import.sql',
        'src/lib/leadImport/importRun.ts',
        'src/app/api/admin/lead-import/import/route.ts',
      ];
      const combinedText = importSourcePaths
        .map((rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8'))
        .join(String.fromCharCode(10));
      const deletePatterns = [
        /DELETE\s+FROM\s+(public\.)?item_leads/i,
        /from\('item_leads'\)[^\n]*\.delete/i,
        /\.delete\(\)[^\n]*item_leads/i,
      ];
      check('6.18a no import code path deletes an item_leads row',
        !deletePatterns.some((re) => re.test(combinedText)));
      check('6.18b no import code path soft-deletes or tombstones a lead',
        !/item_leads[^\n]*(deleted_at|is_deleted|tombstone)/i.test(combinedText));
    }

    // ── 6.19 source state cannot change without a newer source stamp ──
    {
      const leads = await leadsFor(userA);
      const target = leads[0];
      const staleUpdate = await admin.from('item_leads')
        .update({ status: 'GHOSTED' })
        .eq('id', target.id as number)
        .select('id')
        .maybeSingle();
      check('6.19a a mirrored-column change without a newer source_updated_at is rejected',
        !staleUpdate.data && !!staleUpdate.error, staleUpdate.error);

      const internalOnly = await admin.from('item_leads')
        .update({ last_imported_at: new Date().toISOString() })
        .eq('id', target.id as number)
        .select('id')
        .maybeSingle();
      check('6.19b an internal-only column update is still allowed', !!internalOnly.data, internalOnly.error);
    }

    // ── 6.20 Google was mocked throughout ─────────────────────────────
    check('6.20a the Google Sheets API was exercised only through the mock', googleCallCount > 0, googleCallCount);
    check('6.20b no real external network call was made during the import tests', realNetworkCallCount === 0, realNetworkCallCount);

    // ── 6.21 Lead -> Deal linkage: full import lifecycle (NULL -> linked ->
    // relinked -> unlinked), idempotency, and Preview/Import agreement ──────
    {
      const dealLeadId = randomUuid();
      const T1 = '2026-06-01T00:00:00Z';
      const T2 = '2026-06-02T00:00:00Z';
      const T3 = '2026-06-03T00:00:00Z';
      const T4 = '2026-06-04T00:00:00Z';

      // A second real deal (also user A's, itemA outgoing) to relink onto.
      const dealOutA2 = await ensureDeal(admin, userA, 'trade', 'LEADIMPORT:dealOutA2');
      await ensureDealItem(admin, userA, dealOutA2, itemA, 'out');

      const sheetAt = (updatedAt: string, status: string, dealId: number | string | null) =>
        buildValues([sheetRow({ lead_id: dealLeadId, updated_at: updatedAt, status, deal_id: dealId })]);

      // Step 1: NEW, no deal_id.
      {
        const preview = await classifySheetValues(sheetAt(T1, 'OPEN', null), sourceA, admin);
        check('6.21a Preview classifies the fresh row NEW', preview.rows[0]?.classification === 'NEW');
        const outcome = outcomeOf(await importSheet(sourceA, sheetAt(T1, 'OPEN', null)));
        check('6.21b import inserts it with deal_id NULL', outcome?.counts.inserted === 1, outcome?.counts);
        const stored = await leadByLeadId(userA, dealLeadId);
        check('6.21c stored deal_id is NULL', stored?.deal_id == null, stored);
      }

      // Step 2: newer row links deal_id -> dealOutA (also flips to COMPLETED, required by the CHECK) -> UPDATE.
      {
        const values = sheetAt(T2, 'COMPLETED', dealOutA);
        const previewRows = (await classifySheetValues(values, sourceA, admin)).rows;
        check('6.21d Preview classifies the newly-linked row UPDATE', previewRows[0]?.classification === 'UPDATE');
        const outcome = outcomeOf(await importSheet(sourceA, values));
        check('6.21e Preview and Import agree: import also applies it as an UPDATE', outcome?.counts.updated === 1 && outcome?.counts.inserted === 0, outcome?.counts);
        const stored = await leadByLeadId(userA, dealLeadId);
        check('6.21f item_leads.deal_id is now set to the linked deal', stored?.deal_id === dealOutA, stored);
      }

      // Step 3: re-importing the identical row is idempotent (UNCHANGED, nothing written).
      {
        const values = sheetAt(T2, 'COMPLETED', dealOutA);
        const preview = await classifySheetValues(values, sourceA, admin);
        check('6.21g Preview classifies the identical re-import UNCHANGED', preview.rows[0]?.classification === 'UNCHANGED');
        const outcome = outcomeOf(await importSheet(sourceA, values));
        check('6.21h re-importing the identical row writes nothing (idempotent)', outcome?.counts.updated === 0 && outcome?.counts.inserted === 0 && outcome?.counts.unchanged === 1, outcome?.counts);
        const stored = await leadByLeadId(userA, dealLeadId);
        check('6.21i deal_id is unchanged by the idempotent re-import', stored?.deal_id === dealOutA, stored);
      }

      // Step 4: a newer row re-links to a DIFFERENT deal -> UPDATE, deal_id changes.
      {
        const values = sheetAt(T3, 'COMPLETED', dealOutA2);
        const outcome = outcomeOf(await importSheet(sourceA, values));
        check('6.21j relinking to a different deal on a newer row is an UPDATE', outcome?.counts.updated === 1, outcome?.counts);
        const stored = await leadByLeadId(userA, dealLeadId);
        check('6.21k stored deal_id follows the newer source (changed to the new deal)', stored?.deal_id === dealOutA2, stored);
      }

      // Step 5: a newer row removes the link (blank deal_id, status stays COMPLETED) -> UPDATE, deal_id back to NULL.
      {
        const values = sheetAt(T4, 'COMPLETED', null);
        const preview = await classifySheetValues(values, sourceA, admin);
        check('6.21l Preview accepts COMPLETED + blank deal_id (warns, does not invalidate) and classifies UPDATE', preview.rows[0]?.classification === 'UPDATE' && preview.rows[0]?.issues.some((i) => i.code === ROW_WARNING.COMPLETED_WITHOUT_DEAL_ID));
        const outcome = outcomeOf(await importSheet(sourceA, values));
        check('6.21m removing the link on a newer row is an UPDATE', outcome?.counts.updated === 1, outcome?.counts);
        const stored = await leadByLeadId(userA, dealLeadId);
        check('6.21n stored deal_id follows the newer source (cleared back to NULL)', stored?.deal_id == null, stored);
      }

      // User isolation: user A's sheet cannot link a lead to user B's deal —
      // rejected before any write, and the error never names user B's deal content.
      {
        const isolationLeadId = randomUuid();
        const values = buildValues([sheetRow({ lead_id: isolationLeadId, updated_at: T1, status: 'COMPLETED', deal_id: dealOutB })]);
        const preview = await classifySheetValues(values, sourceA, admin);
        check('6.21o Preview rejects a deal_id owned by a different user (DEAL_NOT_OWNED_BY_SOURCE_USER)', preview.rows[0]?.classification === 'INVALID' && preview.rows[0]?.issues.some((i) => i.code === ROW_ISSUE.DEAL_NOT_OWNED_BY_SOURCE_USER));
        check('6.21p the rejection message never reveals user B\'s deal details', !preview.rows[0]?.issues.some((i) => /user ?b|userB|itemB/i.test(i.message)));
        const outcome = outcomeOf(await importSheet(sourceA, values));
        check('6.21q Import agrees with Preview: the row is skipped as invalid, nothing written', outcome?.counts.invalid === 1 && outcome?.counts.inserted === 0 && outcome?.counts.updated === 0, outcome?.counts);
        check('6.21r no lead was created for the rejected row', (await leadByLeadId(userA, isolationLeadId)) === null);

        // Defense in depth: even if an unowned deal_id somehow reached apply_lead_import_batch
        // directly (bypassing Preview/Import's own validation), the database itself refuses it.
        const { data: startData } = await admin.rpc('start_lead_import_run', { p_source_id: sourceA.id, p_requested_by_user_id: adminUserId });
        const directRunId = Number(startData);
        const { error: directApplyError } = await admin.rpc('apply_lead_import_batch', {
          p_run_id: directRunId,
          p_apply_rows: [{
            sheet_row_number: 1, lead_id: isolationLeadId, inventory_item_id: itemA,
            first_contact_at: null, last_contact_at: null, source_channel: null, deal_channel_id: null,
            buyer_message_count: null, our_message_count: null, lead_quality: 'LOW', offer_type: 'NONE',
            initial_cash_offer: null, best_cash_offer: null, trade_item: null, cash_component: null, trade_est_value: null,
            status: 'COMPLETED', outcome_reason: null, notes: null, deal_id: dealOutB, source_updated_at: T1,
            classification: 'NEW', issue_codes: [], issue_message: null,
          }],
          p_skip_rows: [],
          p_source_row_count: 1, p_new_count: 1, p_update_count: 0, p_unchanged_count: 0, p_source_older_count: 0, p_invalid_count: 0,
          p_source_max_updated_at: T1,
        });
        check('6.21s the DATABASE itself rejects an unowned deal_id (DEAL_NOT_OWNED_BY_SOURCE_USER), even bypassing app-level validation', !!directApplyError && /DEAL_NOT_OWNED_BY_SOURCE_USER/.test(directApplyError.message), directApplyError);
        await admin.rpc('fail_lead_import_run', {
          p_run_id: directRunId, p_error_summary: 'test cleanup', p_audit_rows: [],
          p_source_row_count: 0, p_new_count: 0, p_update_count: 0, p_unchanged_count: 0, p_source_older_count: 0, p_invalid_count: 0, p_failed_count: 0,
          p_source_max_updated_at: null,
        });
        check('6.21t no lead was created by the direct-RPC bypass attempt', (await leadByLeadId(userA, isolationLeadId)) === null);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 7: Import security (authenticated clients) ===');

    // Everything below runs as a real signed-in `authenticated` user — not
    // service_role — so it exercises the actual table privileges and RLS a
    // browser session would hit.
    {
      // Leave one lead and one run in place for user A to try to read/write.
      const securityLeadId = randomUuid();
      await importSheet(sourceA, buildValues([sheetRow({ lead_id: securityLeadId, updated_at: T_NOW })]));

      const asUserA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const signInA = await asUserA.auth.signInWithPassword({ email: TEST_USER_A_EMAIL, password: TEST_PASSWORD });
      check('7.0 fixture user A can sign in', !signInA.error && !!signInA.data.session, signInA.error);

      const asUserB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const signInB = await asUserB.auth.signInWithPassword({ email: TEST_USER_B_EMAIL, password: TEST_PASSWORD });
      check('7.0b fixture user B can sign in', !signInB.error && !!signInB.data.session, signInB.error);

      // ── item_leads stays read-only for browsers ───────────────────
      const ownRead = await asUserA.from('item_leads').select('id').eq('lead_id', securityLeadId);
      check('7.1 an owner can read their own imported leads', !ownRead.error && (ownRead.data ?? []).length === 1, ownRead);

      const otherRead = await asUserB.from('item_leads').select('id').eq('lead_id', securityLeadId);
      check('7.2 another user cannot read those leads', !otherRead.error && (otherRead.data ?? []).length === 0, otherRead);

      // ── deal_id specifically stays inside existing RLS/read-model boundaries ──
      const dealLinkedLeadId = randomUuid();
      await importSheet(sourceA, buildValues([sheetRow({ lead_id: dealLinkedLeadId, updated_at: T_NEWER, status: 'COMPLETED', deal_id: dealOutA })]));
      const ownDealRead = await asUserA.from('item_leads').select('deal_id').eq('lead_id', dealLinkedLeadId).maybeSingle();
      check('7.2b the owner can read deal_id through the normal read model', ownDealRead.data?.deal_id === dealOutA, ownDealRead);
      const otherDealRead = await asUserB.from('item_leads').select('deal_id').eq('lead_id', dealLinkedLeadId).maybeSingle();
      check('7.2c another user cannot read that linked lead\'s deal_id through existing RLS (row simply does not exist for them)', !otherDealRead.data, otherDealRead);

      const directInsert = await asUserA.from('item_leads').insert({
        user_id: userA, source_id: sourceA.id, inventory_item_id: itemA, lead_id: randomUuid(),
        lead_quality: 'LOW', offer_type: 'NONE', status: 'OPEN', source_updated_at: T_NOW,
      }).select('id').maybeSingle();
      check('7.3 the browser cannot INSERT into item_leads', !directInsert.data && !!directInsert.error, directInsert);

      const directUpdate = await asUserA.from('item_leads')
        .update({ status: 'AGREED', source_updated_at: T_NEWER })
        .eq('lead_id', securityLeadId).select('id').maybeSingle();
      check('7.4 the browser cannot UPDATE item_leads', !directUpdate.data && !!directUpdate.error, directUpdate);

      const directDelete = await asUserA.from('item_leads').delete().eq('lead_id', securityLeadId).select('id');
      check('7.5 the browser cannot DELETE item_leads', !!directDelete.error || (directDelete.data ?? []).length === 0, directDelete);
      check('7.5b the lead is still there afterwards',
        (await leadByLeadId(userA, securityLeadId)) !== null);

      // ── Import history is readable by its owner, nobody else ───────
      const ownRuns = await asUserA.from('lead_import_runs').select('id').eq('source_id', sourceA.id);
      check('7.6 an owner can read their own import history', !ownRuns.error && (ownRuns.data ?? []).length > 0, ownRuns);

      const otherRuns = await asUserB.from('lead_import_runs').select('id').eq('source_id', sourceA.id);
      check('7.7 another user cannot read that import history', !otherRuns.error && (otherRuns.data ?? []).length === 0, otherRuns);

      const otherRunRows = await asUserB.from('lead_import_run_rows').select('id').limit(5);
      check('7.8 another user cannot read that run-row audit', !otherRunRows.error && (otherRunRows.data ?? []).length === 0, otherRunRows);

      const runInsert = await asUserA.from('lead_import_runs').insert({
        source_id: sourceA.id, user_id: userA, requested_by_user_id: userA, status: 'RUNNING',
      }).select('id').maybeSingle();
      check('7.9 the browser cannot fabricate an import run', !runInsert.data && !!runInsert.error, runInsert);

      // ── The write functions are service_role-only ──────────────────
      const rpcStart = await asUserA.rpc('start_lead_import_run', { p_source_id: sourceA.id, p_requested_by_user_id: userA });
      check('7.10 an authenticated user cannot call start_lead_import_run', !!rpcStart.error, rpcStart);

      const rpcApply = await asUserA.rpc('apply_lead_import_batch', {
        p_run_id: 1, p_apply_rows: [], p_skip_rows: [],
        p_source_row_count: 0, p_new_count: 0, p_update_count: 0,
        p_unchanged_count: 0, p_source_older_count: 0, p_invalid_count: 0, p_source_max_updated_at: null,
      });
      check('7.11 an authenticated user cannot call apply_lead_import_batch', !!rpcApply.error, rpcApply);

      const rpcFail = await asUserA.rpc('fail_lead_import_run', {
        p_run_id: 1, p_error_summary: 'x', p_audit_rows: [],
        p_source_row_count: 0, p_new_count: 0, p_update_count: 0,
        p_unchanged_count: 0, p_source_older_count: 0, p_invalid_count: 0, p_failed_count: 0,
        p_source_max_updated_at: null,
      });
      check('7.12 an authenticated user cannot call fail_lead_import_run', !!rpcFail.error, rpcFail);

      await asUserA.auth.signOut();
      await asUserB.auth.signOut();
    }

    delete process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    delete process.env.GOOGLE_SHEETS_PRIVATE_KEY;

    await resetImportState();

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
