// Remote MCP server for Guitar Tracker — READ-ONLY, exactly four tools:
// search_inventory, get_item_context, get_inventory_analysis, and
// get_lead_activity. Built on Supabase's official
// OAuth 2.1 / MCP authentication middleware (NOT a custom /authorize,
// /token, client registry, or JWT implementation — Supabase Auth's own
// OAuth 2.1 server issues and verifies every token; see
// supabase.com/docs/guides/auth/oauth-server/mcp-authentication and
// supabase.com/docs/guides/ai-tools/byo-mcp for the "outside Supabase Edge
// Functions" deployment shape this file follows).
//
// Optional catch-all ([[...path]]), not a plain `route.ts` under
// src/app/api/mcp/ — withOAuthProtectedResource() serves OAuth Protected
// Resource Metadata at `GET {resource}/oauth-protected-resource`, i.e.
// /api/mcp/oauth-protected-resource here. A non-catch-all route only ever
// matches the exact /api/mcp path, so that nested metadata request 404'd
// at the Next.js router before our code ever ran — ChatGPT's "Couldn't
// discover OAuth settings" error (2026-10-14 investigation). This file
// matches /api/mcp AND any nested path under it, so both the base MCP
// endpoint and the metadata document reach the same pipeline below.
//
// Pipeline (outside-in): withOAuthProtectedResource() publishes the OAuth
// Protected Resource Metadata document + WWW-Authenticate challenge so MCP
// clients can discover Supabase as this server's authorization server,
// WITHOUT requiring auth itself. withSupabase({ auth: 'user' }) runs next —
// it rejects any request without a valid Supabase user access token and
// hands the handler a Supabase client already scoped to that user's
// session. EVERY query below goes through that client, so RLS (the SAME
// policies the rest of the app already relies on) is the actual isolation
// boundary — never an application-level user_id filter, and never
// service_role. No tool here accepts a user/account/owner identifier of
// any kind; identity comes only from the verified access token.
//
// Requires the Supabase project to sign JWTs with an asymmetric key
// (ES256/RS256) and the OAuth 2.1 Server to be enabled in the Supabase
// Dashboard — both are Dashboard-side prerequisites, not something this
// file can turn on. See the session's final report for exact steps.
//
// env is passed explicitly to withSupabase (2026-10-14 investigation):
// @supabase/server auto-detects its OWN env var names (bare SUPABASE_URL /
// SUPABASE_PUBLISHABLE_KEY), which this project does not set — it uses
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
// everywhere else (see every other API route under src/app/api). Without
// this, every request — authenticated or not — 500'd with
// MISSING_SUPABASE_URL before the OAuth challenge was ever produced. JWKS
// is left unset deliberately: @supabase/server derives it from `url`
// itself (`{url}/auth/v1/.well-known/jwks.json`), which is exactly this
// project's already-live ES256 JWKS endpoint.

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { pipeline } from '@supabase/middleware';
import { fromSupabaseUrl, withOAuthProtectedResource, withSupabase } from '@supabase/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getItemContextForUser } from '@/lib/analytics/itemContextService';
import { searchInventoryForUser, INVENTORY_SEARCH_MAX_RESULTS } from '@/lib/inventorySearchService';
import { getInventoryAnalysisForUser } from '@/lib/analytics/inventoryAnalysisService';
import { getLeadActivityForUser, LeadActivityServiceError } from '@/lib/analytics/leadActivityService';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

function buildMcpServer(supabase: SupabaseClient): McpServer {
  const server = new McpServer({ name: 'guitar-tracker', version: '1.0.0' });

  server.registerTool(
    'search_inventory',
    {
      description:
        'Find inventory items belonging to the signed-in Guitar Tracker user. Returns a small ' +
        'identity/disambiguation shape for each match (id, brand, model, year, color, category, ' +
        'type, purpose, status, serial number) — never notes, financials, leads, or listing ' +
        'history. Use get_item_context with the chosen item_id for full detail.',
      inputSchema: z.object({
        query: z.string().trim().max(200).optional()
          .describe('Free-text search, e.g. "Daphne Blue Telecaster". Matches brand, model, color, year, serial number.'),
        status: z.array(z.enum(['new', 'owned', 'listed', 'sold', 'traded'])).optional()
          .describe('Restrict to these statuses. Defaults to excluding sold/traded (currently owned/listed/new only).'),
        brand: z.string().trim().max(100).optional().describe('Filter by brand name (substring, case-insensitive).'),
        purpose: z.string().trim().max(100).optional().describe('Filter by purpose name (substring, case-insensitive).'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, status, brand, purpose }) => {
      const results = await searchInventoryForUser(supabase, { query, status, brand, purpose });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: results.length, max_results: INVENTORY_SEARCH_MAX_RESULTS, items: results }),
        }],
      };
    },
  );

  server.registerTool(
    'get_item_context',
    {
      description:
        'Returns the authoritative Guitar Tracker context for one inventory item (the same data ' +
        'the app\'s "Copy Item Context" produces): brand/model/condition, financials, acquired/sold ' +
        'dates, complete listing history with price changes, and complete lead history. Only works ' +
        "for an item belonging to the signed-in user — any other item_id behaves exactly like an " +
        'unavailable item.',
      inputSchema: z.object({
        item_id: z.number().int().positive().describe('The inventory item id, e.g. from search_inventory.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ item_id }) => {
      const text = await getItemContextForUser(supabase, item_id);
      if (text === null) {
        return { content: [{ type: 'text', text: 'Item not found.' }], isError: true };
      }
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'get_inventory_analysis',
    {
      description:
        'Returns the authenticated user\'s current inventory and listing-analysis dataset — the ' +
        'same data behind "Copy Analysis Data" / "Download Analysis Data": every currently-open ' +
        'item (listed AND unlisted), each with channel summary, category/purpose breakdowns, and ' +
        'full listing history (every listing cycle, including ended/cancelled ones, with its ' +
        'complete price-change history). Call with no filters for a complete weekly inventory ' +
        'review ("review my whole inventory"); use optional filters for narrower questions (e.g. ' +
        '"how are my Gibsons doing?" -> { brand: ["Gibson"] }). Calling with no filters never ' +
        'restricts to one brand, purpose, platform, or listed-only inventory — it is the full ' +
        'current picture.',
      inputSchema: z.object({
        item_ids: z.array(z.number().int().positive()).optional().describe('Restrict to these inventory item ids.'),
        status: z.array(z.enum(['listed', 'unlisted'])).optional()
          .describe('Restrict to currently listed items, currently unlisted (but open) items, or both. Omit for both.'),
        purpose: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) match against the item\'s assigned Purpose name, e.g. "Business" or "Personal".'),
        brand: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) match against brand name, e.g. "Gibson".'),
        category: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) match against item category name.'),
        type: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) match against item type/subtype name.'),
        min_days_listed: z.number().int().min(0).optional().describe('Only items whose current (longest-running) listing age is at least this many days. Excludes unlisted items.'),
        max_days_listed: z.number().int().min(0).optional().describe('Only items whose current (longest-running) listing age is at most this many days. Excludes unlisted items.'),
        include_listing_history: z.boolean().optional().describe('Default true. Set false to omit per-listing price history and shrink the response for broad questions that only need summary numbers.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (filters) => {
      const result = await getInventoryAnalysisForUser(supabase, filters);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'get_lead_activity',
    {
      description:
        'Returns lead/buyer activity grouped by inventory item, for the user\'s currently listed ' +
        'items (an item can only accrue attributed leads while it has listing exposure, so this ' +
        'has never covered unlisted items). Call with no filters for the full current lead picture ' +
        '(the last 4 weeks, the app\'s own default period) — e.g. "which items are getting ' +
        'attention but not converting?". Use filters when investigating particular items, ' +
        'platforms/channels, or a specific period.',
      inputSchema: z.object({
        item_ids: z.array(z.number().int().positive()).optional().describe('Restrict to these inventory item ids.'),
        channel: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) match against a channel the item is currently listed on, e.g. "Reverb".'),
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, inclusive. Defaults to 28 days before to_date.'),
        to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, inclusive. Defaults to today.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (filters) => {
      try {
        const result = await getLeadActivityForUser(supabase, filters);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof LeadActivityServiceError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
    },
  );

  return server;
}

// No explicit type annotation on the handler's `ctx` parameter below —
// `pipeline`'s own generics infer it from the entries array (accumulating
// withOAuthProtectedResource's + withSupabase's contributions); annotating
// it explicitly defeats that contextual inference and widens `ctx` to a
// bare `object`.
const fetchHandler = pipeline(
  [
    withOAuthProtectedResource({
      resourceServer: (req) => new URL(req.url).origin + '/api/mcp',
      authorizationServer: fromSupabaseUrl(SUPABASE_URL),
    }),
    withSupabase({
      auth: 'user',
      env: { url: SUPABASE_URL, publishableKeys: { default: SUPABASE_ANON_KEY } },
    }),
  ],
  async (req, { supabase }) => {
    const handler = createMcpHandler(() => buildMcpServer(supabase));
    return handler.fetch(req);
  },
);

// Exported as single-argument wrappers, not `fetchHandler` directly — Next
// 15's route-handler type-checker inspects the exported function's own
// parameter list and rejects a second parameter typed as a bare `object`
// (it expects `undefined`, or its own `{ params }` RouteContext shape for
// this route's own [[...path]] segment — neither of which this pipeline's
// type produces). Calling `fetchHandler(req)` with no second argument is
// exactly what the pipeline itself expects for a standalone deployment (it
// self-seeds a fresh context) — this changes nothing about runtime
// behavior, and the `path` segment itself is never read: the pipeline
// decides what to serve from the full request URL/method, not from Next's
// parsed route params.
export async function GET(req: Request) { return fetchHandler(req); }
export async function POST(req: Request) { return fetchHandler(req); }
export async function DELETE(req: Request) { return fetchHandler(req); }
export async function OPTIONS(req: Request) { return fetchHandler(req); }
