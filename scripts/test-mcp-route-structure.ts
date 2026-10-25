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
 *   - exactly eleven tools: the nine read-only names + the two lead write tools
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
  // 2026-10-19: the four business tools' services and the shared modules they call.
  const businessServices: Record<string, string> = {
    contactHistoryService: strip(read('src', 'lib', 'analytics', 'contactHistoryService.ts')),
    operationsService: strip(read('src', 'lib', 'analytics', 'operationsService.ts')),
    dealChainService: strip(read('src', 'lib', 'analytics', 'dealChainService.ts')),
    itemLineageData: strip(read('src', 'lib', 'itemLineageData.ts')),
    tradeChain: strip(read('src', 'lib', 'tradeChain.ts')),
    operationFinancials: strip(read('src', 'lib', 'operations', 'operationFinancials.ts')),
    contactName: strip(read('src', 'lib', 'leads', 'contactName.ts')),
  };

  console.log('\n[A — exactly the eleven intended tools: nine read-only + two lead write tools]');
  {
    const toolNames = Array.from(route.matchAll(/registerTool\(\s*'([a-zA-Z0-9_]+)'/g)).map((m) => m[1]);
    check('exactly eleven tools registered', toolNames.length === 11, toolNames);
    check(
      'the eleven tools are the nine read-only tools plus record_lead_interaction and void_lead_event (no extra, no renamed)',
      JSON.stringify([...toolNames].sort()) === JSON.stringify([
        'find_contact_history', 'get_deal_chain', 'get_inventory_analysis', 'get_item_context',
        'get_lead_activity', 'get_leads', 'get_operation_context', 'get_operations_analysis', 'record_lead_interaction', 'search_inventory', 'void_lead_event',
      ]),
      toolNames,
    );
    const block = (name: string) => { const i = route.indexOf(`registerTool(\n    '${name}'`); const j = route.indexOf('registerTool(', i + 10); return route.slice(i, j < 0 ? undefined : j); };
    const readOnly = toolNames.filter((n) => !['record_lead_interaction', 'void_lead_event'].includes(n));
    check('the nine read tools are annotated readOnlyHint: true + destructiveHint: false', readOnly.every((n) => /readOnlyHint:\s*true/.test(block(n)) && /destructiveHint:\s*false/.test(block(n))), readOnly.filter((n) => !/readOnlyHint:\s*true/.test(block(n))));
    check('record_lead_interaction: readOnlyHint false, destructiveHint false (append-only), idempotentHint true', /readOnlyHint:\s*false,\s*destructiveHint:\s*false,\s*idempotentHint:\s*true/.test(block('record_lead_interaction')));
    check('void_lead_event: readOnlyHint false, destructiveHint true, idempotentHint true', /readOnlyHint:\s*false,\s*destructiveHint:\s*true,\s*idempotentHint:\s*true/.test(block('void_lead_event')));
    check('exactly two tools are not read-only', (route.match(/readOnlyHint:\s*false/g) ?? []).length === 2);
    check('void_lead_event is described as a correction/repair, not normal logging', /CORRECTION \/ REPAIR/.test(block('void_lead_event')) && /not normal lead logging/.test(block('void_lead_event')));
    check('record_lead_interaction never accepts LEGACY_SNAPSHOT (agent event enum)', /type:\s*z\.enum\(AGENT_EVENT_TYPES\)/.test(block('record_lead_interaction')));
    check('record_lead_interaction has no notes-replacement input', !/notes:\s*z\./.test(block('record_lead_interaction')));
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
      /searchInventoryForUser\(supabase,/.test(route) && /buildItemContextToolResult\(supabase,/.test(route) &&
      /recordLeadInteraction\(supabase,/.test(route) && /voidLeadEvent\(supabase,/.test(route) &&
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

  console.log('\n[C4 — 2026-10-14 get_lead_activity redesign: self-scoped data path + three-layer schema]');
  {
    const leadRpcs = Array.from(leadActivityService.matchAll(/\.rpc\(\s*'([a-zA-Z0-9_]+)'/g)).map((m) => m[1]);
    check('leadActivityService calls exactly one RPC: the self-scoped open-inventory wrapper (same item set as get_inventory_analysis)', JSON.stringify(leadRpcs) === JSON.stringify(['build_listing_evidence_v1_0_for_current_user']), leadRpcs);
    const tables = Array.from(leadActivityService.matchAll(/\.from\(\s*'([a-zA-Z0-9_]+)'/g)).map((m) => m[1]).sort();
    check('leadActivityService reads only item_leads and deal_channels tables (both RLS/grant-protected), through the caller\'s client', JSON.stringify(tables) === JSON.stringify(['deal_channels', 'item_leads']), tables);
    check('leadActivityService never filters by an application-supplied user id (RLS is the boundary)', !/\.eq\(\s*'user_id'/.test(leadActivityService) && !/appUserId|app_user_id/.test(leadActivityService));
    check('leadActivityService creates no client of its own (no createClient / env keys)', !/createClient|process\.env/.test(leadActivityService));
    const schemaStart = route.indexOf("'get_lead_activity'");
    const schema = route.slice(schemaStart, route.indexOf('annotations', schemaStart));
    for (const field of ['bucket', 'periods', 'from_date', 'to_date', 'item_ids', 'channel']) {
      check(`get_lead_activity schema exposes ${field}`, new RegExp(`\\b${field}:\\s*z\\.`).test(schema));
    }
    check('get_lead_activity schema exposes no lead-level status/quality/offer_type filter', !/\b(status|quality|lead_quality|offer_type):\s*z\./.test(schema));
    check('get_lead_activity description states the three layers and that recent activity is not complete demand', /current_period/.test(schema) && /lifetime/.test(schema) && /bucket="month"/.test(schema) && /supplementary/.test(schema));
    check('get_inventory_analysis description points to get_lead_activity for demand conclusions', /NOT lead-demand history[\s\S]*get_lead_activity/.test(route));
  }

  console.log('\n[C2 — 2026-10-14 regression: explicit env (not ambient SUPABASE_URL) + catch-all routing]');
  {
    check('withSupabase is given an explicit env.url/publishableKeys (never relies on the bare SUPABASE_URL this project does not set)', /env:\s*\{\s*url:\s*SUPABASE_URL/.test(route) && /publishableKeys:\s*\{\s*default:\s*SUPABASE_ANON_KEY\s*\}/.test(route));
    check('SUPABASE_ANON_KEY is sourced from this project\'s own NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY convention', /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/.test(route));
    check('route file lives under the optional catch-all segment (api/mcp/[[...path]]), so /api/mcp/oauth-protected-resource reaches this pipeline too', fs.existsSync(path.join(root, 'src', 'app', 'api', 'mcp', '[[...path]]', 'route.ts')));
    check('the old non-catch-all src/app/api/mcp/route.ts no longer exists (superseded, not duplicated)', !fs.existsSync(path.join(root, 'src', 'app', 'api', 'mcp', 'route.ts')));
    check('GET, POST, DELETE and OPTIONS are all exported (OPTIONS needed for the metadata route\'s own CORS preflight)', /export async function GET\(/.test(route) && /export async function POST\(/.test(route) && /export async function DELETE\(/.test(route) && /export async function OPTIONS\(/.test(route));
  }

  console.log('\n[C5 — 2026-10-19 business tools: same security model]');
  {
    for (const [name, src] of Object.entries(businessServices)) {
      check(`${name}: no service_role / admin client / env keys`, !/service_role|SERVICE_ROLE|createClient|process\.env/.test(src));
      if (name === 'tradeChain' || name === 'operationFinancials' || name === 'contactName') {
        check(`${name}: pure module — never touches a database client`, !/SupabaseClient|\.from\(\s*'/.test(src));
      } else {
        check(`${name}: no mutation call`, !/\.(insert|update|upsert|delete)\s*\(/.test(src));
      }
      check(`${name}: no RPC call (plain RLS-scoped table reads only)`, !/\.rpc\(/.test(src));
      check(`${name}: never filters by an application-supplied user id`, !/\.eq\(\s*'user_id'/.test(src) && !/appUserId|p_target_user_id/.test(src));
    }
    check(
      'each new tool handler receives the request-scoped `supabase` client',
      /findContactHistoryForUser\(supabase,/.test(route) && /getOperationsAnalysisForUser\(supabase,/.test(route) &&
      /getOperationContextForUser\(supabase,/.test(route) && /getDealChainForUser\(supabase,/.test(route),
    );
    const schemaOf = (tool: string) => {
      const start = route.indexOf(`'${tool}'`);
      return route.slice(start, route.indexOf('annotations', start));
    };
    check('find_contact_history schema: contact_name required; channel/item_id/include_possible_matches optional; no time filter',
      /contact_name:\s*z\.string\(\)\.trim\(\)\.min\(1\)/.test(schemaOf('find_contact_history')) && !/from_date|to_date/.test(schemaOf('find_contact_history')));
    check('get_operation_context takes exactly deal_id (no operation_id alias)', /deal_id:\s*z\./.test(schemaOf('get_operation_context')) && !/operation_id/.test(route));
    check('get_deal_chain takes exactly item_id, no time filter', /item_id:\s*z\./.test(schemaOf('get_deal_chain')) && !/from_date|to_date/.test(schemaOf('get_deal_chain')));
    check('get_operations_analysis description states the default period and the turnover limitation', /last 6 months/.test(schemaOf('get_operations_analysis')) && /no separate "revenue"\/"turnover"/.test(schemaOf('get_operations_analysis')));
  }

  console.log('\n[D — no mutation path reachable from any of the eight tools]');
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

  console.log('\n[H — 2026-10-21 lead write tools: narrow, user-scoped write path]');
  {
    const writeService = strip(read('src', 'lib', 'leads', 'leadWriteService.ts'));
    const classification = strip(read('src', 'lib', 'leads', 'classification.ts'));
    const semantics = strip(read('src', 'lib', 'leads', 'semantics.ts'));
    check('write service: no service_role / admin client / env keys', !/service_role|SERVICE_ROLE|createClient|process\.env/.test(writeService));
    check('write service: the ONLY RPC is apply_lead_interaction', JSON.stringify(Array.from(new Set(Array.from(writeService.matchAll(/\.rpc\(\s*'([a-zA-Z0-9_]+)'/g)).map((m) => m[1])))) === JSON.stringify(['apply_lead_interaction']));
    check('write service: no direct table insert/update/upsert/delete', !/\.from\([^)]*\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\s*\(/.test(writeService));
    check('write service: never filters or writes by an application-supplied user id', !/\.eq\(\s*'user_id'/.test(writeService) && !/user_id:\s*(?!number\b)[a-zA-Z]/.test(writeService));
    check('classification + semantics are pure (no database client)', !/SupabaseClient|\.from\(\s*'/.test(classification) && !/SupabaseClient|\.from\(\s*'/.test(semantics));
    const migration = read('supabase', 'migrations', '20261021000000_lead_events_direct_writes.sql');
    check('apply_lead_interaction is SECURITY DEFINER with an explicit search_path and resolves identity via get_app_user_id()', /FUNCTION public\.apply_lead_interaction\(p_request jsonb\)[\s\S]*?SECURITY DEFINER\s+SET search_path = public, pg_temp[\s\S]*?get_app_user_id\(\)/.test(migration));
    check('apply_lead_interaction: EXECUTE revoked from PUBLIC/anon, granted to authenticated only', /REVOKE ALL ON FUNCTION public\.apply_lead_interaction\(jsonb\) FROM PUBLIC, anon;/.test(migration) && /GRANT EXECUTE ON FUNCTION public\.apply_lead_interaction\(jsonb\) TO authenticated;/.test(migration));
    check('lead_events: authenticated gets SELECT only', /GRANT SELECT ON public\.lead_events TO authenticated;/.test(migration) && !/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*lead_events TO authenticated/.test(migration));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
