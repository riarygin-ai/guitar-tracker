/**
 * test-operation-drafts.ts
 *
 * Operation drafts (20261031000000 + src/lib/operations/operationDraftService.ts):
 *   P — pure helpers (planned date, GT type resolution, money)
 *   S — source structure (MCP tool contract, no finalize flag, forms' draft
 *       mode, Operations list, item form, analytics view predicate)
 *   W — local DB through real signed-in RLS clients (two users):
 *       W1 acceptance scenario (#246-like Fender → Ibanez S470 + Boss DS-1 +
 *          DOD FX75-B + C$600, A.P. Ordonez, Marketplace, 2026-10-31):
 *          one draft, outgoing reused, 3 NEW items, nothing else changes;
 *          photos attach; items editable
 *       W2 idempotency + retry (replay, reuse, lost response)
 *       W3 atomicity (third incoming item fails → nothing saved)
 *       W4 ownership / RLS / RPC-only writes
 *       W5 Buy / Sell / Trade variants + draft validation
 *       W6 update terms
 *       W7 finalize (strict validation, existing RPC effects, replay)
 *       W8 discard (cleanup semantics)
 *       W9 analytics isolation
 * Self-cleaning dedicated fixture. Synthetic names only.
 *
 * Usage:  npx tsx scripts/test-operation-drafts.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { createOperationDraft, draftDate, formatCad, resolveItemType, type CreateOperationDraftInput } from '../src/lib/operations/operationDraftService';
import { createOperationWithWinningLead } from '../src/lib/leads/operationLeads';
import { recordLeadInteraction, type AgentEventInput } from '../src/lib/leads/leadWriteService';
import type { DbErrorLike } from '../src/lib/writeRetry';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}

const PASSWORD = 'Operation-Draft-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const root = path.join(__dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const fast = { retry: { sleep: async () => {}, logger: { warn: () => {} } } };

// ── P: pure ──────────────────────────────────────────────────────────────
function pureChecks() {
  console.log('\n[P1 — planned date]');
  check('YYYY-MM-DD kept exactly (no timezone shift), future allowed', draftDate('2026-10-31') === '2026-10-31' && draftDate('2027-01-15') === '2027-01-15');
  check('ISO date-time → Toronto calendar date', draftDate('2026-11-01T02:30:00Z') === '2026-10-31');
  check('empty → null; garbage / impossible date → INVALID', draftDate(undefined) === null && draftDate('') === null && draftDate('soon') === 'INVALID' && draftDate('2026-02-30') === 'INVALID');

  console.log('\n[P2 — GT item type resolution (never guessed)]');
  const l = {
    categories: [{ id: 1, name: 'Guitars' }, { id: 3, name: 'Pedals' }, { id: 2, name: 'Amps' }],
    subtypes: [{ id: 1, name: 'Electric Guitar', category_id: 1 }, { id: 2, name: 'Bass', category_id: 1 }, { id: 7, name: 'Pedal', category_id: 3 }, { id: 10, name: 'Other', category_id: 3 }, { id: 4, name: 'Head', category_id: 2 }],
  };
  check('exact type name (case-insensitive)', resolveItemType(l, 'Guitars', 'electric guitar').subtype_id === 1);
  const ds1 = resolveItemType(l, 'Pedals', 'Distortion pedal');
  check('"Distortion pedal" in Pedals → Pedal, original text kept as a note', ds1.subtype_id === 7 && ds1.note === 'Type: Distortion pedal' && ds1.warning === null, ds1);
  check('singular category accepted ("Pedal" category → Pedals)', resolveItemType(l, 'Pedal', 'Flanger pedal').subtype_id === 7);
  const unknown = resolveItemType(l, 'Guitars', 'Ukulele');
  check('unknown type → left empty + warning listing the types + note keeps it', unknown.subtype_id === null && /Electric Guitar, Bass/.test(unknown.warning ?? '') && /Ukulele/.test(unknown.note ?? ''), unknown);
  check('category only → not guessed', resolveItemType(l, 'Pedals', null).subtype_id === null);
  check('nothing given → nothing, no warning', resolveItemType(l, null, null).warning === null);
  check('"Other" is never picked by partial match', resolveItemType(l, 'Pedals', 'Other thing').subtype_id === null);

  console.log('\n[P3 — money]');
  check('formatCad', formatCad(600) === 'C$600' && formatCad(1234.5) === 'C$1,234.5');
}

// ── S: structure ─────────────────────────────────────────────────────────
function structureChecks() {
  console.log('\n[S1 — MCP tool contract]');
  const route = src('src/app/api/mcp/[[...path]]/route.ts');
  const i = route.indexOf("'create_operation_draft'");
  const block = route.slice(i, route.indexOf('return server;', i));
  check('create_operation_draft registered', i > 0);
  check('no standalone create_inventory_item tool', !/registerTool\(\s*'create_inventory_item'/.test(route));
  check('no finalize / complete input in the schema', !/\b(finalize|complete|completed|status)\s*:\s*z\./.test(block));
  check('requires a UUID mutation_id; no user/owner id', /mutation_id:\s*z\.string\(\)\.uuid\(\)/.test(block) && !/user_id|owner_id|account_id/.test(block));
  check('annotated write, non-destructive, idempotent', /readOnlyHint:\s*false,\s*destructiveHint:\s*false,\s*idempotentHint:\s*true/.test(block));
  check('handler uses the request-scoped client through the shared service', /createOperationDraft\(supabase, input as CreateOperationDraftInput/.test(block));
  check('description: one draft per chosen proposal; never finalizes; ranges go to notes; no Unknown placeholders',
    /ONLY for the proposal the user chose/.test(block) && /cannot finalize/.test(block) && /range/.test(block) && /never "Unknown"/.test(block));
  check('no contact_city / contact_phone input (lead tool owns contact details)', !/contact_city|contact_phone/.test(block.slice(block.indexOf('inputSchema'))));

  console.log('\n[S2 — service never writes completed-operation tables]');
  const svc = src('src/lib/operations/operationDraftService.ts');
  check('service writes only through the create_operation_draft RPC', (svc.match(/\.rpc\(/g) ?? []).length === 1 && /\.rpc\('create_operation_draft'/.test(svc) && !/\.from\([^)]*\)\s*\.(insert|update|upsert|delete)\(/.test(svc));
  check('service uses the shared executeIdempotentMutation', /executeIdempotentMutation\(\s*'create_operation_draft'/.test(svc));
  check('service never references service_role', !/service_role|SERVICE_ROLE/.test(svc));

  console.log('\n[S3 — UI]');
  for (const f of ['TradeOperationForm', 'SellOperationForm', 'BuyOperationForm']) {
    const s = src(`src/components/${f}.tsx`);
    check(`${f}: draft mode finalizes through finalizeDraft / the atomic lead path`, /draftId\?: number/.test(s) && /finalizeDraft\(draftId!/.test(s));
    check(`${f}: future-date rule still applies when finalizing`, /Date cannot be in the future/.test(s));
  }
  check('Operations list renders the separate drafts block', /<OperationDraftsSection \/>/.test(src('src/app/operations/page.tsx')));
  check('draft detail + finalize pages exist', fs.existsSync(path.join(root, 'src/app/operations/drafts/[id]/page.tsx')) && fs.existsSync(path.join(root, 'src/app/operations/drafts/[id]/finalize/page.tsx')));
  const inv = src('src/components/InventoryForm.tsx');
  check('item form: open-draft incoming item may be saved incomplete (only then)', /draftCapture = !!itemId && openDraft != null && existingItem\?\.status === 'new'/.test(inv) && /!condition && !draftCapture/.test(inv));
  const badge = src('src/components/OperationDraftBadge.tsx');
  check('draft badge says "Draft <type>" and is dashed amber', /Draft \{DRAFT_TYPE_LABEL\[type\]\}/.test(badge) && /border-dashed/.test(badge));

  console.log('\n[S4 — migration]');
  const mig = src('supabase/migrations/20261031000000_operation_drafts.sql');
  check('no new item status (status values unchanged)', !/status\s*=\s*'draft'/i.test(mig.replace(/il\.status|od\.status|d\.status/g, '')) && /'new'/.test(mig));
  check('analytics_item_lifecycle excludes open-draft-only new items', /WHERE NOT \(\s*i\.status = 'new'\s*AND EXISTS \(/.test(mig));
  check('finalize calls the unchanged operation RPCs', /public\.create_trade_operation\(/.test(mig) && /public\.create_sell_operation\(/.test(mig) && /public\.create_buy_operation\(/.test(mig) && /public\.create_operation_with_winning_lead\(/.test(mig));
  check('no deals / cash_flow / item_listings writes outside finalize', !/INSERT INTO public\.(deals|deal_items|cash_flow)|UPDATE public\.item_listings|UPDATE public\.item_leads/.test(mig));
}

// ── DB helpers ───────────────────────────────────────────────────────────
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
async function signIn(email: string): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return c;
}

const FETCH_RESET: DbErrorLike = { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: read ECONNRESET (ECONNRESET)', hint: '', code: '' };
/** The first call to `target` commits but its response is "lost" (network reset); later calls pass through. */
function lostOnce(client: SupabaseClient, target: string, calls: unknown[]): SupabaseClient {
  let lost = false;
  return new Proxy(client, {
    get(t, prop) {
      if (prop === 'rpc') {
        return async (fn: string, args: unknown) => {
          if (fn !== target) return t.rpc(fn, args as never);
          calls.push(JSON.parse(JSON.stringify(args)));
          if (!lost) { lost = true; await t.rpc(fn, args as never); return { data: null, error: FETCH_RESET, status: 0 }; }
          return t.rpc(fn, args as never);
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const cashOffer = (at: string, n: number): AgentEventInput => ({ type: 'OFFER', direction: 'INBOUND', occurred_at: at, summary: `Offered C$${n}`, payload: { offer: { cash_terms: 'AMOUNT', cash_amount: n, items: [] } } });

async function main() {
  pureChecks();
  structureChecks();

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const emailA = 'operation-draft-fixture-a@example.test';
  const emailB = 'operation-draft-fixture-b@example.test';
  const authA = await ensureAuthUser(admin, emailA);
  const userA = await resolveAppUserId(admin, authA);
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));
  const cA = await signIn(emailA);
  const cB = await signIn(emailB);

  // Lookups (local seed) — the fixture uses real GT names.
  const { data: chans } = await admin.from('deal_channels').select('id, name');
  const chanId = (n: string) => (chans ?? []).find((c) => c.name === n)?.id as number;
  const MP = chanId('Marketplace'), KJ = chanId('Kijiji'), RV = chanId('Reverb');
  const { data: subs } = await admin.from('item_subtypes').select('id, name, category_id');
  const subId = (n: string) => (subs ?? []).find((s) => s.name === n)?.id as number;
  const { data: purposes } = await admin.from('item_purposes').select('id, name');
  const businessId = (purposes ?? []).find((p) => p.name === 'Business')?.id as number;
  const brandsBefore = new Set(((await admin.from('brands').select('name')).data ?? []).map((b) => (b.name as string).toLowerCase()));
  const fixtureBrand = async (name: string) => {
    const { data } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
    if (data) return data.id as number;
    return (await admin.from('brands').insert({ name }).select('id').single()).data!.id as number;
  };
  const fenderId = await fixtureBrand('Fender');

  const itemIds: number[] = [];
  const draftIds: number[] = [];
  const dealIds: number[] = [];
  const leadIds: number[] = [];
  const storagePaths: string[] = [];

  const item = async (userId: number, model: string, status = 'listed', extra: Record<string, unknown> = {}) => {
    const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: fenderId, model, status, color: 'Surf Green', item_subtype_id: subId('Electric Guitar'), condition: 'Mint', purpose_id: businessId, estimated_sold_value: 800, ...extra }).select('id').single();
    if (error) throw error;
    itemIds.push(data.id as number);
    return data.id as number;
  };
  const listing = async (itemId: number, channel: number, price: number | null, trade = false) => {
    const { error } = await admin.from('item_listings').insert({ inventory_item_id: itemId, deal_channel_id: channel, status: 'active', listed_at: '2026-10-01', asking_price: price, trade_enabled: trade, user_id: userA });
    if (error) throw error;
  };
  const newLead = async (itemId: number, name: string, channel: 'Marketplace' | 'Kijiji', events: AgentEventInput[]) => {
    const r = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: itemId, channel, contact_name: name }, events }, { clientLabel: 'test-suite' });
    if (r.result !== 'APPLIED_CREATE') throw new Error(`lead fixture ${name}: ${JSON.stringify(r)}`);
    leadIds.push(r.lead_id!);
    return r.lead_id!;
  };
  const draft = async (client: SupabaseClient, input: Omit<CreateOperationDraftInput, 'mutation_id'> & { mutation_id?: string }, retry = fast.retry) => {
    const r = await createOperationDraft(client, { mutation_id: input.mutation_id ?? uuid(), ...input } as CreateOperationDraftInput, { source: 'MCP', clientLabel: 'test-suite', appOrigin: 'http://localhost:3000', retry });
    if (r.draft_id && !draftIds.includes(r.draft_id)) draftIds.push(r.draft_id);
    for (const id of r.incoming_item_ids) if (!itemIds.includes(id)) itemIds.push(id);
    return r;
  };
  const rpc = async (client: SupabaseClient, fn: string, args: Record<string, unknown>) => {
    const r = await client.rpc(fn, args);
    const id = (r.data as { deal_id?: number } | null)?.deal_id;
    if (id && !dealIds.includes(id)) dealIds.push(id);
    return r;
  };
  const itemRow = async (id: number) => (await admin.from('inventory_items').select('*').eq('id', id).single()).data as Record<string, unknown>;
  const listingsOf = async (id: number) => ((await admin.from('item_listings').select('id, status, ended_at').eq('inventory_item_id', id).order('id')).data ?? []) as Record<string, unknown>[];
  const leadRow = async (id: number) => (await admin.from('item_leads').select('id, status, outcome_reason, deal_id, version').eq('id', id).single()).data as Record<string, unknown>;
  const leadEventCount = async (id: number) => ((await admin.from('lead_events').select('id').eq('item_lead_id', id)).data ?? []).length;
  const count = async (table: string, col: string, val: unknown) => ((await admin.from(table).select('id').eq(col, val as never)).data ?? []).length;
  const state = async () => ({
    deals: await count('deals', 'user_id', userA),
    dealItems: await count('deal_items', 'user_id', userA),
    cash: await count('cash_flow', 'user_id', userA),
    lifecycle: ((await cA.from('analytics_item_lifecycle').select('item_id')).data ?? []).length,
    lifecycleV2: ((await cA.from('analytics_item_lifecycle_v2').select('item_id')).data ?? []).length,
  });

  try {
    // ── W1: acceptance scenario ──────────────────────────────────────────
    console.log('\n[W1 — acceptance: Fender out → Ibanez S470 + Boss DS-1 + DOD FX75-B + C$600 in]');
    const fender = await item(userA, 'Stratocaster Partscaster — Reverse Headstock (OD)');
    await listing(fender, MP, 1100, true);
    await listing(fender, KJ, null, true);
    await listing(fender, RV, 1199);
    const ordonez = await newLead(fender, 'A.P. Ordonez', 'Marketplace', [cashOffer('2026-10-28T12:00:00-04:00', 600)]);
    const nick = await newLead(fender, 'Nick Lalonde', 'Marketplace', [cashOffer('2026-10-27T12:00:00-04:00', 500)]);
    const scott = await newLead(fender, 'Scott', 'Kijiji', [cashOffer('2026-10-26T12:00:00-04:00', 450)]);
    const fendersBefore = ((await admin.from('inventory_items').select('id').eq('user_id', userA).eq('brand_id', fenderId)).data ?? []).length;
    const listingsBefore = await listingsOf(fender);
    const ordBefore = await leadRow(ordonez);
    const ordEventsBefore = await leadEventCount(ordonez);
    const before = await state();

    const acceptance: Omit<CreateOperationDraftInput, 'mutation_id'> = {
      operation_type: 'TRADE', occurred_on: '2026-10-31', channel: 'Marketplace', contact_name: 'A.P. Ordonez',
      outgoing_item_ids: [fender],
      incoming_items: [
        { brand: 'Ibanez', model: 'S470', color: 'Blue', category: 'Guitars', type: 'Electric Guitar', description: 'HSH pickup configuration, locking tremolo. Case: gigbag.', notes: 'Seller says it was recently set up, conditioned and restrung; tremolo works correctly. Working resale estimate ~C$300–400 (planning only).' },
        { brand: 'Boss', model: 'DS-1 Distortion', category: 'Pedals', type: 'Distortion pedal', notes: 'Working resale estimate ~C$40–50 (planning only).' },
        { brand: 'DOD', model: 'FX75-B Stereo Flanger', category: 'Pedals', type: 'Flanger pedal', notes: 'Working resale estimate ~C$70–90 (planning only).' },
      ],
      cash_received: 600,
      notes: 'Meeting: Aurora, around 1:00 PM. The other party said they would confirm the meeting — NOT confirmed completed.',
    };
    const mutation = uuid();
    const r1 = await draft(cA, { ...acceptance, mutation_id: mutation });
    check('CREATED, not a replay', r1.result === 'CREATED' && !r1.replayed, r1);
    check('headline "🟢 Draft Trade created"; lines show OUT / IN / cash / DRAFT', r1.headline === '🟢 Draft Trade created' && r1.lines.includes('OUT') && r1.lines.includes('IN') && r1.lines.includes('Cash received: C$600') && r1.lines.some((l) => l.startsWith('Status: DRAFT')), r1.lines);
    check('machine-readable ids returned (draft, 1 outgoing, 3 incoming) + GT url', r1.draft_id! > 0 && JSON.stringify(r1.outgoing_item_ids) === JSON.stringify([fender]) && r1.incoming_item_ids.length === 3 && r1.url === `http://localhost:3000/operations/drafts/${r1.draft_id}`, r1);
    const { data: drafts } = await admin.from('operation_drafts').select('*').eq('user_id', userA).eq('status', 'OPEN');
    check('1. exactly one draft operation exists', (drafts ?? []).length === 1, drafts);
    const d1 = (drafts ?? [])[0] as Record<string, unknown>;
    check('draft holds type, proposed (future-capable) date, channel, contact, cash, notes', d1.operation_type === 'TRADE' && d1.proposed_date === '2026-10-31' && d1.deal_channel_id === MP && d1.contact_name === 'A.P. Ordonez' && Number(d1.cash_received) === 600 && Number(d1.cash_paid) === 0 && /Aurora/.test(d1.notes as string) && d1.deal_id === null && d1.source === 'MCP', d1);
    check('lead A.P. Ordonez attached (unique exact match), not Nick / Scott', d1.lead_id === ordonez && r1.lead_resolution?.kind === 'MATCHED', r1.lead_resolution);
    check('2. outgoing item reused', r1.outgoing_item_ids[0] === fender);
    check('3. no duplicate Fender created', ((await admin.from('inventory_items').select('id').eq('user_id', userA).eq('brand_id', fenderId)).data ?? []).length === fendersBefore);
    const [ib, ds, dod] = await Promise.all(r1.incoming_item_ids.map(itemRow));
    check('4. exactly 3 incoming items created', [ib, ds, dod].every(Boolean) && new Set(r1.incoming_item_ids).size === 3);
    check('5. incoming items have status NEW', [ib, ds, dod].every((x) => x.status === 'new'));
    check('unknowns stay empty — year, condition, purpose, serial, estimated value (no placeholders)', [ib, ds, dod].every((x) => x.year === null && x.condition === null && x.purpose_id === null && x.serial_number === null && x.estimated_sold_value === null));
    check('Ibanez: Electric Guitar, Blue, description + notes in item notes', ib.item_subtype_id === subId('Electric Guitar') && ib.color === 'Blue' && /HSH pickup/.test(ib.notes as string) && /tremolo works/.test(ib.notes as string) && /300–400/.test(ib.notes as string));
    check('DS-1 / FX75-B: type Pedal, original type text kept in notes', ds.item_subtype_id === subId('Pedal') && dod.item_subtype_id === subId('Pedal') && /Type: Distortion pedal/.test(ds.notes as string) && /Type: Flanger pedal/.test(dod.notes as string));
    const dodBrand = (await admin.from('brands').select('name').eq('id', dod.brand_id as number).single()).data;
    check('DOD brand resolved / created (same as the inventory form)', dodBrand?.name?.toLowerCase() === 'dod');
    check('6. outgoing status unchanged (listed)', (await itemRow(fender)).status === 'listed');
    check('7. active listings unchanged', JSON.stringify(await listingsOf(fender)) === JSON.stringify(listingsBefore) && listingsBefore.every((l) => l.status === 'active'));
    const after = await state();
    check('8. cash unchanged (no cash_flow row)', after.cash === before.cash);
    check('9a. no deal / deal_items row (operation analytics, realized profit, trade chain untouched)', after.deals === before.deals && after.dealItems === before.dealItems);
    check('9b. analytics lifecycle (v1 + v2) unchanged — draft-only NEW items excluded', after.lifecycle === before.lifecycle && after.lifecycleV2 === before.lifecycleV2, { before, after });
    const ordAfter = await leadRow(ordonez);
    check('10. lead not completed / unchanged (status, version, events)', ordAfter.status === 'OPEN' && ordAfter.deal_id === null && ordAfter.version === ordBefore.version && (await leadEventCount(ordonez)) === ordEventsBefore, ordAfter);
    check('other proposals untouched — Nick / Scott leads still OPEN, no other draft', (await leadRow(nick)).status === 'OPEN' && (await leadRow(scott)).status === 'OPEN');

    // 11. photos
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const photoPath = `${authA}/${r1.incoming_item_ids[0]}/${Date.now()}-draft.png`;
    const up = await cA.storage.from('inventory-photos').upload(photoPath, png, { contentType: 'image/png', upsert: false });
    if (!up.error) storagePaths.push(photoPath);
    const { error: photoErr } = await cA.from('inventory_item_photos').insert({ inventory_item_id: r1.incoming_item_ids[0], storage_path: photoPath, file_name: 'draft.png', content_type: 'image/png', file_size: png.length, is_main: true, sort_order: 0 });
    check('11. incoming NEW item receives a photo through the normal path (storage + inventory_item_photos, user RLS)', !up.error && !photoErr, up.error ?? photoErr);
    const { error: editErr } = await cA.from('inventory_items').update({ year: 2004 }).eq('id', r1.incoming_item_ids[0]);
    check('13. incoming item editable by the user (normal RLS update)', !editErr && (await itemRow(r1.incoming_item_ids[0])).year === 2004, editErr);
    const { data: seen } = await cA.from('operation_drafts').select('id, operation_draft_items(item_id, direction, created_by_draft)').eq('id', r1.draft_id!).single();
    check('12. draft readable by its owner (GT UI query shape)', (seen?.operation_draft_items as unknown[] | undefined)?.length === 4, seen);

    // ── W2: idempotency + retry ──────────────────────────────────────────
    console.log('\n[W2 — idempotency / retry]');
    const itemsBeforeReplay = ((await admin.from('inventory_items').select('id').eq('user_id', userA)).data ?? []).length;
    const r2 = await draft(cA, { ...acceptance, mutation_id: mutation });
    check('same mutation_id + same request → REPLAY, same ids', r2.result === 'CREATED' && r2.replayed && r2.draft_id === r1.draft_id && JSON.stringify(r2.incoming_item_ids) === JSON.stringify(r1.incoming_item_ids), r2);
    check('replay headline says already created', /already created/.test(r2.headline));
    check('no duplicate draft, no duplicate incoming items', ((await admin.from('operation_drafts').select('id').eq('user_id', userA)).data ?? []).length === 1 && ((await admin.from('inventory_items').select('id').eq('user_id', userA)).data ?? []).length === itemsBeforeReplay);
    const reused = await draft(cA, { ...acceptance, cash_received: 650, mutation_id: mutation });
    check('same mutation_id + different request → REJECTED MUTATION_ID_REUSED, nothing written', reused.result === 'REJECTED' && reused.reason === 'MUTATION_ID_REUSED', reused);
    const calls: unknown[] = [];
    const lostKey = uuid();
    const lost = await draft(lostOnce(cA, 'create_operation_draft', calls), { operation_type: 'BUY', occurred_on: '2026-10-30', channel: 'Kijiji', incoming_items: [{ brand: 'Ibanez', model: 'Lost Response RG (OD)' }], cash_paid: 250, mutation_id: lostKey });
    check('lost response after commit → retried with the SAME request (same mutation_id) → this call\'s own draft, not "replayed"', lost.result === 'CREATED' && !lost.replayed && calls.length === 2 && JSON.stringify(calls[0]) === JSON.stringify(calls[1]) && (calls[0] as { p_request: { mutation_id: string } }).p_request.mutation_id === lostKey, { lost, n: calls.length });
    check('lost response: exactly one draft + one item for that mutation', ((await admin.from('operation_drafts').select('id').eq('mutation_id', lostKey)).data ?? []).length === 1 && ((await admin.from('inventory_items').select('id').eq('model', 'Lost Response RG (OD)')).data ?? []).length === 1);

    // ── W3: atomicity ─────────────────────────────────────────────────────
    console.log('\n[W3 — atomicity]');
    const atomicKey = uuid();
    const { error: atomErr } = await cA.rpc('create_operation_draft', { p_request: {
      mutation_id: atomicKey, request_hash: 'x', source: 'MCP', operation_type: 'TRADE', outgoing_item_ids: [fender], cash_received: 600,
      incoming_items: [{ brand_name: 'Ibanez', model: 'Atomic One (OD)' }, { brand_name: 'Boss', model: 'Atomic Two (OD)' }, { brand_name: 'DOD', model: 'Atomic Three (OD)', condition: 'Bogus' }],
    } });
    check('failure on the third incoming item → error', !!atomErr && /condition/.test(atomErr.message), atomErr);
    check('…and nothing persisted: no draft, no incoming items, no links', ((await admin.from('operation_drafts').select('id').eq('mutation_id', atomicKey)).data ?? []).length === 0 && ((await admin.from('inventory_items').select('id').like('model', 'Atomic % (OD)')).data ?? []).length === 0);

    // ── W4: ownership / RLS ──────────────────────────────────────────────
    console.log('\n[W4 — ownership / RLS / RPC-only writes]');
    const bWrong = await draft(cB, { operation_type: 'TRADE', outgoing_item_ids: [fender], incoming_items: [{ brand: 'Ibanez', model: 'B Attempt (OD)' }] });
    check("another user's outgoing item → REJECTED ITEM_NOT_FOUND, nothing created", bWrong.result === 'REJECTED' && bWrong.reason === 'ITEM_NOT_FOUND' && ((await admin.from('inventory_items').select('id').eq('model', 'B Attempt (OD)')).data ?? []).length === 0, bWrong);
    const bItem = await item(userB, 'B own item (OD)', 'owned');
    const bLead = await draft(cB, { operation_type: 'SELL', outgoing_item_ids: [bItem], cash_received: 100, lead_id: ordonez });
    check("another user's lead → REJECTED LEAD_NOT_FOUND", bLead.result === 'REJECTED' && bLead.reason === 'LEAD_NOT_FOUND', bLead);
    check("B cannot read A's draft or its items", ((await cB.from('operation_drafts').select('id').eq('id', r1.draft_id!)).data ?? []).length === 0 && ((await cB.from('operation_draft_items').select('id').eq('draft_id', r1.draft_id!)).data ?? []).length === 0);
    for (const [fn, args] of [
      ['update_operation_draft', { p_draft_id: r1.draft_id, p_request: { cash_received: 1 } }],
      ['discard_operation_draft', { p_draft_id: r1.draft_id, p_remove_new_items: true }],
      ['finalize_operation_draft', { p_draft_id: r1.draft_id, p_kind: 'trade', p_operation: {} }],
    ] as const) {
      const { error } = await cB.rpc(fn, args);
      check(`B ${fn} on A's draft → DRAFT_NOT_FOUND`, !!error && /DRAFT_NOT_FOUND/.test(error.message), error);
    }
    check("A's draft unchanged by B's attempts", Number((await admin.from('operation_drafts').select('cash_received, status').eq('id', r1.draft_id!).single()).data?.cash_received) === 600);
    const { error: directIns } = await cA.from('operation_drafts').insert({ operation_type: 'TRADE', source: 'UI', mutation_id: uuid() });
    check('direct client INSERT refused (RPC-only)', !!directIns && /OPERATION_DRAFT_RPC_ONLY/.test(directIns.message), directIns);
    const { error: directUpd } = await cA.from('operation_drafts').update({ cash_received: 1 }).eq('id', r1.draft_id!);
    check('direct client UPDATE refused (RPC-only)', !!directUpd && /OPERATION_DRAFT_RPC_ONLY/.test(directUpd.message), directUpd);
    const { error: directDel } = await cA.from('operation_drafts').delete().eq('id', r1.draft_id!);
    check('direct client DELETE refused / no-op', !!directDel || ((await admin.from('operation_drafts').select('id').eq('id', r1.draft_id!)).data ?? []).length === 1);
    const { error: crossLink } = await admin.from('operation_draft_items').insert({ draft_id: r1.draft_id, user_id: userA, item_id: bItem, direction: 'out' });
    check('cross-user item link impossible even bypassing RLS (guard / owner FK)', !!crossLink, crossLink);

    // ── W5: variants + draft validation ──────────────────────────────────
    console.log('\n[W5 — Buy / Sell / Trade variants + draft validation]');
    const buy = await draft(cA, { operation_type: 'BUY', occurred_on: '2026-10-29', channel: 'Kijiji', contact_name: 'Seller Sam', incoming_items: [{ brand: 'Fender', model: 'Draft Buy Tele (OD)', year: 2015, condition: 'Excellent', purpose: 'business', estimated_sold_value: 900, tags: ['NoSuchTag-OD'] }], cash_paid: 600 });
    const buyItem = buy.incoming_item_ids[0] ? await itemRow(buy.incoming_item_ids[0]) : null;
    check('Buy draft: cash paid, 1 NEW item with the known facts (purpose resolved case-insensitively)', buy.result === 'CREATED' && buyItem?.status === 'new' && buyItem?.year === 2015 && buyItem?.condition === 'Excellent' && buyItem?.purpose_id === businessId && Number(buyItem?.estimated_sold_value) === 900, { buy, buyItem });
    check('unknown tag → warning, not created', buy.warnings.some((w) => /NoSuchTag-OD/.test(w)));
    const sellItem = await item(userA, 'Draft Sell Jazzmaster (OD)', 'owned');
    const sell = await draft(cA, { operation_type: 'SELL', outgoing_item_ids: [sellItem], cash_received: 1200, channel: 'Facebook Marketplace' });
    check('Sell draft: outgoing by id + cash received; "Facebook Marketplace" alias → Marketplace', sell.result === 'CREATED' && sell.incoming_item_ids.length === 0 && (await admin.from('operation_drafts').select('deal_channel_id').eq('id', sell.draft_id!).single()).data?.deal_channel_id === MP, sell);
    const oneOut = await item(userA, 'One-for-one Out (OD)', 'owned');
    const t11 = await draft(cA, { operation_type: 'TRADE', outgoing_item_ids: [oneOut], incoming_items: [{ brand: 'Boss', model: 'RC-30 (OD)' }], cash_paid: 50 });
    check('Trade 1 out / 1 in with cash paid', t11.result === 'CREATED' && t11.incoming_item_ids.length === 1 && t11.lines.includes('Cash paid: C$50'), t11);
    check('Trade with an outgoing item already in another open draft → allowed, warned', (await draft(cA, { operation_type: 'TRADE', outgoing_item_ids: [oneOut], incoming_items: [{ brand: 'Boss', model: 'Alt Proposal (OD)' }] })).warnings.some((w) => /also the outgoing item of open draft/.test(w)));
    const rej = async (label: string, input: Omit<CreateOperationDraftInput, 'mutation_id'>, reason: string) => {
      const r = await draft(cA, input);
      check(label, r.result === 'REJECTED' && r.reason === reason, r);
    };
    await rej('Buy with an outgoing item → REJECTED', { operation_type: 'BUY', outgoing_item_ids: [oneOut], incoming_items: [{ brand: 'Boss', model: 'X' }] }, 'VALIDATION_ERROR');
    await rej('Sell with cash paid → REJECTED', { operation_type: 'SELL', outgoing_item_ids: [oneOut], cash_paid: 5 }, 'VALIDATION_ERROR');
    await rej('incoming item without model → REJECTED', { operation_type: 'BUY', incoming_items: [{ brand: 'Boss', model: '' }] }, 'VALIDATION_ERROR');
    await rej('unknown channel → REJECTED with the valid list', { operation_type: 'BUY', channel: 'Craigslist', incoming_items: [{ brand: 'Boss', model: 'X' }] }, 'INVALID_CHANNEL');
    await rej('invalid date → REJECTED', { operation_type: 'BUY', occurred_on: '2026-13-45', incoming_items: [{ brand: 'Boss', model: 'X' }] }, 'VALIDATION_ERROR');
    await rej('negative cash → REJECTED', { operation_type: 'TRADE', outgoing_item_ids: [oneOut], cash_received: -5 }, 'VALIDATION_ERROR');
    const soldItem = await item(userA, 'Already Sold (OD)', 'sold');
    await rej('outgoing item already sold → REJECTED ITEM_NOT_AVAILABLE', { operation_type: 'SELL', outgoing_item_ids: [soldItem], cash_received: 10 }, 'ITEM_NOT_AVAILABLE');
    await rej('lead on a non-outgoing item → REJECTED', { operation_type: 'SELL', outgoing_item_ids: [oneOut], cash_received: 10, lead_id: ordonez }, 'LEAD_NOT_ON_OUTGOING_ITEM');
    const twin = await item(userA, 'Twin Leads (OD)', 'listed');
    const twin2 = await item(userA, 'Twin Leads Two (OD)', 'listed');
    await newLead(twin, 'Same Name', 'Marketplace', [cashOffer('2026-10-20T12:00:00-04:00', 300)]);
    await newLead(twin2, 'Same Name', 'Marketplace', [cashOffer('2026-10-21T12:00:00-04:00', 310)]);
    const amb = await draft(cA, { operation_type: 'SELL', outgoing_item_ids: [twin, twin2], cash_received: 300, contact_name: 'Same Name' });
    check('two open leads with that name → no lead linked, warning', amb.result === 'CREATED' && amb.lead_id === null && amb.lead_resolution?.kind === 'AMBIGUOUS' && amb.warnings.some((w) => /Several open leads/.test(w)), amb);

    // ── W6: update terms ─────────────────────────────────────────────────
    console.log('\n[W6 — update planning terms]');
    const { error: upErr } = await cA.rpc('update_operation_draft', { p_draft_id: t11.draft_id, p_request: { proposed_date: '2026-11-05', deal_channel_id: KJ, contact_name: 'Pat', lead_id: null, cash_paid: 75, cash_received: 0, notes: 'Meet Saturday' } });
    const t11Row = (await admin.from('operation_drafts').select('*').eq('id', t11.draft_id!).single()).data as Record<string, unknown>;
    check('terms replaced (date may be future, cash, channel, notes)', !upErr && t11Row.proposed_date === '2026-11-05' && Number(t11Row.cash_paid) === 75 && t11Row.deal_channel_id === KJ && t11Row.notes === 'Meet Saturday', upErr ?? t11Row);
    const { error: upBuyErr } = await cA.rpc('update_operation_draft', { p_draft_id: buy.draft_id, p_request: { cash_paid: 600, cash_received: 5 } });
    check('Buy draft cannot get cash received', !!upBuyErr && /no cash received/.test(upBuyErr.message), upBuyErr);

    // ── W7: finalize ─────────────────────────────────────────────────────
    console.log('\n[W7 — finalize through the existing operation RPCs]');
    const op = {
      p_deal_date: '2026-10-31', p_channel_id: MP, p_notes: 'Trade with A.P. Ordonez', p_cash_paid: 0, p_cash_received: 600,
      p_outgoing_items: [{ item_id: fender, total_value: 1000 }],
      p_incoming_items: [{ item_id: r1.incoming_item_ids[0], total_value: 300 }, { item_id: r1.incoming_item_ids[1], total_value: 40 }, { item_id: r1.incoming_item_ids[2], total_value: 60 }],
      p_cf_transaction_date: null, p_cf_description: 'Trade: Fender → Ibanez S470',
    };
    const { error: incompleteErr } = await rpc(cA, 'finalize_operation_draft', { p_draft_id: r1.draft_id, p_kind: 'trade', p_operation: op });
    check('incomplete incoming items → DRAFT_ITEM_INCOMPLETE (finalization validation stays strict)', !!incompleteErr && /DRAFT_ITEM_INCOMPLETE/.test(incompleteErr.message) && /condition/.test(incompleteErr.message), incompleteErr);
    check('…nothing happened: draft OPEN, item listed, no cash, no deal', (await admin.from('operation_drafts').select('status').eq('id', r1.draft_id!).single()).data?.status === 'OPEN' && (await itemRow(fender)).status === 'listed' && (await state()).cash === before.cash && (await state()).deals === before.deals);
    const { error: kindErr } = await rpc(cA, 'finalize_operation_draft', { p_draft_id: r1.draft_id, p_kind: 'sale', p_operation: op });
    check('kind must match the draft', !!kindErr && /not sale/.test(kindErr.message), kindErr);
    for (const [id, esv] of [[r1.incoming_item_ids[0], 380], [r1.incoming_item_ids[1], 45], [r1.incoming_item_ids[2], 80]] as const) {
      await cA.from('inventory_items').update({ condition: 'Very Good', purpose_id: businessId, estimated_sold_value: esv }).eq('id', id);
    }
    const { error: unbalanced } = await rpc(cA, 'finalize_operation_draft', { p_draft_id: r1.draft_id, p_kind: 'trade', p_operation: { ...op, p_cash_received: 500 } });
    check('existing trade rule still authoritative (must balance) → error, draft still OPEN', !!unbalanced && /does not balance/.test(unbalanced.message) && (await admin.from('operation_drafts').select('status').eq('id', r1.draft_id!).single()).data?.status === 'OPEN', unbalanced);

    const fin = await createOperationWithWinningLead(cA, userA, { kind: 'trade', operation: op, leadId: ordonez, operationKey: uuid(), draftId: r1.draft_id! }, undefined, fast.retry);
    if (fin.ok) dealIds.push(fin.deal_id);
    check('14. finalize (winning lead A.P. Ordonez) → OK', fin.ok, fin);
    const dealId = fin.ok ? fin.deal_id : -1;
    const finDraft = (await admin.from('operation_drafts').select('status, deal_id, finalized_at').eq('id', r1.draft_id!).single()).data as Record<string, unknown>;
    check('draft FINALIZED and linked to the deal', finDraft.status === 'FINALIZED' && finDraft.deal_id === dealId && finDraft.finalized_at != null, finDraft);
    const deal = (await admin.from('deals').select('*').eq('id', dealId).single()).data as Record<string, unknown>;
    check('15a. a normal trade deal (type, date, channel, cash received)', deal?.deal_type === 'trade' && deal.deal_date === '2026-10-31' && deal.deal_channel_id === MP && Number(deal.cash_received) === 600);
    check('15b. outgoing → traded with sold_date; incoming → owned', (await itemRow(fender)).status === 'traded' && (await itemRow(fender)).sold_date === '2026-10-31' && (await Promise.all(r1.incoming_item_ids.map(itemRow))).every((x) => x.status === 'owned'));
    check('15c. listings ended normally', (await listingsOf(fender)).every((l) => l.status === 'ended' && l.ended_at === '2026-10-31'), await listingsOf(fender));
    const cfs = ((await admin.from('cash_flow').select('cash_in, cash_out').eq('deal_id', dealId)).data ?? []) as Record<string, unknown>[];
    check('15d. cash posted once (C$600 in)', cfs.length === 1 && Number(cfs[0].cash_in) === 600 && Number(cfs[0].cash_out) === 0, cfs);
    const ordFinal = await leadRow(ordonez);
    check('15e. lead completed only now, linked to the deal; other open leads closed as ITEM_UNAVAILABLE', ordFinal.status === 'COMPLETED' && ordFinal.deal_id === dealId && (await leadRow(nick)).outcome_reason === 'ITEM_UNAVAILABLE' && (await leadRow(scott)).status === 'CLOSED', { ordFinal, nick: await leadRow(nick) });
    check('Value In = allocated values (not resale estimates)', JSON.stringify(((await admin.from('deal_items').select('item_id, total_value').eq('deal_id', dealId).eq('direction', 'in').order('item_id')).data ?? []).map((x) => Number(x.total_value))) === JSON.stringify([300, 40, 60]));
    const afterFinal = await state();
    const { data: lcAcquired } = await cA.from('analytics_item_lifecycle').select('item_id, acquisition_deal_id, acquisition_value').in('item_id', r1.incoming_item_ids);
    check('analytics now include the 3 acquired items, with the trade as their acquisition and the allocated values', (lcAcquired ?? []).length === 3 && (lcAcquired ?? []).every((x) => x.acquisition_deal_id === dealId) && afterFinal.deals === before.deals + 1, lcAcquired);
    const again = await rpc(cA, 'finalize_operation_draft', { p_draft_id: r1.draft_id, p_kind: 'trade', p_operation: op });
    check('re-finalize → REPLAY with the same deal; no second deal / cash row', !again.error && (again.data as { status: string; deal_id: number }).status === 'REPLAY' && (again.data as { deal_id: number }).deal_id === dealId && (await state()).deals === afterFinal.deals && (await state()).cash === afterFinal.cash, again);
    const { error: updFinal } = await cA.rpc('update_operation_draft', { p_draft_id: r1.draft_id, p_request: { cash_received: 1 } });
    check('finalized draft is terminal (no edit)', !!updFinal && /DRAFT_NOT_OPEN/.test(updFinal.message));

    // Sell + Buy finalize without a lead.
    const sellFin = await rpc(cA, 'finalize_operation_draft', { p_draft_id: sell.draft_id, p_kind: 'sale', p_operation: { p_deal_date: '2026-10-31', p_channel_id: MP, p_items: [{ item_id: sellItem, total_value: 1200 }], p_notes: null, p_cf_description: 'Sale: draft' } });
    check('Sell draft finalize → sold, cash in once, draft FINALIZED', !sellFin.error && (await itemRow(sellItem)).status === 'sold' && (await admin.from('operation_drafts').select('status').eq('id', sell.draft_id!).single()).data?.status === 'FINALIZED', sellFin.error);
    await cA.from('inventory_items').update({ item_subtype_id: subId('Electric Guitar') }).eq('id', buy.incoming_item_ids[0]);
    const buyFin = await rpc(cA, 'finalize_operation_draft', { p_draft_id: buy.draft_id, p_kind: 'purchase', p_operation: { p_deal_date: '2026-10-30', p_channel_id: KJ, p_incoming_items: [{ item_id: buy.incoming_item_ids[0], total_value: 600 }], p_notes: null, p_cf_description: 'Purchase: draft' } });
    const buyCf = buyFin.data ? ((await admin.from('cash_flow').select('cash_out').eq('deal_id', (buyFin.data as { deal_id: number }).deal_id)).data ?? []) : [];
    check('Buy draft finalize → owned, cash out 600 once', !buyFin.error && (await itemRow(buy.incoming_item_ids[0])).status === 'owned' && buyCf.length === 1 && Number(buyCf[0].cash_out) === 600, buyFin.error ?? buyCf);
    // Outgoing item gone meanwhile.
    const goneOut = await item(userA, 'Sold Meanwhile (OD)', 'owned');
    const goneDraft = await draft(cA, { operation_type: 'SELL', outgoing_item_ids: [goneOut], cash_received: 100 });
    await admin.from('inventory_items').update({ status: 'sold' }).eq('id', goneOut);
    const { error: goneErr } = await rpc(cA, 'finalize_operation_draft', { p_draft_id: goneDraft.draft_id, p_kind: 'sale', p_operation: { p_deal_date: '2026-10-31', p_channel_id: MP, p_items: [{ item_id: goneOut, total_value: 100 }], p_notes: null, p_cf_description: null } });
    check('finalize refuses an outgoing item sold since the draft (ITEM_NOT_AVAILABLE)', !!goneErr && /ITEM_NOT_AVAILABLE/.test(goneErr.message), goneErr);
    const { error: foreignErr } = await rpc(cA, 'finalize_operation_draft', { p_draft_id: goneDraft.draft_id, p_kind: 'sale', p_operation: { p_deal_date: '2026-10-31', p_channel_id: MP, p_items: [{ item_id: bItem, total_value: 100 }], p_notes: null, p_cf_description: null } });
    check("finalize refuses another user's item (ITEM_NOT_FOUND)", !!foreignErr && /ITEM_NOT_FOUND/.test(foreignErr.message), foreignErr);
    // Lost response on finalize: retried, one deal.
    const lostFinCalls: unknown[] = [];
    const lfItem = await item(userA, 'Lost Finalize (OD)', 'owned');
    const lfDraft = await draft(cA, { operation_type: 'SELL', outgoing_item_ids: [lfItem], cash_received: 200 });
    const lostClient = lostOnce(cA, 'finalize_operation_draft', lostFinCalls);
    const { executeIdempotentMutation } = await import('../src/lib/writeRetry');
    const lf = await executeIdempotentMutation('finalize_operation_draft', () => lostClient.rpc('finalize_operation_draft', { p_draft_id: lfDraft.draft_id, p_kind: 'sale', p_operation: { p_deal_date: '2026-10-31', p_channel_id: MP, p_items: [{ item_id: lfItem, total_value: 200 }], p_notes: null, p_cf_description: null } }), fast.retry);
    const lfDeal = (lf.response.data as { deal_id?: number } | null)?.deal_id;
    if (lfDeal) dealIds.push(lfDeal);
    check('finalize lost response → retried → REPLAY with the committed deal; exactly one deal for the item', lf.attempts === 2 && (lf.response.data as { status: string }).status === 'REPLAY' && ((await admin.from('deal_items').select('deal_id').eq('item_id', lfItem)).data ?? []).length === 1, lf);

    // ── W8: discard ──────────────────────────────────────────────────────
    console.log('\n[W8 — discard]');
    const disc = await draft(cA, { operation_type: 'TRADE', outgoing_item_ids: [oneOut], incoming_items: [{ brand: 'Boss', model: 'Discard Plain (OD)' }, { brand: 'Boss', model: 'Discard With Photo (OD)' }] });
    const [plainId, photoId] = disc.incoming_item_ids;
    await cA.from('inventory_item_photos').insert({ inventory_item_id: photoId, storage_path: `${authA}/${photoId}/fake.png`, file_name: 'fake.png', content_type: 'image/png', file_size: 1, is_main: true, sort_order: 0 });
    const beforeDiscard = await state();
    const { data: dRes, error: dErr } = await cA.rpc('discard_operation_draft', { p_draft_id: disc.draft_id, p_remove_new_items: true });
    const dr = dRes as { status: string; removed_item_ids: number[]; kept_items: { item_id: number; reasons: string[] }[] };
    check('discard → OK; untouched NEW item deleted; item with a photo kept (reason)', !dErr && dr.status === 'OK' && JSON.stringify(dr.removed_item_ids) === JSON.stringify([plainId]) && dr.kept_items.length === 1 && dr.kept_items[0].item_id === photoId && dr.kept_items[0].reasons.includes('has photos'), dErr ?? dr);
    check('deleted item gone; kept item still NEW', ((await admin.from('inventory_items').select('id').eq('id', plainId)).data ?? []).length === 0 && (await itemRow(photoId)).status === 'new');
    check('discard had no business effect (no deal / cash); outgoing item unchanged', (await state()).deals === beforeDiscard.deals && (await state()).cash === beforeDiscard.cash && (await itemRow(oneOut)).status === 'owned');
    check('kept NEW item is plain inventory again (appears in analytics lifecycle as before drafts existed)', (await state()).lifecycle === beforeDiscard.lifecycle + 1, { beforeDiscard, now: await state() });
    const dAgain = await cA.rpc('discard_operation_draft', { p_draft_id: disc.draft_id, p_remove_new_items: true });
    check('discard again → REPLAY (same result)', !dAgain.error && (dAgain.data as { status: string }).status === 'REPLAY');
    const { error: finDisc } = await cA.rpc('finalize_operation_draft', { p_draft_id: disc.draft_id, p_kind: 'trade', p_operation: {} });
    check('discarded draft cannot be finalized', !!finDisc && /DRAFT_NOT_OPEN/.test(finDisc.message));
    const keep = await draft(cA, { operation_type: 'BUY', incoming_items: [{ brand: 'Boss', model: 'Keep Me (OD)' }], cash_paid: 10 });
    const { data: kRes } = await cA.rpc('discard_operation_draft', { p_draft_id: keep.draft_id, p_remove_new_items: false });
    check('discard without cleanup keeps the NEW items', (kRes as { removed_item_ids: number[] }).removed_item_ids.length === 0 && (await itemRow(keep.incoming_item_ids[0])).status === 'new');
    const { error: finFinal } = await cA.rpc('discard_operation_draft', { p_draft_id: r1.draft_id, p_remove_new_items: true });
    check('a finalized draft cannot be discarded', !!finFinal && /DRAFT_NOT_OPEN/.test(finFinal.message));

    // ── W9: analytics isolation (open drafts) ───────────────────────────
    console.log('\n[W9 — analytics isolation for open drafts]');
    const s0 = await state();
    const iso = await draft(cA, { operation_type: 'BUY', incoming_items: [{ brand: 'Ibanez', model: 'Isolation Check (OD)', estimated_sold_value: 500 }], cash_paid: 400 });
    const s1 = await state();
    check('open draft: lifecycle v1/v2, deals, deal_items, cash unchanged', JSON.stringify(s0) === JSON.stringify(s1), { s0, s1 });
    const { data: lc } = await cA.from('analytics_item_lifecycle').select('item_id').eq('item_id', iso.incoming_item_ids[0]);
    check('the draft-only item is absent from analytics_item_lifecycle', (lc ?? []).length === 0);
    const { data: own } = await cA.from('inventory_items').select('id, status').eq('id', iso.incoming_item_ids[0]);
    check('…but present in inventory (status new) for editing / photos', (own ?? []).length === 1 && own![0].status === 'new');
  } finally {
    console.log('\n[cleanup]');
    if (storagePaths.length) await admin.storage.from('inventory-photos').remove(storagePaths);
    const allDrafts = ((await admin.from('operation_drafts').select('id').in('user_id', [userA, userB])).data ?? []).map((d) => d.id as number);
    if (allDrafts.length) await admin.from('operation_drafts').delete().in('id', allDrafts);
    const fixtureItems = ((await admin.from('inventory_items').select('id').in('user_id', [userA, userB])).data ?? []).map((i) => i.id as number);
    const allItems = Array.from(new Set([...itemIds, ...fixtureItems]));
    const allLeads = ((await admin.from('item_leads').select('id').in('user_id', [userA, userB])).data ?? []).map((l) => l.id as number);
    if (allLeads.length) {
      await admin.from('lead_events').delete().in('item_lead_id', allLeads);
      await admin.from('item_leads').delete().in('id', allLeads);
    }
    const allDeals = Array.from(new Set([...dealIds, ...((await admin.from('deals').select('id').in('user_id', [userA, userB])).data ?? []).map((d) => d.id as number)]));
    if (allDeals.length) {
      await admin.from('inventory_expenses').delete().in('deal_id', allDeals);
      await admin.from('cash_flow').delete().in('deal_id', allDeals);
      await admin.from('deal_items').delete().in('deal_id', allDeals);
      await admin.from('deals').delete().in('id', allDeals);
    }
    if (allItems.length) {
      await admin.from('inventory_item_photos').delete().in('inventory_item_id', allItems);
      await admin.from('item_listings').delete().in('inventory_item_id', allItems);
      await admin.from('inventory_items').delete().in('id', allItems);
    }
    for (const name of ['DOD', 'Fender', 'Ibanez', 'Boss']) {
      if (brandsBefore.has(name.toLowerCase())) continue;
      const { data: b } = await admin.from('brands').select('id').ilike('name', name);
      for (const row of b ?? []) {
        const used = ((await admin.from('inventory_items').select('id').eq('brand_id', row.id).limit(1)).data ?? []).length;
        if (!used) await admin.from('brands').delete().eq('id', row.id);
      }
    }
    await admin.from('deal_id_reservations').delete().in('user_id', [userA, userB]);
    check('cleanup: fixture drafts removed', ((await admin.from('operation_drafts').select('id').in('user_id', [userA, userB])).data ?? []).length === 0);
    check('cleanup: fixture items removed', ((await admin.from('inventory_items').select('id').in('user_id', [userA, userB])).data ?? []).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
