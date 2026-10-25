/**
 * test-item-context-photo.ts
 *
 * MCP get_item_context + the item's single stored photo as ImageContent:
 *   P — pure: MIME sniffing
 *   S — source structure: route delegates to buildItemContextToolResult; no
 *       URLs / service_role in the photo path
 *   W — local Supabase (real Storage bucket + RLS) through signed-in clients:
 *       text unchanged, exactly one image block, correct MIME, exact bytes,
 *       no-photo, other user's item/photo, missing file, oversized file,
 *       throwing loader, protocol validity (SDK isCallToolResult).
 * Self-cleaning dedicated fixture (two users).
 *
 * Usage:  npx tsx scripts/test-item-context-photo.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { isCallToolResult } from '@modelcontextprotocol/server';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { buildItemContextToolResult, loadItemPhotoForMcp, MCP_ITEM_PHOTO_MAX_BYTES, sniffImageMime, ITEM_PHOTO_BUCKET } from '../src/lib/analytics/itemContextToolResult';
import { getItemContextForMcp } from '../src/lib/analytics/itemContextMcp';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ''); }
}

const PASSWORD = 'Item-Photo-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const root = path.join(__dirname, '..');
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

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
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}

async function main() {
  const jpeg = new Uint8Array(await sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer());
  const png = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 120, b: 255, alpha: 1 } } }).png().toBuffer());
  const webp = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 200, b: 10 } } }).webp().toBuffer());

  console.log('\n[P — MIME sniffing]');
  check('JPEG / PNG / WebP recognized from bytes', sniffImageMime(jpeg) === 'image/jpeg' && sniffImageMime(png) === 'image/png' && sniffImageMime(webp) === 'image/webp');
  check('anything else (HEIC-like / text / empty) -> null', sniffImageMime(new TextEncoder().encode('hello world!')) === null && sniffImageMime(new Uint8Array()) === null);

  console.log('\n[S — wiring]');
  const route = fs.readFileSync(path.join(root, 'src/app/api/mcp/[[...path]]/route.ts'), 'utf8');
  const mod = fs.readFileSync(path.join(root, 'src/lib/analytics/itemContextToolResult.ts'), 'utf8');
  check('route get_item_context delegates to buildItemContextToolResult with the request-scoped client', /async \(\{ item_id, lead_id, full_history \}\) => buildItemContextToolResult\(supabase, \{ item_id, lead_id, full_history \}\)/.test(route));
  check('photo path creates / returns no URL and uses no service_role', !/getPublicUrl|createSignedUrl|SERVICE_ROLE|serviceClient|https?:\/\//.test(mod.replace(/\/\/.*$/gm, '')));
  check('same photo pick as the UI (is_main first, then sort_order), single row', mod.includes(".order('is_main', { ascending: false })") && mod.includes(".order('sort_order', { ascending: true })") && mod.includes('.limit(1)'));
  check('no photo_count / multi-photo fields', !/photo_count|photos:/.test(mod));

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const authA = await ensureAuthUser(admin, 'item-photo-a@example.test');
  const authB = await ensureAuthUser(admin, 'item-photo-b@example.test');
  const userA = await resolveAppUserId(admin, authA);
  const userB = await resolveAppUserId(admin, authB);
  const cA = await signIn('item-photo-a@example.test');
  const cB = await signIn('item-photo-b@example.test');

  let { data: brand } = await admin.from('brands').select('id').limit(1).maybeSingle();
  let createdBrand: number | null = null;
  if (!brand) { brand = (await admin.from('brands').insert({ name: `IP Brand ${uuid().slice(0, 6)}` }).select('id').single()).data; createdBrand = brand!.id as number; }
  const itemIds: number[] = [];
  const paths: string[] = [];

  try {
    const item = async (userId: number, model: string) => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model, status: 'owned', serial_number: `IP-${uuid().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    // Upload as the OWNER (storage insert policy: own folder), then the metadata row (row content_type deliberately stale).
    const photo = async (client: SupabaseClient, authUid: string, userId: number, itemId: number, bytes: Uint8Array | null, rowType: string, ext = 'jpg') => {
      const p = `${authUid}/${itemId}/${Date.now()}-${uuid().slice(0, 6)}.${ext}`;
      if (bytes) {
        const { error } = await client.storage.from(ITEM_PHOTO_BUCKET).upload(p, bytes, { contentType: rowType === 'image/png' && ext === 'png' ? 'image/png' : 'image/jpeg', upsert: false });
        if (error) throw new Error(`upload: ${error.message}`);
        paths.push(p);
      }
      const { error: rowErr } = await admin.from('inventory_item_photos').insert({ inventory_item_id: itemId, user_id: userId, storage_path: p, file_name: 'x', content_type: rowType, file_size: 4_000_000, is_main: true, sort_order: 0 });
      if (rowErr) throw new Error(`photo row: ${rowErr.message}`);
      return p;
    };

    const withPhoto = await item(userA, 'Photo Strat (IP)');
    await photo(cA, authA, userA, withPhoto, jpeg, 'image/png'); // row says PNG, file is JPEG (the production stale-type case)
    const pngItem = await item(userA, 'PNG Tele (IP)');
    await photo(cA, authA, userA, pngItem, png, 'image/png', 'png');
    const noPhoto = await item(userA, 'No Photo LP (IP)');
    const brokenItem = await item(userA, 'Broken Photo SG (IP)');
    await photo(cA, authA, userA, brokenItem, null, 'image/jpeg'); // row exists, file missing
    const bigItem = await item(userA, 'Huge Photo (IP)');
    const big = new Uint8Array(MCP_ITEM_PHOTO_MAX_BYTES + 1024); big.set(jpeg.subarray(0, 3));
    await photo(cA, authA, userA, bigItem, big, 'image/jpeg');
    const bItem = await item(userB, 'B Photo (IP)');
    await photo(cB, authB, userB, bItem, webp, 'image/webp', 'webp');

    console.log('\n[W1 — item with a photo]');
    const r1 = await buildItemContextToolResult(cA, { item_id: withPhoto });
    const plain1 = await getItemContextForMcp(cA, withPhoto, {});
    check('protocol-valid CallToolResult (SDK isCallToolResult)', isCallToolResult(r1));
    check('exactly two blocks: text then image', r1.content.length === 2 && r1.content[0].type === 'text' && r1.content[1].type === 'image', r1.content.map((c) => c.type));
    check('text block is exactly the unchanged item-context JSON', r1.content[0].type === 'text' && r1.content[0].text === JSON.stringify(plain1));
    const img = r1.content[1] as { type: 'image'; data: string; mimeType: string };
    check('MIME type from the bytes (image/jpeg), not the stale row type', img.mimeType === 'image/jpeg', img.mimeType);
    check('base64 decodes to the exact stored bytes', sha(Buffer.from(img.data, 'base64')) === sha(jpeg));
    check('no isError and exactly one image block', r1.isError === undefined && r1.content.filter((c) => c.type === 'image').length === 1);
    const r1b = await buildItemContextToolResult(cA, { item_id: withPhoto, full_history: true });
    check('photo also included with full_history / lead filters (same item)', r1b.content.length === 2 && r1b.content[1].type === 'image');

    const r2 = await buildItemContextToolResult(cA, { item_id: pngItem });
    check('PNG photo -> image/png with exact bytes', r2.content[1]?.type === 'image' && (r2.content[1] as { mimeType: string }).mimeType === 'image/png' && sha(Buffer.from((r2.content[1] as { data: string }).data, 'base64')) === sha(png));

    console.log('\n[W2 — no photo]');
    const r3 = await buildItemContextToolResult(cA, { item_id: noPhoto });
    check('no photo: one text block, identical to today\'s output, valid', r3.content.length === 1 && r3.content[0].type === 'text' && r3.content[0].text === JSON.stringify(await getItemContextForMcp(cA, noPhoto, {})) && isCallToolResult(r3));

    console.log('\n[W3 — isolation]');
    const r4 = await buildItemContextToolResult(cB, { item_id: withPhoto });
    check('another user calling for my item: "Item not found.", isError, no image', r4.isError === true && r4.content.length === 1 && r4.content[0].type === 'text' && r4.content[0].text === 'Item not found.');
    check('the photo loader itself returns nothing for another user\'s item (RLS on the photo row)', (await loadItemPhotoForMcp(cB, withPhoto)).status === 'none');
    check('…and I cannot load user B\'s photo', (await loadItemPhotoForMcp(cA, bItem)).status === 'none');
    const r5 = await buildItemContextToolResult(cB, { item_id: bItem });
    check('user B gets their own WebP photo', r5.content[1]?.type === 'image' && (r5.content[1] as { mimeType: string }).mimeType === 'image/webp' && sha(Buffer.from((r5.content[1] as { data: string }).data, 'base64')) === sha(webp));

    console.log('\n[W4 — failures keep the context]');
    const r6 = await buildItemContextToolResult(cA, { item_id: brokenItem });
    check('missing file: context text unchanged + one short note, no image, not an error', !r6.isError && r6.content.length === 2 && r6.content[0].type === 'text' && r6.content[0].text === JSON.stringify(await getItemContextForMcp(cA, brokenItem, {})) && r6.content[1].type === 'text' && /photo could not be included/.test((r6.content[1] as { text: string }).text) && isCallToolResult(r6), r6.content.map((c) => c.type));
    const r7 = await buildItemContextToolResult(cA, { item_id: bigItem });
    check('oversized file: skipped with a size note, context intact', !r7.isError && r7.content.length === 2 && r7.content[1].type === 'text' && /above the 3 MB limit/.test((r7.content[1] as { text: string }).text));
    const r8 = await buildItemContextToolResult(cA, { item_id: withPhoto }, async () => { throw new Error('boom'); });
    check('a throwing photo loader never destroys the context', !r8.isError && r8.content[0].type === 'text' && r8.content[0].text === JSON.stringify(plain1) && r8.content[1]?.type === 'text');
    const r9 = await buildItemContextToolResult(cA, { item_id: 999999999 });
    check('unknown item: unchanged "Item not found." error', r9.isError === true && r9.content.length === 1);
  } finally {
    console.log('\n=== Cleanup ===');
    if (paths.length) await admin.storage.from(ITEM_PHOTO_BUCKET).remove(paths);
    if (itemIds.length) {
      await admin.from('inventory_item_photos').delete().in('inventory_item_id', itemIds);
      await admin.from('inventory_items').delete().in('id', itemIds);
    }
    if (createdBrand) await admin.from('brands').delete().eq('id', createdBrand);
    check('cleanup: fixture items removed', ((await admin.from('inventory_items').select('id').in('id', itemIds.length ? itemIds : [-1])).data ?? []).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
