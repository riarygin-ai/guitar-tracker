/**
 * test-mcp-route-structure.ts
 *
 * Structural/source-level regression coverage for src/app/api/mcp/route.ts.
 *
 * Deliberately does NOT import the route module: it depends on
 * @modelcontextprotocol/server / @supabase/middleware / @supabase/server,
 * which this sandboxed session could not install (see the final report —
 * `npm install` was blocked by the host's own "Untrusted Code Integration"
 * policy). Importing it here would fail with a module-resolution error
 * unrelated to correctness. Once those packages are actually installed
 * (locally, in CI, or by Vercel at deploy time), `npx tsc --noEmit` and
 * `npm run build` are the real compile-correctness check for this file —
 * this script instead locks down the SECURITY-CRITICAL invariants that
 * are visible from the source text alone and must never regress:
 *   - exactly four tools, exactly these four names
 *   - no tool input schema ever mentions a user/account/owner identifier
 *   - auth is 'user' (RLS-scoped), never service_role / admin
 *   - no mutation call (insert/update/delete/upsert/rpc) anywhere in the
 *     route or the two services it calls
 *   - both tools are annotated read-only / non-destructive
 *
 * Usage:  npx tsx scripts/test-mcp-route-structure.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

function main() {
  const route = strip(read('src', 'app', 'api', 'mcp', '[[...path]]', 'route.ts'));
  const itemContextService = strip(read('src', 'lib', 'analytics', 'itemContextService.ts'));
  const searchService = strip(read('src', 'lib', 'inventorySearchService.ts'));
  const inventoryAnalysisService = strip(read('src', 'lib', 'analytics', 'inventoryAnalysisService.ts'));
  const leadActivityService = strip(read('src', 'lib', 'analytics', 'leadActivityService.ts'));

  console.log('\n[A — exactly the four intended tools, read-only]');
  {
    const toolNames = Array.from(route.matchAll(/registerTool\(\s*'([a-zA-Z0-9_]+)'/g)).map((m) => m[1]);
    check('exactly four tools registered', toolNames.length === 4, toolNames);
    check(
      'the four tools are exactly search_inventory, get_item_context, get_inventory_analysis and get_lead_activity (no extra, no renamed)',
      JSON.stringify([...toolNames].sort()) === JSON.stringify(['get_inventory_analysis', 'get_item_context', 'get_lead_activity', 'search_inventory']),
      toolNames,
    );
    const readOnlyCount = (route.match(/readOnlyHint:\s*true/g) ?? []).length;
    check('every tool is annotated readOnlyHint: true', readOnlyCount === toolNames.length, readOnlyCount);
    const destructiveFalseCount = (route.match(/destructiveHint:\s*false/g) ?? []).length;
    check('every tool is annotated destructiveHint: false', destructiveFalseCount === toolNames.length, destructiveFalseCount);
  }

  console.log('\n[B — no tool schema ever accepts a user/account/owner identifier]');
  {
    const forbidden = /user_id|userId|account_id|accountId|auth_user_id|authUserId|owner_id|ownerId/;
    check('route.ts never mentions a user/account/owner identifier as an input field', !forbidden.test(route), route.match(forbidden));
    check('inputSchema blocks contain no such field', !forbidden.test(route.slice(route.indexOf('inputSchema'), route.lastIndexOf('annotations'))));
  }

  console.log('\n[C — auth is user-scoped RLS, never service_role/admin]');
  {
    check("uses withSupabase({ auth: 'user', ... }) — never 'service_role' or 'admin'", /withSupabase\(\s*\{\s*auth:\s*'user'/.test(route));
    check('route.ts never references a service_role / admin client', !/service_role|SERVICE_ROLE|createAdminClient|admin:\s*true/.test(route));
    check(
      'none of the four shared service files ever references service_role',
      !/service_role|SERVICE_ROLE/.test(itemContextService) && !/service_role|SERVICE_ROLE/.test(searchService) &&
      !/service_role|SERVICE_ROLE/.test(inventoryAnalysisService) && !/service_role|SERVICE_ROLE/.test(leadActivityService),
    );
    check(
      'every tool handler is called with the request-scoped `supabase` from the pipeline context, not a module-level client',
      /searchInventoryForUser\(supabase,/.test(route) && /getItemContextForUser\(supabase,/.test(route) &&
      /getInventoryAnalysisForUser\(supabase,/.test(route) && /getLeadActivityForUser\(supabase,/.test(route),
    );
  }

  console.log('\n[C3 — the two new analytics tools use ONLY the self-scoped RPC wrappers (migration 20261013000000), never the original trusted-parameter functions]');
  {
    const rpcCalls = Array.from((inventoryAnalysisService + leadActivityService).matchAll(/\.rpc\(\s*'([a-zA-Z0-9_]+)'/g)).map((m) => m[1]);
    check('at least one RPC call found in the two new services', rpcCalls.length >= 2, rpcCalls);
    check(
      'every RPC call is one of the two self-scoped "_for_current_user" wrappers — never the original service_role-only functions with a parameter',
      rpcCalls.every((name) => name === 'build_listing_evidence_v1_0_for_current_user' || name === 'listing_demand_item_activity_v1_0_for_current_user'),
      rpcCalls,
    );
    check('neither new service ever calls the original trusted-parameter RPC directly (build_listing_evidence_v1_0 / listing_demand_item_activity_v1_0 without the _for_current_user suffix)',
      !/\.rpc\(\s*'build_listing_evidence_v1_0'/.test(inventoryAnalysisService) && !/\.rpc\(\s*'listing_demand_item_activity_v1_0'/.test(leadActivityService));
    check('no user id is ever passed as an RPC parameter from either new service (p_target_user_id never appears)', !/p_target_user_id/.test(inventoryAnalysisService) && !/p_target_user_id/.test(leadActivityService));
  }

  console.log('\n[C2 — 2026-10-14 regression: explicit env (not ambient SUPABASE_URL) + catch-all routing]');
  {
    check('withSupabase is given an explicit env.url/publishableKeys (never relies on the bare SUPABASE_URL this project does not set)', /env:\s*\{\s*url:\s*SUPABASE_URL/.test(route) && /publishableKeys:\s*\{\s*default:\s*SUPABASE_ANON_KEY\s*\}/.test(route));
    check('SUPABASE_ANON_KEY is sourced from this project\'s own NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY convention', /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/.test(route));
    check('route file lives under the optional catch-all segment (api/mcp/[[...path]]), so /api/mcp/oauth-protected-resource reaches this pipeline too', fs.existsSync(path.join(root, 'src', 'app', 'api', 'mcp', '[[...path]]', 'route.ts')));
    check('the old non-catch-all src/app/api/mcp/route.ts no longer exists (superseded, not duplicated)', !fs.existsSync(path.join(root, 'src', 'app', 'api', 'mcp', 'route.ts')));
    check('GET, POST, DELETE and OPTIONS are all exported (OPTIONS needed for the metadata route\'s own CORS preflight)', /export async function GET\(/.test(route) && /export async function POST\(/.test(route) && /export async function DELETE\(/.test(route) && /export async function OPTIONS\(/.test(route));
  }

  console.log('\n[D — no mutation path reachable from any of the four tools]');
  {
    const mutationPattern = /\.(insert|update|upsert|delete)\s*\(/;
    check('route.ts contains no mutation call', !mutationPattern.test(route));
    check('itemContextService.ts contains no mutation call (read-only assembly)', !mutationPattern.test(itemContextService));
    check('inventorySearchService.ts contains no mutation call (read-only search)', !mutationPattern.test(searchService));
    check('inventoryAnalysisService.ts contains no mutation call (read-only assembly)', !mutationPattern.test(inventoryAnalysisService));
    check('leadActivityService.ts contains no mutation call (read-only assembly)', !mutationPattern.test(leadActivityService));
    check(
      'route.ts and the two simpler services (search/item-context) call no raw RPC at all — only the two new analytics services do, and only the two named self-scoped wrappers (checked in C3)',
      !/\.rpc\(/.test(route) && !/\.rpc\(/.test(itemContextService) && !/\.rpc\(/.test(searchService),
    );
  }

  console.log('\n[E — no generic SQL/table/RPC-name tool surface]');
  {
    check('no tool parameter resembles a raw table name, filter object, SQL string, or RPC name chosen by the caller', !/table_name|sql|raw_query|rpc_name/.test(route));
  }

  console.log('\n[F — no secrets ever surface in a tool response]');
  {
    const responseBuilders = route.match(/return \{ content: \[[\s\S]*?\] *(, isError: true)? *\};/g) ?? [];
    check('found at least four tool return statements to inspect (one per tool, some tools have more than one)', responseBuilders.length >= 4, responseBuilders.length);
    check('no tool response embeds an env var / key / secret reference', !/process\.env|SERVICE_ROLE_KEY|service_role|secret/i.test(responseBuilders.join('\n')));
  }

  console.log('\n[G — this is the official Supabase OAuth MCP pattern, not a custom auth implementation]');
  {
    check('imports withOAuthProtectedResource and withSupabase from @supabase/server (never hand-rolled)', /from '@supabase\/server'/.test(route) && /withOAuthProtectedResource/.test(route) && /withSupabase/.test(route));
    check('no custom /authorize, /token, or JWT-signing code anywhere in this file', !/jsonwebtoken|jwt\.sign|'\/authorize'|'\/token'/.test(route));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
