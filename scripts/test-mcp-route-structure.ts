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
 *   - exactly two tools, exactly these two names
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
  const route = strip(read('src', 'app', 'api', 'mcp', 'route.ts'));
  const itemContextService = strip(read('src', 'lib', 'analytics', 'itemContextService.ts'));
  const searchService = strip(read('src', 'lib', 'inventorySearchService.ts'));

  console.log('\n[A — exactly the two intended tools, read-only]');
  {
    const toolNames = Array.from(route.matchAll(/registerTool\(\s*'([a-zA-Z0-9_]+)'/g)).map((m) => m[1]);
    check('exactly two tools registered', toolNames.length === 2, toolNames);
    check('the two tools are exactly search_inventory and get_item_context (no extra, no renamed)', JSON.stringify([...toolNames].sort()) === JSON.stringify(['get_item_context', 'search_inventory']), toolNames);
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
    check("uses withSupabase({ auth: 'user' }) — never 'service_role' or 'admin'", /withSupabase\(\s*\{\s*auth:\s*'user'\s*\}\s*\)/.test(route));
    check('route.ts never references a service_role / admin client', !/service_role|SERVICE_ROLE|createAdminClient|admin:\s*true/.test(route));
    check('neither shared service file ever references service_role', !/service_role|SERVICE_ROLE/.test(itemContextService) && !/service_role|SERVICE_ROLE/.test(searchService));
    check('every tool handler is called with the request-scoped `supabase` from the pipeline context, not a module-level client', /searchInventoryForUser\(supabase,/.test(route) && /getItemContextForUser\(supabase,/.test(route));
  }

  console.log('\n[D — no mutation path reachable from either tool]');
  {
    const mutationPattern = /\.(insert|update|upsert|delete)\s*\(/;
    check('route.ts contains no mutation call', !mutationPattern.test(route));
    check('itemContextService.ts contains no mutation call (read-only assembly)', !mutationPattern.test(itemContextService));
    check('inventorySearchService.ts contains no mutation call (read-only search)', !mutationPattern.test(searchService));
    check('no raw .rpc( call anywhere in the MCP surface (no generic/arbitrary-RPC escape hatch)', !/\.rpc\(/.test(route) && !/\.rpc\(/.test(itemContextService) && !/\.rpc\(/.test(searchService));
  }

  console.log('\n[E — no generic SQL/table/RPC-name tool surface]');
  {
    check('no tool parameter resembles a raw table name, filter object, or SQL string', !/table_name|sql|raw_query|rpc_name/.test(route));
  }

  console.log('\n[F — no secrets ever surface in a tool response]');
  {
    const responseBuilders = route.match(/return \{ content: \[[\s\S]*?\] *(, isError: true)? *\};/g) ?? [];
    check('found both tool return statements to inspect', responseBuilders.length >= 2, responseBuilders.length);
    check('neither tool response embeds an env var / key / secret reference', !/process\.env|SERVICE_ROLE_KEY|service_role|secret/i.test(responseBuilders.join('\n')));
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
