/**
 * test-lead-backfill.ts — scripts/backfill-lead-semantics.ts against the LOCAL
 * database (report → apply → idempotent re-apply), plus the pure qualifier
 * restoration rule. Synthetic fixture only; self-cleaning.
 *
 * Usage:  npx tsx scripts/test-lead-backfill.ts
 */

import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, assertLocalSupabaseUrl, assertLocalSupabaseIsRunning } from './setup-analytics-test-fixtures';
import { restoredQualifierName } from './backfill-lead-semantics';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ''); }
}

function runBackfill(mode: 'report' | 'apply'): string {
  return execFileSync('npx', ['tsx', 'scripts/backfill-lead-semantics.ts', '--target=local', `--mode=${mode}`, '--no-audit', '--show-names'], {
    env: { ...process.env, LOCAL_SUPABASE_URL: SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_ROLE_KEY },
    encoding: 'utf8', shell: true,
  });
}

async function main() {
  console.log('\n[R — qualifier restoration rule]');
  check('"Nick (collector) — …" + "Nick" → "Nick (collector)"', restoredQualifierName('Nick (collector) — offered LP + $500', 'Nick') === 'Nick (collector)');
  check('"Karl (Km) — …" + "Karl" → "Karl (Km)"', restoredQualifierName('Karl (Km) — trade talk', 'Karl') === 'Karl (Km)');
  check('no qualifier in the prefix → null', restoredQualifierName('Jane Doe — mint rig', 'Jane Doe') === null);
  check('stored name differs from the prefix base → null (not deterministic)', restoredQualifierName('Nick (collector) — x', 'Nicholas') === null);
  check('prose note → null', restoredQualifierName('Nick asked (politely) about frets', 'Nick') === null);

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = 'lead-backfill-fixture@example.test';
  const { data: created } = await admin.auth.admin.createUser({ email, password: 'Backfill-Fixture-1!', email_confirm: true });
  const authId = created.user?.id ?? (await admin.auth.admin.listUsers({ perPage: 200 })).data.users.find((u) => u.email === email)!.id;
  let userId = 0;
  for (let i = 0; i < 20 && !userId; i++) { const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authId).maybeSingle(); if (data) userId = data.id; else await new Promise((r) => setTimeout(r, 200)); }

  let { data: brand } = await admin.from('brands').select('id').limit(1).maybeSingle();
  let createdBrand: number | null = null;
  if (!brand) { brand = (await admin.from('brands').insert({ name: `BF Brand ${crypto.randomUUID().slice(0, 6)}` }).select('id').single()).data; createdBrand = brand!.id; }
  const itemIds: number[] = [];
  let sourceId = 0;
  try {
    const item = async (status: string) => { const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model: 'BF item', status, serial_number: `BF-${crypto.randomUUID().slice(0, 8)}` }).select('id').single(); if (error) throw error; itemIds.push(data.id); return data.id as number; };
    const listed = await item('listed');
    const sold = await item('sold');
    const { data: src } = await admin.from('lead_import_sources').upsert({ user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'BF', spreadsheet_id: `bf-${userId}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
    sourceId = src!.id;
    const lead = async (itemId: number, o: Record<string, unknown>) => { const { data, error } = await admin.from('item_leads').insert({ user_id: userId, source_id: sourceId, inventory_item_id: itemId, lead_id: crypto.randomUUID(), lead_quality: 'SERIOUS', offer_type: 'NONE', status: 'OPEN', source_updated_at: '2026-09-01T00:00:00Z', ...o }).select('id').single(); if (error) throw error; return data.id as number; };
    const nick = await lead(listed, { contact_name: 'Nick', contact_name_source: 'NOTES_PREFIX_V1', notes: 'Nick (collector) — offered LP + $500–1,000', offer_type: 'MIXED', trade_item: 'LP', cash_component: 500, source_channel: 'Kijiji', buyer_message_count: 3, our_message_count: 1, first_contact_at: '2026-08-14', last_contact_at: '2026-08-16' });
    const cashLead = await lead(listed, { contact_name: 'Cash Carl', contact_name_source: 'LEAD_LOG', offer_type: 'CASH', initial_cash_offer: 700, best_cash_offer: 750, status: 'DECLINED_BY_THEM', outcome_reason: 'PRICE', notes: 'Prose note stays.' });
    const openOnSold = await lead(sold, { contact_name: 'Olive Open', contact_name_source: 'LEAD_LOG', lead_quality: 'LOW' });
    const vague = await lead(listed, { offer_type: 'MIXED', trade_item: 'Some guitar', lead_quality: 'ENGAGED' });

    console.log('\n[B — report (read-only)]');
    const before = await admin.from('item_leads').select('id, peak_stage, status').in('id', [nick, cashLead, openOnSold, vague]);
    const report = runBackfill('report');
    check('report lists the qualifier restoration and the closure', report.includes(`#${nick}: "Nick" → "Nick (collector)"`) && report.includes(`${openOnSold}`) && report.includes('REPORT ONLY'), report.slice(-1500));
    const afterReport = await admin.from('item_leads').select('id, peak_stage, status').in('id', [nick, cashLead, openOnSold, vague]);
    check('report wrote nothing', JSON.stringify(before.data) === JSON.stringify(afterReport.data));

    console.log('\n[C — apply]');
    const out = runBackfill('apply');
    check('apply ran in one call and verified', /result: \{"applied":\d+/.test(out), out.slice(-800));
    const row = async (id: number) => (await admin.from('item_leads').select('*').eq('id', id).single()).data as Record<string, unknown>;
    const n = await row(nick);
    check('qualifier restored, key distinguishes it, provenance kept NOTES_PREFIX_V1', n.contact_name === 'Nick (collector)' && n.contact_key === 'nick (collector)' && n.contact_name_source === 'NOTES_PREFIX_V1', n);
    check('structured stage for a defined MIXED offer = NEGOTIATING (LEGACY_STRUCTURED), rounds 1, concrete', n.peak_stage === 'NEGOTIATING' && n.peak_stage_source === 'LEGACY_STRUCTURED' && n.negotiation_rounds === 1 && n.offer_is_concrete === true, n);
    check('legacy fields untouched (quality, notes, counts, dates)', n.lead_quality === 'SERIOUS' && n.notes === 'Nick (collector) — offered LP + $500–1,000' && n.buyer_message_count === 3 && n.first_contact_at === '2026-08-14', n);
    const c = await row(cashLead);
    check('cash lead: latest_cash_offer = best, status untouched', Number(c.latest_cash_offer) === 750 && c.status === 'DECLINED_BY_THEM' && c.notes === 'Prose note stays.', c);
    const o = await row(openOnSold);
    check('OPEN lead on a sold item → CLOSED / ITEM_UNAVAILABLE, waiting_on NONE', o.status === 'CLOSED' && o.outcome_reason === 'ITEM_UNAVAILABLE' && o.waiting_on === 'NONE', o);
    const v = await row(vague);
    check('vague MIXED (no cash amount) = ENGAGED, not concrete', v.peak_stage === 'ENGAGED' && v.offer_is_concrete === false, v);
    const { data: ev } = await admin.from('lead_events').select('item_lead_id, event_type, source, provenance, occurred_at, payload').in('item_lead_id', [nick, cashLead, openOnSold, vague]).order('id');
    const snaps = (ev ?? []).filter((e) => e.event_type === 'LEGACY_SNAPSHOT');
    check('exactly one LEGACY_SNAPSHOT per lead (BACKFILL, LEGACY provenance)', snaps.length === 4 && snaps.every((e) => e.source === 'BACKFILL' && e.provenance === 'LEGACY'), snaps.length);
    check('no fabricated chronology: only snapshot + the closure status change', (ev ?? []).every((e) => e.event_type === 'LEGACY_SNAPSHOT' || (e.event_type === 'STATUS_CHANGE' && e.item_lead_id === openOnSold)), (ev ?? []).map((e) => e.event_type));
    const nickSnap = snaps.find((e) => e.item_lead_id === nick)!;
    check('snapshot preserves legacy baseline (quality, counts, offer, notes hash, stage)', (nickSnap.payload as { legacy: Record<string, unknown> }).legacy.lead_quality === 'SERIOUS' && (nickSnap.payload as { legacy: Record<string, unknown> }).legacy.buyer_message_count === 3 && typeof (nickSnap.payload as { legacy: Record<string, unknown> }).legacy.notes_sha256 === 'string' && (nickSnap.payload as { legacy: Record<string, unknown> }).legacy.peak_stage === 'NEGOTIATING');
    check('snapshot dated at the legacy last contact (DATE precision)', String(nickSnap.occurred_at).startsWith('2026-08-16'));

    console.log('\n[D — idempotent re-apply]');
    const again = runBackfill('apply');
    check('second apply skips every already-backfilled lead', /"applied":0/.test(again) && /skipped_already_backfilled":\d+/.test(again), again.slice(-600));
    const { count } = await admin.from('lead_events').select('id', { count: 'exact', head: true }).in('item_lead_id', [nick, cashLead, openOnSold, vague]).eq('event_type', 'LEGACY_SNAPSHOT');
    check('still exactly one snapshot per lead', count === 4, count);
  } finally {
    if (itemIds.length) { await admin.from('item_leads').delete().in('inventory_item_id', itemIds); await admin.from('inventory_items').delete().in('id', itemIds); }
    if (sourceId) await admin.from('lead_import_sources').delete().eq('id', sourceId);
    if (createdBrand) await admin.from('brands').delete().eq('id', createdBrand);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
