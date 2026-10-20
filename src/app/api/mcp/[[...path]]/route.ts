// Remote MCP server for Guitar Tracker — READ-ONLY, exactly eight tools:
// search_inventory, get_item_context, get_inventory_analysis,
// get_lead_activity, find_contact_history, get_operations_analysis,
// get_operation_context and get_deal_chain. Built on Supabase's official
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
import { findContactHistoryForUser, ContactHistoryServiceError } from '@/lib/analytics/contactHistoryService';
import { getOperationsAnalysisForUser, getOperationContextForUser, OperationsServiceError, OPERATION_TYPES } from '@/lib/analytics/operationsService';
import { getDealChainForUser } from '@/lib/analytics/dealChainService';

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
        'current picture. Includes complete listing history but NOT lead-demand history — for ' +
        'stale/weak-demand or rotation conclusions, combine it with get_lead_activity (join on item_id).',
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
        'Returns lead/buyer demand by inventory item for the same open-inventory items ' +
        'get_inventory_analysis returns (listed AND unlisted; join on item_id), in three layers: ' +
        '(1) current_period — the individual leads of the newest calendar period (offers, trade ' +
        'items, quality, status, notes), plus ongoing leads first contacted earlier; (2) periods — ' +
        'calendar week (Mon-Sun) or month aggregates for trend comparison; (3) lifetime — the ' +
        "item's full lead history (totals, offers, Serious/High Intent, channels, first/last lead " +
        'dates), independent of the window. Use empty arguments for a normal weekly review ' +
        '(current week + 4 complete prior weeks). Use bucket="month" for month-over-month ' +
        'analysis, or from_date/to_date for a specific range. Recent activity is supplementary ' +
        'evidence and must not be read as complete historical demand — always weigh lifetime. ' +
        'Buckets with is_partial=true are incomplete periods. Items with no leads ever are listed ' +
        'in items_without_leads. For one item\'s complete individual lead history use get_item_context.',
      inputSchema: z.object({
        bucket: z.enum(['week', 'month']).optional()
          .describe('Calendar grouping: "week" (Monday-Sunday, default) or "month" (1st-last day).'),
        periods: z.number().int().min(0).max(52).optional()
          .describe('Number of COMPLETE calendar periods before the current one (default 4). The current, possibly partial, period is always included in addition. Not allowed with from_date/to_date.'),
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('YYYY-MM-DD, inclusive. Switches to explicit-range mode: buckets are the calendar weeks/months intersecting [from_date, to_date], clipped to the range (clipped buckets are is_partial). The last bucket is current_period.'),
        to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('YYYY-MM-DD, inclusive. Requires from_date. Defaults to today; a later date is capped to today.'),
        item_ids: z.array(z.number().int().positive()).optional().describe('Restrict to these inventory item ids.'),
        channel: z.array(z.string().trim().max(100)).optional()
          .describe('Only count leads from these channels (case-insensitive, e.g. "Marketplace", "Kijiji", "Reverb") in all three layers. Omit to get every channel plus by_channel breakdowns.'),
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

  server.registerTool(
    'find_contact_history',
    {
      description:
        "Searches the authenticated user's full historical lead/contact history by contact name. Use this " +
        'when a new buyer/trader contacts the user and you want to know whether they have interacted ' +
        'before, on the same item or another item, and what happened (offers, quality, status, notes, ' +
        'linked completed deal). Includes leads on sold/traded/closed inventory. No time window is ' +
        'applied. Exact matches (same normalized name, and same channel when channel is given), same-name ' +
        'matches on OTHER channels, and conservative possible matches (with match_reason/match_score) are ' +
        'kept separate; only exact matches count as confirmed history. coverage tells how many leads have ' +
        'no recorded contact name and therefore cannot be found. Follow linked_deal_id with get_operation_context.',
      inputSchema: z.object({
        contact_name: z.string().trim().min(1).max(200).describe('The person\'s name as shown in the new message, e.g. "John Smith".'),
        channel: z.string().trim().max(100).optional().describe('DealChannel the new contact came from, e.g. "Marketplace". Same-name leads on other channels are returned separately, not as exact matches.'),
        item_id: z.number().int().positive().optional().describe('The item the new contact is asking about. Only MARKS same-item history (same_item: true); never limits the search.'),
        include_possible_matches: z.boolean().optional().describe('Default true. Set false to return only exact and other-channel matches.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (query) => {
      try {
        const result = await findContactHistoryForUser(supabase, query);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof ContactHistoryServiceError) return { content: [{ type: 'text', text: err.message }], isError: true };
        throw err;
      }
    },
  );

  server.registerTool(
    'get_operations_analysis',
    {
      description:
        'Returns operations/deals and business-performance aggregates for a selected period, with optional ' +
        'DealChannel, operation type, item, brand, category, type and purpose filters. Use this for ' +
        'realized profit, cash-in/out, net cash impact, sales cash, turnover-style and channel-performance ' +
        'questions ("How did September perform?", "Compare Reverb and Kijiji"). Returns summary, ' +
        'by_channel, by_operation_type, every operation row (items in/out with realized gain per item, ' +
        'cash, expenses) and a definitions block. Read definitions before naming a metric: Guitar ' +
        'Tracker has no separate "revenue"/"turnover" metric; exit_value_total (assigned value out of ' +
        'Sell/Trade, includes non-cash trade value) and sales_cash_received are the closest. Default ' +
        'period when both dates are omitted: the last 6 months ending today (same as the Operations ' +
        'screen default); the effective period is always returned. Filters combine with AND across ' +
        'fields and OR within a field. Use get_operation_context(deal_id) for one operation in depth.',
      inputSchema: z.object({
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, inclusive. If only to_date is given, defaults to 6 months before it.'),
        to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, inclusive. Defaults to today (America/Toronto).'),
        channel: z.array(z.string().trim().max(100)).optional().describe('DealChannel names, case-insensitive, e.g. ["Marketplace","Reverb"]. "No channel" matches operations with none. Omit for all channels.'),
        operation_type: z.array(z.enum(OPERATION_TYPES)).optional().describe('Stored operation types: purchase (Buy), sale (Sell), trade, expense, or the legacy Historical Import/Purchase/Trade. Omit for all.'),
        item_ids: z.array(z.number().int().positive()).optional().describe('Only operations involving at least one of these items.'),
        brand: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) brand names; an operation matches if any involved item matches.'),
        category: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) item category names.'),
        type: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) item type (subtype) names.'),
        purpose: z.array(z.string().trim().max(100)).optional().describe('Exact (case-insensitive) purpose names, e.g. "Business".'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (filters) => {
      try {
        const result = await getOperationsAnalysisForUser(supabase, filters);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof OperationsServiceError) return { content: [{ type: 'text', text: err.message }], isError: true };
        throw err;
      }
    },
  );

  server.registerTool(
    'get_operation_context',
    {
      description:
        'Returns the full authoritative context for one Guitar Tracker deal/operation (the /operations/[id] ' +
        'page): date, type, DealChannel, notes, a plain-language Gave/Received summary, every item given ' +
        '(with value out, cost, expenses, realized gain/ROI and where it was acquired) and received (with ' +
        'assigned value, estimate, potential reward and any later disposal), cash paid/received, cash ' +
        'impact, linked expenses, cash-flow entries, realized profit and any leads linked to this deal. ' +
        'Only works for an operation belonging to the signed-in user; any other id behaves exactly like ' +
        'a nonexistent one.',
      inputSchema: z.object({
        deal_id: z.number().int().positive().describe('The operation deal id, e.g. from get_operations_analysis or a lead linked_deal_id.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ deal_id }) => {
      const result = await getOperationContextForUser(supabase, deal_id);
      if (result === null) return { content: [{ type: 'text', text: 'Operation not found.' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'get_deal_chain',
    {
      description:
        'Returns the complete trade/sale lineage for one inventory item using Guitar Tracker\'s Trade ' +
        'Chain logic (the /inventory/[id]/chain page): the item\'s chronological lineage steps (what was ' +
        'given and received in each deal, cash, step and running profit), the full capital tree from the ' +
        'original acquisition including multi-item trade siblings, and the Capital Summary (total ' +
        'invested, cash extracted, current assets, profit, ROI; real cash only). Use for "what did this ' +
        'guitar turn into?" or "how much cash did this chain generate?". No time filter. Only works for ' +
        'an item belonging to the signed-in user.',
      inputSchema: z.object({
        item_id: z.number().int().positive().describe('Any inventory item in the chain, e.g. from search_inventory.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ item_id }) => {
      const result = await getDealChainForUser(supabase, item_id);
      if (result === null) return { content: [{ type: 'text', text: 'Item not found.' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
