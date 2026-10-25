/**
 * test-lead-contact-edit.ts
 *
 * Leads UI contact name: list column, search by name, and the detail-panel
 * rename (contact_key / contact_name_source / audit note / collisions /
 * isolation / nothing else changes).
 *   P — pure: name cleaning, collision classification, search
 *   S — source structure: Leads table/cards, detail panel, route, migration
 *   W — local DB through a real signed-in RLS client + the route handler
 * Self-cleaning dedicated fixture (two users). Synthetic names only.
 *
 * Usage:  npx tsx scripts/test-lead-contact-edit.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { classifyContactCollision, cleanContactName, renameLeadContact } from '../src/lib/leads/leadContactEdit';
import { contactKey } from '../src/lib/leads/classification';
import { applyLeadFilters, parseLeadFilters } from '../src/lib/leads/leadFilters';
import { recordLeadInteraction } from '../src/lib/leads/leadWriteService';
import { LEAD_SNAPSHOT_DEFAULTS, type LeadRow } from '../src/lib/leads/leadTypes';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}

const PASSWORD = 'Contact-Edit-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const root = path.join(__dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// ── P ──────────────────────────────────────────────────────────────────
function pureChecks() {
  console.log('\n[P1 — name cleaning keeps qualifiers]');
  check('trims + collapses inner whitespace', cleanContactName('  Nick   (collector)  ') === 'Nick (collector)');
  check('qualifiers kept verbatim', cleanContactName('Nick (ES-325)') === 'Nick (ES-325)' && cleanContactName('Karl (Km)') === 'Karl (Km)');
  check('empty / whitespace -> null (clearing)', cleanContactName('   ') === null && cleanContactName(null) === null);
  check('contact_key keeps the qualifier (same helper as the direct-write matcher)', contactKey('Nick (collector)') === 'nick (collector)' && contactKey('Nick (ES-325)') === 'nick (es-325)' && contactKey('Nick (collector)') !== contactKey('Nick'));

  console.log('\n[P2 — collision classification]');
  const sib = (id: number, name: string, ch = 'Marketplace', detail: string | null = null) => ({ id, contact_name: name, contact_key: contactKey(name), source_channel: ch, channel_detail: detail, status: 'OPEN' });
  const me = { source_channel: 'Marketplace', channel_detail: null };
  check('exact same key on same channel -> exact', classifyContactCollision('anthony  BLACK', me, [sib(1, 'Anthony Black')]).kind === 'exact');
  check('same key on a different channel -> none', classifyContactCollision('Anthony Black', me, [sib(1, 'Anthony Black', 'Kijiji')]).kind === 'none');
  check('same key, different channel detail (Other) -> none', classifyContactCollision('Ann', { source_channel: 'Other', channel_detail: 'Instagram' }, [sib(1, 'Ann', 'Other', 'Guitar show')]).kind === 'none');
  check('"Nick" vs existing "Nick (collector)" -> similar (confirm)', classifyContactCollision('Nick', me, [sib(1, 'Nick (collector)')]).kind === 'similar');
  check('"Nick (ES-325)" vs "Nick (collector)" (both qualified) -> none', classifyContactCollision('Nick (ES-325)', me, [sib(1, 'Nick (collector)')]).kind === 'none');
  check('"John S" vs "John Smith" -> similar', classifyContactCollision('John S', me, [sib(1, 'John Smith')]).kind === 'similar');
  check('unrelated names -> none', classifyContactCollision('Maria Lopez', me, [sib(1, 'John Smith')]).kind === 'none');

  console.log('\n[P3 — search by contact name, existing fields intact]');
  const mk = (id: number, o: Partial<LeadRow>): LeadRow => ({
    id, lead_id: `u-${id}`, inventory_item_id: 1, item_name: 'Fender Stratocaster', first_contact_at: '2026-10-01', last_contact_at: '2026-10-02', source_channel: 'Marketplace', deal_channel_id: 1, channel_name: 'Marketplace',
    buyer_message_count: 1, our_message_count: 1, lead_quality: 'LOW', offer_type: 'NONE', initial_cash_offer: null, best_cash_offer: null, trade_item: null, cash_component: null,
    trade_est_value: null, status: 'OPEN', outcome_reason: null, notes: null, deal_id: null, contact_name: null, source_updated_at: '2026-10-02T00:00:00Z', last_imported_at: null, ...LEAD_SNAPSHOT_DEFAULTS, ...o,
  });
  const rows = [
    mk(1, { contact_name: 'Anthony Black' }),
    mk(2, { contact_name: 'Zoë O’Neil' }),
    mk(3, { item_name: 'Gibson Les Paul', trade_item: 'Boss Katana', notes: 'Wants hard case' }),
    mk(4, { contact_name: 'Nick (collector)' }),
    mk(5, {}),
  ];
  const find = (q: string) => applyLeadFilters(rows, parseLeadFilters((k) => (k === 'search' ? q : null)), null).map((r) => r.id);
  check('"Anthony" finds the lead by contact name', JSON.stringify(find('Anthony')) === '[1]', find('Anthony'));
  check('case-insensitive ("anthony", "ANTH")', JSON.stringify(find('anthony')) === '[1]' && JSON.stringify(find('ANTH')) === '[1]');
  check('accent / apostrophe-insensitive like contact matching ("zoe o\'neil")', JSON.stringify(find("zoe o'neil")) === '[2]', find("zoe o'neil"));
  check('qualifier searchable ("collector")', JSON.stringify(find('collector')) === '[4]');
  check('multi-word: name + item ("anthony strat")', JSON.stringify(find('anthony strat')) === '[1]');
  check('item search still works', find('les paul').includes(3) && !find('les paul').includes(1));
  check('trade item search still works', JSON.stringify(find('katana')) === '[3]');
  check('notes search still works', JSON.stringify(find('hard case')) === '[3]');
  check('nameless leads still searchable by item', find('stratocaster').includes(5));
}

// ── S ──────────────────────────────────────────────────────────────────
function structureChecks() {
  console.log('\n[S1 — Leads list]');
  const page = src('src/app/leads/page.tsx');
  check('desktop table has a Name column before Item', /\{ key: 'name', label: 'Name' \},\s*\{ key: 'item', label: 'Item' \}/.test(page));
  check('name cell shows contact_name (as an exact-name filter) or a neutral dash (never "Unknown")', /\{lead\.contact_name \? \([\s\S]{0,120}data-filter-name/.test(page) && page.includes('aria-label="No name">—</span>') && !/['"]Unknown['"]/.test(page));
  check('mobile cards show the name too', /data-lead-name>\s*\{lead\.contact_name \? \([\s\S]{0,200}data-filter-name[\s\S]{0,300}>No name<\/span>\}/.test(page));
  check('search hint mentions name', page.includes('placeholder="Name, item, trade item, or notes"'));
  check('rows / cards still open the detail panel', page.includes('onClick={() => setSelectedId(lead.id)}') && page.includes('data-lead-card'));
  check('saved edit patches the loaded row (no refetch)', page.includes('onLeadUpdated={patchLead}') && page.includes('leads.map((l) => (l.id === id ? { ...l, ...patch } : l))'));
  console.log('\n[S2 — detail panel / route / migration]');
  const panel = src('src/components/leads/LeadDetailPanel.tsx');
  check('panel: Edit / Add name action and form', panel.includes("{lead.contact_name ? 'Edit' : 'Add name'}") && panel.includes('data-contact-name-form'));
  check('panel: similar-name confirmation step', panel.includes('data-contact-name-confirm') && panel.includes('void save(true)'));
  check('panel: Escape in the input cancels the edit, not the panel', panel.includes("if (e.key === 'Escape') { e.stopPropagation(); cancel(); }"));
  check('panel: only the contact name is editable', (panel.match(/saveLead\w+\(/g) ?? []).length === 1);
  const route = src('src/app/api/leads/[id]/contact-name/route.ts');
  check('route: caller-scoped client, no service_role', route.includes('authenticateApiUser(req)') && !/SERVICE_ROLE/.test(route));
  const svc = src('src/lib/leads/leadContactEdit.ts');
  check('service: contact_key from classification.contactKey (no second algorithm)', svc.includes("from './classification'") && svc.includes('const key = contactKey(name)') && !/toLowerCase\(\)/.test(svc));
  check('service: audit is a planned INTERNAL NOTE through leadWriteService', svc.includes("type: 'NOTE', direction: 'INTERNAL'") && svc.includes('prepareLeadUpdate('));
  const mig = src('supabase/migrations/20261025000000_lead_contact_name_user_edit.sql');
  check('migration: USER_EDIT added to the contact_name_source CHECK', mig.includes("IN ('LEAD_LOG', 'NOTES_PREFIX_V1', 'DIRECT', 'USER_EDIT')"));
  check('migration: rename re-checks same item + channel + detail key collisions', mig.includes('CONTACT_KEY_CONFLICT') && mig.includes('il.inventory_item_id = v_lead.inventory_item_id') && mig.includes('channel_detail'));
}

// ── W ──────────────────────────────────────────────────────────────────
async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (!error && created.user) return created.user.id;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
  const match = listed?.users.find((u) => u.email === email);
  if (match) return match.id;
  throw new Error(`Could not create or find auth user ${email}: ${error?.message}`);
}
async function resolveAppUserId(admin: SupabaseClient, authUserId: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) return data.id as number;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('app_users row never appeared');
}
async function signIn(email: string): Promise<{ client: SupabaseClient; token: string }> {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return { client: c, token: data.session.access_token };
}

const FROZEN = ['peak_stage', 'peak_stage_source', 'status', 'outcome_reason', 'offer_type', 'initial_cash_offer', 'best_cash_offer', 'latest_cash_offer', 'trade_item', 'cash_component',
  'trade_est_value', 'offer_is_concrete', 'offer_assessment', 'buyer_message_count', 'our_message_count', 'first_contact_at', 'last_contact_at', 'waiting_on', 'negotiation_rounds', 'notes', 'deal_id', 'lead_quality'];

async function main() {
  pureChecks();
  structureChecks();

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const emailA = 'contact-edit-fixture-a@example.test';
  const emailB = 'contact-edit-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));
  const { client: cA, token: tokenA } = await signIn(emailA);
  const { client: cB } = await signIn(emailB);

  let { data: brand } = await admin.from('brands').select('id').limit(1).maybeSingle();
  let createdBrand: number | null = null;
  if (!brand) { brand = (await admin.from('brands').insert({ name: `CE Brand ${uuid().slice(0, 6)}` }).select('id').single()).data; createdBrand = brand!.id as number; }
  const { data: chans } = await admin.from('deal_channels').select('id, name');
  const MP = (chans ?? []).find((c) => c.name === 'Marketplace')!.id as number;

  const itemIds: number[] = [];
  let sourceId: number | null = null;
  try {
    const item = async (userId: number, model: string) => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model, status: 'listed', serial_number: `CE-${uuid().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    const { data: s } = await admin.from('lead_import_sources').upsert({ user_id: userA, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'CE', spreadsheet_id: `ce-${userA}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
    sourceId = s!.id as number;
    const sheetLead = async (itemId: number, o: Record<string, unknown>) => {
      const { data, error } = await admin.from('item_leads').insert({
        user_id: userA, source_id: sourceId, inventory_item_id: itemId, lead_id: uuid(), lead_quality: 'SERIOUS', offer_type: 'CASH', initial_cash_offer: 800, best_cash_offer: 850,
        status: 'OPEN', source_channel: 'Marketplace', deal_channel_id: MP, buyer_message_count: 4, our_message_count: 3, first_contact_at: '2026-09-10', last_contact_at: '2026-09-12',
        notes: 'Legacy note — offered 800 then 850', source_updated_at: '2026-09-12T00:00:00Z',
        // as the Sheet importer / backfill leave them: a structured peak stage
        peak_stage: 'NEGOTIATING', peak_stage_source: 'LEGACY_STRUCTURED', negotiation_rounds: 1, offer_is_concrete: true, semantics_version: 1, ...o,
      }).select('id').single();
      if (error) throw error;
      return data.id as number;
    };
    const leadRow = async (id: number) => (await admin.from('item_leads').select('*').eq('id', id).single()).data as Record<string, unknown>;
    const eventsOf = async (id: number) => ((await admin.from('lead_events').select('*').eq('item_lead_id', id).order('id')).data ?? []) as Record<string, unknown>[];
    const frozen = (r: Record<string, unknown>) => JSON.stringify(FROZEN.map((k) => (r[k] == null ? null : String(r[k]))));
    const rename = (client: SupabaseClient, uid: number, leadId: number, name: string | null, version: number, confirm = false) =>
      renameLeadContact(client, uid, { leadId, contactName: name, expectedVersion: version, mutationId: uuid(), confirm });

    console.log('\n[W1 — add a name to a nameless legacy (Sheet) lead]');
    const X = await item(userA, 'Telecaster (CE)');
    const legacy = await sheetLead(X, { contact_name: null });
    const before = await leadRow(legacy);
    const r1 = await rename(cA, userA, legacy, '  Anthony   Black ', Number(before.version));
    const after = await leadRow(legacy);
    check('add name -> RENAMED', r1.result === 'RENAMED', r1);
    check('stored trimmed / collapsed; key from contactKey; source USER_EDIT', after.contact_name === 'Anthony Black' && after.contact_key === contactKey('Anthony Black') && after.contact_name_source === 'USER_EDIT', after);
    check('stage, status, offers, message counts, dates, notes, legacy quality unchanged', frozen(after) === frozen(before), { before: frozen(before), after: frozen(after) });
    const ev = await eventsOf(legacy);
    check('history: fresh LEGACY_SNAPSHOT baseline of the Sheet row, then one INTERNAL NOTE audit', JSON.stringify(ev.map((e) => e.event_type)) === '["LEGACY_SNAPSHOT","NOTE"]', ev.map((e) => e.event_type));
    const note = ev[1];
    check('audit note: "Contact name added", INTERNAL, 0 messages, no reply expected, source UI, actor USER', note.summary === 'Contact name added: "Anthony Black"' && note.direction === 'INTERNAL' && note.message_count === 0 && note.expects_reply === false && note.source === 'UI' && note.actor === 'USER', note);
    check('audit payload carries from/to', (note.payload as { change?: string; from?: unknown; to?: unknown }).change === 'CONTACT_NAME' && (note.payload as { from?: unknown }).from === null && (note.payload as { to?: unknown }).to === 'Anthony Black');
    check('lead becomes app-owned (last_write_source UI) so the Sheet importer cannot overwrite the edit', after.last_write_source === 'UI');

    console.log('\n[W2 — edit an existing name, qualifiers preserved]');
    const nick = await sheetLead(X, { contact_name: 'Nick', contact_name_source: 'NOTES_PREFIX_V1', contact_key: 'nick', source_channel: 'Kijiji', deal_channel_id: (chans ?? []).find((c) => c.name === 'Kijiji')?.id ?? null });
    const nb = await leadRow(nick);
    const r2 = await rename(cA, userA, nick, 'Nick (collector)', Number(nb.version));
    const na = await leadRow(nick);
    check('edit -> RENAMED; qualifier kept; key "nick (collector)"; source NOTES_PREFIX_V1 -> USER_EDIT', r2.result === 'RENAMED' && na.contact_name === 'Nick (collector)' && na.contact_key === 'nick (collector)' && na.contact_name_source === 'USER_EDIT', na);
    check('audit: Contact name changed from "Nick" to "Nick (collector)"', (await eventsOf(nick)).some((e) => e.summary === 'Contact name changed from "Nick" to "Nick (collector)"'));
    check('nothing else changed', frozen(na) === frozen(nb));
    const r2b = await rename(cA, userA, nick, 'Nick (ES-325)', Number(na.version));
    check('second edit to another qualifier works', r2b.result === 'RENAMED' && (await leadRow(nick)).contact_key === 'nick (es-325)');
    const same = await rename(cA, userA, nick, ' Nick (ES-325) ', Number((await leadRow(nick)).version));
    check('same name again -> NO_CHANGE (no event)', same.result === 'NO_CHANGE');

    console.log('\n[W3 — direct lead (has events) keeps its derived state]');
    const Y = await item(userA, 'Jazzmaster (CE)');
    const d = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: Y, channel: 'Marketplace', contact_name: 'Karl' }, events: [
      { type: 'OFFER', direction: 'INBOUND', occurred_at: '2026-10-10T12:00:00-04:00', summary: 'Offered 1200', payload: { offer: { cash_terms: 'AMOUNT', cash_amount: 1200, items: [] } } },
      { type: 'OFFER', direction: 'OUTBOUND', occurred_at: '2026-10-10T13:00:00-04:00', summary: 'Countered 1400', payload: { offer: { cash_terms: 'AMOUNT', cash_amount: 1400, items: [] } } },
    ] });
    const db0 = await leadRow(d.lead_id!);
    const evBefore = (await eventsOf(d.lead_id!)).length;
    const r3 = await rename(cA, userA, d.lead_id!, 'Karl (Km)', Number(db0.version));
    const db1 = await leadRow(d.lead_id!);
    check('direct lead renamed; DIRECT -> USER_EDIT; key "karl (km)"', r3.result === 'RENAMED' && db1.contact_name === 'Karl (Km)' && db1.contact_name_source === 'USER_EDIT' && db1.contact_key === 'karl (km)', db1);
    check('stage NEGOTIATING, rounds, waiting_on, offers, counts unchanged', frozen(db1) === frozen(db0) && db1.peak_stage === 'NEGOTIATING', { b: frozen(db0), a: frozen(db1) });
    check('exactly one new event (the NOTE); earlier events untouched', (await eventsOf(d.lead_id!)).length === evBefore + 1);
    const later = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: Y, channel: 'Marketplace', contact_name: 'karl (KM)' }, events: [{ type: 'MESSAGE', direction: 'INBOUND', occurred_at: '2026-10-11T12:00:00-04:00', summary: 'Still keen', payload: { substance: 'BASIC' } }] });
    check('the direct-write matcher now finds the renamed lead by the new key', later.result === 'APPLIED_UPDATE' && later.lead_id === d.lead_id, later);

    console.log('\n[W4 — collisions on the same item + channel only]');
    const Z = await item(userA, 'Les Paul (CE)');
    const z1 = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: Z, channel: 'Marketplace', contact_name: 'Maria Lopez' }, events: [{ type: 'MESSAGE', direction: 'INBOUND', occurred_at: '2026-10-12T12:00:00-04:00', summary: 'Hi', payload: { substance: 'BASIC' } }] });
    const z2 = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: Z, channel: 'Marketplace', contact_name: 'Dave Stone' }, events: [{ type: 'MESSAGE', direction: 'INBOUND', occurred_at: '2026-10-12T13:00:00-04:00', summary: 'Hi', payload: { substance: 'BASIC' } }] });
    const z2b = await leadRow(z2.lead_id!);
    const clash = await rename(cA, userA, z2.lead_id!, 'maria  LOPEZ', Number(z2b.version));
    check('exact identity collision -> BLOCKED with the conflicting lead; nothing written', clash.result === 'BLOCKED' && clash.conflicting.lead_id === z1.lead_id && (await leadRow(z2.lead_id!)).contact_name === 'Dave Stone' && (await eventsOf(z2.lead_id!)).length === (await eventsOf(z2.lead_id!)).filter((e) => e.event_type !== 'NOTE').length, clash);
    const near = await rename(cA, userA, z2.lead_id!, 'Maria L', Number(z2b.version));
    check('near match ("Maria L" vs "Maria Lopez") -> CONFIRM_REQUIRED, nothing written', near.result === 'CONFIRM_REQUIRED' && (await leadRow(z2.lead_id!)).contact_name === 'Dave Stone', near);
    const conf = await rename(cA, userA, z2.lead_id!, 'Maria L', Number(z2b.version), true);
    check('confirmed near match saves; the leads stay separate (no merge)', conf.result === 'RENAMED' && (await leadRow(z2.lead_id!)).contact_name === 'Maria L' && (await leadRow(z1.lead_id!)).contact_name === 'Maria Lopez');
    const W = await item(userA, 'Other item (CE)');
    const w1 = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: W, channel: 'Marketplace', contact_name: 'Tom' }, events: [{ type: 'MESSAGE', direction: 'INBOUND', occurred_at: '2026-10-12T12:00:00-04:00', summary: 'Hi', payload: { substance: 'BASIC' } }] });
    const cross = await rename(cA, userA, w1.lead_id!, 'Maria Lopez', Number((await leadRow(w1.lead_id!)).version));
    check('same name on a DIFFERENT item is not a collision', cross.result === 'RENAMED', cross);
    const kij = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: Z, channel: 'Kijiji', contact_name: 'Ed' }, events: [{ type: 'MESSAGE', direction: 'INBOUND', occurred_at: '2026-10-12T12:00:00-04:00', summary: 'Hi', payload: { substance: 'BASIC' } }] });
    const crossCh = await rename(cA, userA, kij.lead_id!, 'Maria Lopez', Number((await leadRow(kij.lead_id!)).version));
    check('same name on the same item but a DIFFERENT channel is not a collision', crossCh.result === 'RENAMED', crossCh);
    const { error: dbGuard } = await cA.rpc('rename_lead_contact', { p_request: { mode: 'update', lead_id: z2.lead_id }, p_contact_name: 'Maria Lopez', p_contact_key: 'maria lopez' });
    check('database re-checks the exact collision too (CONTACT_KEY_CONFLICT)', /CONTACT_KEY_CONFLICT/.test(dbGuard?.message ?? ''), dbGuard);

    console.log('\n[W5 — clear, stale version, placeholders]');
    const c0 = await leadRow(w1.lead_id!);
    const cleared = await rename(cA, userA, w1.lead_id!, '   ', Number(c0.version));
    const c1 = await leadRow(w1.lead_id!);
    check('clearing -> name, key and source all NULL (allowed: unnamed leads are valid)', cleared.result === 'RENAMED' && c1.contact_name === null && c1.contact_key === null && c1.contact_name_source === null, c1);
    check('clear audited', (await eventsOf(w1.lead_id!)).some((e) => e.summary === 'Contact name cleared (was "Maria Lopez")'));
    const stale = await rename(cA, userA, w1.lead_id!, 'Tom', Number(c0.version));
    check('stale expected_version -> STALE, nothing written', stale.result === 'STALE' && (await leadRow(w1.lead_id!)).contact_name === null);
    const ph = await rename(cA, userA, w1.lead_id!, 'Unknown', Number(c1.version));
    check('placeholder ("Unknown") rejected — never stored', ph.result === 'INVALID' && (await leadRow(w1.lead_id!)).contact_name === null, ph);

    const raw = await sheetLead(W, { contact_name: null, peak_stage: null, peak_stage_source: null, negotiation_rounds: 0, offer_is_concrete: null, semantics_version: null });
    const rawBefore = await leadRow(raw);
    const guarded = await rename(cA, userA, raw, 'Uma Never', Number(rawBefore.version));
    check('guard: a rename that would move derived fields (never-classified lead) is refused, nothing written', guarded.result === 'INVALID' && /peak_stage/.test(guarded.message) && frozen(await leadRow(raw)) === frozen(rawBefore) && (await leadRow(raw)).contact_name === null && (await eventsOf(raw)).length === 0, guarded);

    // Production shape (133 leads at rollout): final status, legacy waiting_on NULL.
    const declined = await sheetLead(W, { contact_name: null, status: 'DECLINED_BY_THEM', outcome_reason: 'PRICE', waiting_on: null });
    const decBefore = await leadRow(declined);
    const decR = await rename(cA, userA, declined, 'Vic Declined', Number(decBefore.version));
    const decAfter = await leadRow(declined);
    const frozenNoWaiting = (r: Record<string, unknown>) => frozen({ ...r, waiting_on: null });
    check('final-status legacy lead: rename allowed; only waiting_on normalizes NULL -> NONE', decR.result === 'RENAMED' && decAfter.waiting_on === 'NONE' && frozenNoWaiting(decAfter) === frozenNoWaiting(decBefore) && decAfter.status === 'DECLINED_BY_THEM', { decR, w: decAfter.waiting_on });

    console.log('\n[W6 — isolation]');
    const bOwn = await rename(cB, userB, nick, 'Hacked', Number((await leadRow(nick)).version));
    check('user B cannot rename user A\'s lead (NOT_FOUND)', bOwn.result === 'NOT_FOUND' && (await leadRow(nick)).contact_name === 'Nick (ES-325)');
    const bSpoof = await rename(cB, userA, nick, 'Hacked', Number((await leadRow(nick)).version));
    check('…even when passing A\'s app user id (RLS)', bSpoof.result === 'NOT_FOUND' && (await leadRow(nick)).contact_name === 'Nick (ES-325)');
    const { error: directUpdate } = await cA.from('item_leads').update({ contact_name: 'x' }).eq('id', nick).select('id');
    check('no direct table write for authenticated users', !!directUpdate || (await leadRow(nick)).contact_name === 'Nick (ES-325)');
    const { data: bRpc, error: bRpcErr } = await cB.rpc('rename_lead_contact', { p_request: { mode: 'update', lead_id: nick }, p_contact_name: 'Hacked', p_contact_key: 'hacked' });
    check('rename_lead_contact resolves identity from the token (another user\'s lead -> NOT_FOUND)', !bRpcErr && (bRpc as { status?: string }).status === 'NOT_FOUND' && (await leadRow(nick)).contact_name === 'Nick (ES-325)', { bRpc, bRpcErr });

    console.log('\n[W7 — route handler]');
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = SUPABASE_ANON_KEY;
    const { POST } = await import('../src/app/api/leads/[id]/contact-name/route');
    const call = (id: number | string, body: unknown, token: string | null = tokenA) => POST(new NextRequest(`http://local/api/leads/${id}/contact-name`, {
      method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: String(id) }) });
    const v = Number((await leadRow(legacy)).version);
    check('no token -> 401', (await call(legacy, { contact_name: 'A', expected_version: v, mutation_id: uuid() }, null)).status === 401);
    check('bad mutation id -> 400', (await call(legacy, { contact_name: 'A', expected_version: v, mutation_id: 'x' })).status === 400);
    const ok = await call(legacy, { contact_name: 'Anthony Black (Toronto)', expected_version: v, mutation_id: uuid() });
    const okBody = await ok.json();
    check('rename -> 200 with the updated name, source and version', ok.status === 200 && okBody.result === 'RENAMED' && okBody.lead.contact_name === 'Anthony Black (Toronto)' && okBody.lead.contact_name_source === 'USER_EDIT' && okBody.lead.version > v, okBody);
    const blocked = await call(z2.lead_id!, { contact_name: 'Maria Lopez', expected_version: Number((await leadRow(z2.lead_id!)).version), mutation_id: uuid() });
    check('collision -> 409 BLOCKED', blocked.status === 409 && (await blocked.json()).result === 'BLOCKED');
  } finally {
    console.log('\n=== Cleanup ===');
    if (itemIds.length) {
      await admin.from('item_leads').delete().in('inventory_item_id', itemIds);
      await admin.from('inventory_items').delete().in('id', itemIds);
    }
    if (sourceId) await admin.from('lead_import_sources').delete().eq('id', sourceId);
    if (createdBrand) await admin.from('brands').delete().eq('id', createdBrand);
    check('cleanup: fixture leads removed', ((await admin.from('item_leads').select('id').in('inventory_item_id', itemIds.length ? itemIds : [-1])).data ?? []).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
