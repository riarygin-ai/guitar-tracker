/**
 * test-item-context-service.ts
 *
 * Coverage for src/lib/analytics/itemContextService.ts — the server-callable
 * "Copy Item Context" assembly used by the read-only MCP get_item_context
 * tool. Does NOT re-test itemContext.ts/itemContextData.ts's own output
 * correctness (see test-item-context.ts / test-item-context-history.ts for
 * that) — this script's job is to confirm the NEW assembly service reaches
 * the same documented output conventions, and — most importantly — that
 * ownership is enforced entirely by RLS: a foreign/nonexistent item_id must
 * be indistinguishable.
 *
 * Usage:  npx tsx scripts/test-item-context-service.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning, setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { getItemContextForUser, ItemContextServiceError } from '../src/lib/analytics/itemContextService';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    auth: { persistSession: false },
  });
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log('\n[fixtures] Ensuring shared local test fixtures exist...');
  const fixtures = await setupAnalyticsTestFixtures(admin);
  const clientA = await signIn(fixtures.userAEmail, fixtures.password);
  const clientB = await signIn(fixtures.userBEmail, fixtures.password);

  const userAItemId = fixtures.items.openFenderPositiveBand; // userA's own item, has a listing
  const userBItemId = fixtures.items.userBOpenFender;         // userB's own item

  console.log('\n[A — own item: output shape and conventions]');
  {
    const text = await getItemContextForUser(clientA, userAItemId);
    check('returns text (not null) for the caller\'s own existing item', typeof text === 'string');
    check('starts with the ITEM CONTEXT header, then the "Item ID: <id>" line external workflows key off (never renamed/removed)', text!.startsWith(`ITEM CONTEXT\n\nItem ID: ${userAItemId}\n`));
    check('brand name resolved (Fender)', /Brand: Fender/.test(text!));
    check('includes a LISTING HISTORY section (this item has a real listing)', text!.includes('LISTING HISTORY'));
    check('never leaks a database UUID in the Item ID line (plain integer id only)', /\nItem ID: \d+\n/.test(text!));
  }

  console.log('\n[B — missing / foreign item: must be indistinguishable]');
  {
    const missing = await getItemContextForUser(clientA, 999999999);
    check('a genuinely nonexistent item_id returns null', missing === null);

    const foreign = await getItemContextForUser(clientB, userAItemId);
    check('user B requesting user A\'s real item_id returns null — exactly like a nonexistent item (RLS, not an app-level owner check)', foreign === null);

    const reverseForeign = await getItemContextForUser(clientA, userBItemId);
    check('the foreign-item block is symmetric: user A cannot fetch user B\'s item either', reverseForeign === null);

    const bOwn = await getItemContextForUser(clientB, userBItemId);
    check('user B can still fetch their OWN item (the block above is ownership-specific, not a blanket failure)', typeof bOwn === 'string' && bOwn!.startsWith(`ITEM CONTEXT\n\nItem ID: ${userBItemId}\n`));
  }

  console.log('\n[C — invalid input handled safely]');
  {
    check('a zero id returns null without throwing', await getItemContextForUser(clientA, 0) === null);
    check('a negative id returns null without throwing', await getItemContextForUser(clientA, -5) === null);
    check('a non-integer id returns null without throwing', await getItemContextForUser(clientA, 1.5) === null);
  }

  console.log('\n[D — never leaks secrets or internal error detail into the returned text]');
  {
    const text = await getItemContextForUser(clientA, userAItemId);
    check('no Supabase URL, key-shaped string, or stack trace appears in the output', !/supabase\.co|service_role|eyJ[A-Za-z0-9_-]{10,}|at \w+ \(/.test(text!));
  }

  console.log('\n[E — ItemContextServiceError is exported for callers to distinguish genuine failures]');
  check('ItemContextServiceError is a real Error subclass', new ItemContextServiceError('x') instanceof Error);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
