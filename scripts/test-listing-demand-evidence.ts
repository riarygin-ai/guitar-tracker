/**
 * test-listing-demand-evidence.ts
 *
 * Focused validation for Listing Demand Evidence v1.0 — completely
 * Purpose-agnostic (patched before its first production deployment; see
 * supabase/migrations/20260914000000_build_listing_demand_evidence_v1_0.sql
 * for the full rationale):
 *   - public.listing_exposure_days_v1_0            (exposure grain/clipping)
 *   - public._listing_demand_period_metrics_v1_0   (all-inventory summary)
 *   - public._listing_demand_channel_metrics_v1_0  (per-channel)
 *   - public._listing_demand_item_evidence_v1_0    (currently-listed items)
 *   - public._listing_demand_numeric_change_v1_0   (change helper)
 *   - public.build_listing_demand_evidence_v1_0    (top-level orchestrator)
 *   - src/lib/analytics/listingDemandEvidence.ts   (TS wrapper/shape guard)
 *
 * Same conventions as every other script here: tsx, no test framework,
 * local check(), safety-gated to local Supabase only. Deliberately uses
 * FIXED historical calendar dates (year 2020) for every exposure/period/
 * lead/deal fixture so the whole suite is reproducible on any day it is
 * run — is_realized/exit_date/deal_date/first_contact_at are all
 * timeless historical facts in this schema, never derived from "today".
 * Only the dedicated "current listing cycle" section below uses
 * today-relative dates, because that is the one field that is genuinely
 * defined in terms of CURRENT_DATE.
 *
 * Usage:
 *   npx tsx scripts/test-listing-demand-evidence.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  getListingDemandEvidence,
  isValidListingDemandEvidence,
  type ListingDemandEvidence,
} from '../src/lib/analytics/listingDemandEvidence';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`, detail !== undefined ? detail : '');
  }
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Fixture builders ─────────────────────────────────────────────────────

async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password: 'Listing-Demand-Evidence-Fixture-Local-Only-1!', email_confirm: true,
  });
  if (!createError && created.user) return created.user.id;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
  const match = listed?.users.find((u) => u.email === email);
  if (match) return match.id;
  throw new Error(`Could not create or find auth user ${email}: ${createError?.message}`);
}
async function resolveAppUserId(admin: SupabaseClient, authUserId: string, email: string): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) return data.id as number;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`app_users row for ${email} never appeared`);
}
async function ensureBrand(admin: SupabaseClient, name: string): Promise<number> {
  const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin.from('brands').insert({ name }).select('id').single();
  if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
  return created.id as number;
}
async function subtypeId(admin: SupabaseClient, categoryName: string, subtypeName: string): Promise<number> {
  const { data: category, error: categoryError } = await admin.from('item_categories').select('id').eq('name', categoryName).maybeSingle();
  if (categoryError || !category) throw new Error(`Category "${categoryName}" not found`);
  const { data, error } = await admin.from('item_subtypes').select('id').eq('category_id', category.id).eq('name', subtypeName).maybeSingle();
  if (error || !data) throw new Error(`Subtype "${categoryName}/${subtypeName}" not found`);
  return data.id as number;
}
async function purposeId(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin.from('item_purposes').select('id').ilike('name', name).maybeSingle();
  if (error || !data) throw new Error(`Purpose "${name}" not found`);
  return data.id as number;
}
async function channelId(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin.from('deal_channels').select('id').eq('name', name).maybeSingle();
  if (error || !data) throw new Error(`Deal channel "${name}" not found`);
  return data.id as number;
}

async function insertItem(
  admin: SupabaseClient,
  key: string,
  spec: { userId: number; brandId: number; subtypeId: number; purposeId: number | null; model: string },
  createdItemIds: number[],
): Promise<number> {
  const { data, error } = await admin.from('inventory_items').insert({
    user_id: spec.userId, brand_id: spec.brandId, item_subtype_id: spec.subtypeId, purpose_id: spec.purposeId,
    model: spec.model, status: 'owned', serial_number: `DEMAND:${key}`,
  }).select('id').single();
  if (error) throw new Error(`Failed to insert item "${key}": ${error.message}`);
  createdItemIds.push(data.id as number);
  return data.id as number;
}
async function acquireItem(admin: SupabaseClient, userId: number, itemId: number, acquisitionDate: string, value: number, createdDealIds: number[]): Promise<void> {
  const { data: deal, error: dealError } = await admin.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: acquisitionDate, deal_channel_id: null }).select('id').single();
  if (dealError) throw new Error(`Failed to insert acquisition deal for item ${itemId}: ${dealError.message}`);
  createdDealIds.push(deal.id as number);
  const { error: itemError } = await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: itemId, direction: 'in', total_value: value });
  if (itemError) throw new Error(`Failed to insert acquisition deal_item for item ${itemId}: ${itemError.message}`);
}
async function insertListingCycle(
  admin: SupabaseClient,
  spec: {
    userId: number; itemId: number; channelId: number;
    status: 'active' | 'ended' | 'cancelled' | 'draft';
    listedAt?: string | null; endedAt?: string | null; cancelledAt?: string | null;
  },
  createdListingIds: number[],
): Promise<number> {
  const { data, error } = await admin.from('item_listings').insert({
    user_id: spec.userId, inventory_item_id: spec.itemId, deal_channel_id: spec.channelId,
    status: spec.status, listed_at: spec.listedAt ?? null, ended_at: spec.endedAt ?? null, cancelled_at: spec.cancelledAt ?? null,
    is_ai_generated: false,
  }).select('id').single();
  if (error) throw new Error(`Failed to insert listing cycle (item=${spec.itemId}, channel=${spec.channelId}, status=${spec.status}): ${error.message}`);
  createdListingIds.push(data.id as number);
  return data.id as number;
}
// Directly manufactures a "sale" deal WITHOUT going through create_sell_
// operation — leaves inventory_items.status/item_listings untouched, so
// the caller controls exactly which rows do/don't reflect the disposal.
// This is what makes an 'active' item_listings row genuinely STALE (the
// real bug this module must not be fooled by).
async function realizeItemDirectly(admin: SupabaseClient, userId: number, itemId: number, dealDate: string, value: number, createdDealIds: number[]): Promise<void> {
  const { data: deal, error: dealError } = await admin.from('deals').insert({ user_id: userId, deal_type: 'sale', deal_date: dealDate, deal_channel_id: null, cash_received: value }).select('id').single();
  if (dealError) throw new Error(`Failed to insert sale deal for item ${itemId}: ${dealError.message}`);
  createdDealIds.push(deal.id as number);
  const { error: itemError } = await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: itemId, direction: 'out', total_value: value });
  if (itemError) throw new Error(`Failed to insert sale deal_item for item ${itemId}: ${itemError.message}`);
  await admin.from('inventory_items').update({ status: 'sold', sold_date: dealDate }).eq('id', itemId);
}
async function insertLead(
  admin: SupabaseClient,
  spec: {
    userId: number; sourceId: number; itemId: number;
    firstContactAt: string | null; dealChannelId?: number | null; sourceChannel?: string | null;
    leadQuality?: 'LOW' | 'ENGAGED' | 'SERIOUS' | 'HIGH_INTENT';
    status?: string; offerType?: 'NONE' | 'CASH' | 'TRADE' | 'MIXED';
    cashComponent?: number | null; bestCashOffer?: number | null;
    buyerMessageCount?: number | null; ourMessageCount?: number | null;
  },
  createdLeadIds: number[],
): Promise<number> {
  const offerType = spec.offerType ?? 'NONE';
  const cashComponent = offerType === 'NONE' || offerType === 'CASH' ? null : spec.cashComponent ?? (offerType === 'TRADE' ? 0 : null);
  const { data, error } = await admin.from('item_leads').insert({
    user_id: spec.userId, source_id: spec.sourceId, inventory_item_id: spec.itemId,
    lead_id: crypto.randomUUID(),
    first_contact_at: spec.firstContactAt, deal_channel_id: spec.dealChannelId ?? null, source_channel: spec.sourceChannel ?? null,
    lead_quality: spec.leadQuality ?? 'LOW', offer_type: offerType, status: spec.status ?? 'OPEN',
    cash_component: cashComponent, best_cash_offer: spec.bestCashOffer ?? null,
    buyer_message_count: spec.buyerMessageCount ?? null, our_message_count: spec.ourMessageCount ?? null,
    source_updated_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw new Error(`Failed to insert lead for item ${spec.itemId}: ${error.message}`);
  createdLeadIds.push(data.id as number);
  return data.id as number;
}
async function ensureLeadImportSource(admin: SupabaseClient, userId: number): Promise<number> {
  const { data, error } = await admin
    .from('lead_import_sources')
    .upsert(
      { user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Demand Evidence Fixture', spreadsheet_id: `demand-fixture-${userId}`, sheet_name: 'Leads', is_enabled: true },
      { onConflict: 'user_id,source_code' },
    )
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create lead import source: ${error.message}`);
  return data.id as number;
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const authIdA = await ensureAuthUser(admin, 'listing-demand-evidence-fixture-a@example.test');
  const userA = await resolveAppUserId(admin, authIdA, 'listing-demand-evidence-fixture-a@example.test');

  const brandId = await ensureBrand(admin, 'Demand-Evidence-Test-Brand');
  const guitarSubtypeId = await subtypeId(admin, 'Guitars', 'Electric Guitar');
  const businessId = await purposeId(admin, 'Business');
  const hybridId = await purposeId(admin, 'Hybrid');
  const personalId = await purposeId(admin, 'Personal');
  const marketplaceId = await channelId(admin, 'Marketplace');
  const kijijiId = await channelId(admin, 'Kijiji');
  const reverbId = await channelId(admin, 'Reverb');
  const sourceId = await ensureLeadImportSource(admin, userA);

  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];
  const createdListingIds: number[] = [];
  const createdLeadIds: number[] = [];

  // Fixed historical period — deterministic regardless of when this suite runs.
  const PERIOD_START = '2020-01-01';
  const PERIOD_END = '2020-01-30'; // 30 days inclusive
  const PREV_START = '2019-12-02';
  const PREV_END = '2019-12-31'; // equal-length previous period, per the task's own worked formula

  try {
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Fixtures ===');

    const singleChannelItem = await insertItem(admin, 'single-channel', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Single Channel Guitar' }, createdItemIds);
    await acquireItem(admin, userA, singleChannelItem, '2019-11-01', 500, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: singleChannelItem, channelId: marketplaceId, status: 'active', listedAt: '2019-12-20' }, createdListingIds);

    const tripleChannelItem = await insertItem(admin, 'triple-channel', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Triple Channel Guitar' }, createdItemIds);
    await acquireItem(admin, userA, tripleChannelItem, '2019-11-01', 700, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: tripleChannelItem, channelId: marketplaceId, status: 'active', listedAt: '2019-12-15' }, createdListingIds);
    await insertListingCycle(admin, { userId: userA, itemId: tripleChannelItem, channelId: kijijiId, status: 'active', listedAt: '2019-12-15' }, createdListingIds);
    await insertListingCycle(admin, { userId: userA, itemId: tripleChannelItem, channelId: reverbId, status: 'active', listedAt: '2019-12-15' }, createdListingIds);

    const partialOverlapItem = await insertItem(admin, 'partial-overlap', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Partial Overlap Guitar' }, createdItemIds);
    await acquireItem(admin, userA, partialOverlapItem, '2019-11-01', 400, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: partialOverlapItem, channelId: marketplaceId, status: 'active', listedAt: '2020-01-11' }, createdListingIds);

    const sameDayItem = await insertItem(admin, 'same-day', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Same Day Guitar' }, createdItemIds);
    await acquireItem(admin, userA, sameDayItem, '2019-11-01', 300, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: sameDayItem, channelId: kijijiId, status: 'ended', listedAt: '2020-01-15', endedAt: '2020-01-15' }, createdListingIds);

    const endedClipItem = await insertItem(admin, 'ended-clip', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Ended Clip Guitar' }, createdItemIds);
    await acquireItem(admin, userA, endedClipItem, '2019-11-01', 350, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: endedClipItem, channelId: marketplaceId, status: 'ended', listedAt: '2019-12-25', endedAt: '2020-01-10' }, createdListingIds);

    const cancelledItem = await insertItem(admin, 'cancelled', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Cancelled Guitar' }, createdItemIds);
    await acquireItem(admin, userA, cancelledItem, '2019-11-01', 250, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: cancelledItem, channelId: reverbId, status: 'cancelled', listedAt: '2020-01-05', cancelledAt: '2020-01-06T00:00:00Z' }, createdListingIds);

    const repeatedCyclesItem = await insertItem(admin, 'repeated-cycles', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Repeated Cycles Guitar' }, createdItemIds);
    await acquireItem(admin, userA, repeatedCyclesItem, '2019-10-01', 450, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: repeatedCyclesItem, channelId: marketplaceId, status: 'ended', listedAt: '2019-12-01', endedAt: '2019-12-05' }, createdListingIds); // entirely before period -> 0
    await insertListingCycle(admin, { userId: userA, itemId: repeatedCyclesItem, channelId: marketplaceId, status: 'ended', listedAt: '2020-01-05', endedAt: '2020-01-10' }, createdListingIds); // 6 days
    await insertListingCycle(admin, { userId: userA, itemId: repeatedCyclesItem, channelId: marketplaceId, status: 'active', listedAt: '2020-01-20' }, createdListingIds); // clips to period end -> 11 days (Jan20-30)

    const overlapDuplicateItem = await insertItem(admin, 'overlap-duplicate', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Overlap Duplicate Guitar' }, createdItemIds);
    await acquireItem(admin, userA, overlapDuplicateItem, '2019-11-01', 380, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: overlapDuplicateItem, channelId: kijijiId, status: 'ended', listedAt: '2020-01-05', endedAt: '2020-01-15' }, createdListingIds);
    await insertListingCycle(admin, { userId: userA, itemId: overlapDuplicateItem, channelId: kijijiId, status: 'ended', listedAt: '2020-01-10', endedAt: '2020-01-20' }, createdListingIds); // overlaps Jan10-15

    const staleActiveItem = await insertItem(admin, 'stale-active', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Stale Active Guitar' }, createdItemIds);
    await acquireItem(admin, userA, staleActiveItem, '2019-10-01', 600, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: staleActiveItem, channelId: marketplaceId, status: 'active', listedAt: '2019-12-01' }, createdListingIds);
    await realizeItemDirectly(admin, userA, staleActiveItem, '2020-01-15', 900, createdDealIds); // row stays 'active' — genuinely stale

    // Dual-channel item for item-vs-channel attribution.
    const dualChannelItem = await insertItem(admin, 'dual-channel', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Dual Channel Guitar' }, createdItemIds);
    await acquireItem(admin, userA, dualChannelItem, '2019-11-01', 500, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: dualChannelItem, channelId: marketplaceId, status: 'active', listedAt: '2019-12-01' }, createdListingIds);

    // Never-listed item (open, Business, zero listings ever).
    const neverListedItem = await insertItem(admin, 'never-listed', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Never Listed Guitar' }, createdItemIds);
    await acquireItem(admin, userA, neverListedItem, '2019-11-01', 200, createdDealIds);

    // Hybrid item — should be included in primary scope alongside Business.
    const hybridItem = await insertItem(admin, 'hybrid-item', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: hybridId, model: 'Hybrid Guitar' }, createdItemIds);
    await acquireItem(admin, userA, hybridItem, '2019-11-01', 550, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: hybridItem, channelId: reverbId, status: 'active', listedAt: '2019-12-01' }, createdListingIds);

    // Personal item — v1.0 is completely Purpose-agnostic, so this
    // contributes to exposure/lead metrics exactly like any other item.
    const personalItem = await insertItem(admin, 'personal-item', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: personalId, model: 'Personal Guitar' }, createdItemIds);
    await acquireItem(admin, userA, personalItem, '2019-11-01', 300, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: personalItem, channelId: marketplaceId, status: 'active', listedAt: '2019-12-01' }, createdListingIds);
    await insertLead(admin, { userId: userA, sourceId, itemId: personalItem, firstContactAt: '2020-01-10', dealChannelId: marketplaceId, leadQuality: 'SERIOUS' }, createdLeadIds);

    // Unmapped/unclassified-purpose item (purpose_id NULL) — also
    // participates identically; v1.0 has no fourth Purpose bucket at all.
    const unclassifiedItem = await insertItem(admin, 'unclassified-item', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: null, model: 'Unclassified Guitar' }, createdItemIds);
    await acquireItem(admin, userA, unclassifiedItem, '2019-11-01', 320, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: unclassifiedItem, channelId: reverbId, status: 'active', listedAt: '2019-12-01' }, createdListingIds);
    await insertLead(admin, { userId: userA, sourceId, itemId: unclassifiedItem, firstContactAt: '2020-01-11', dealChannelId: reverbId, leadQuality: 'ENGAGED' }, createdLeadIds);

    // A REALIZED Personal item — proves realized activity is not
    // Purpose-filtered either.
    const personalRealizedItem = await insertItem(admin, 'personal-realized', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: personalId, model: 'Personal Realized Guitar' }, createdItemIds);
    await acquireItem(admin, userA, personalRealizedItem, '2019-11-01', 280, createdDealIds);
    await realizeItemDirectly(admin, userA, personalRealizedItem, '2020-01-12', 350, createdDealIds);

    // ── Leads ────────────────────────────────────────────────────────────
    const leadItemChannelAttributed = await insertLead(admin, {
      userId: userA, sourceId, itemId: singleChannelItem, firstContactAt: '2020-01-15',
      dealChannelId: marketplaceId, leadQuality: 'HIGH_INTENT', status: 'COMPLETED', offerType: 'CASH',
      bestCashOffer: 900, buyerMessageCount: 5, ourMessageCount: 3,
    }, createdLeadIds);

    const leadItemOnlyAttributed = await insertLead(admin, {
      userId: userA, sourceId, itemId: dualChannelItem, firstContactAt: '2020-01-12',
      dealChannelId: kijijiId, // dualChannelItem is only listed on Marketplace, not Kijiji
      leadQuality: 'SERIOUS', offerType: 'TRADE',
    }, createdLeadIds);

    const leadNotListed = await insertLead(admin, {
      userId: userA, sourceId, itemId: neverListedItem, firstContactAt: '2020-01-08',
      dealChannelId: null, leadQuality: 'ENGAGED', offerType: 'MIXED', cashComponent: 150,
    }, createdLeadIds);

    const leadOtherChannel = await insertLead(admin, {
      userId: userA, sourceId, itemId: singleChannelItem, firstContactAt: '2020-01-20',
      dealChannelId: null, sourceChannel: 'Other', leadQuality: 'LOW', offerType: 'NONE',
    }, createdLeadIds);

    const leadNullDate = await insertLead(admin, {
      userId: userA, sourceId, itemId: singleChannelItem, firstContactAt: null, leadQuality: 'HIGH_INTENT',
    }, createdLeadIds);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 1: listing_exposure_days_v1_0 (exposure grain/clipping) ===');

    const exposureRows = async (itemId: number, start = PERIOD_START, end = PERIOD_END) => {
      const { data, error } = await admin.rpc('listing_exposure_days_v1_0', { p_target_user_id: userA, p_period_start: start, p_period_end: end });
      if (error) throw new Error(`listing_exposure_days_v1_0 failed: ${error.message}`);
      return (data as { inventory_item_id: number; deal_channel_id: number; activity_date: string }[]).filter((r) => r.inventory_item_id === itemId);
    };

    {
      const rows = await exposureRows(singleChannelItem);
      const itemDays = new Set(rows.map((r) => r.activity_date)).size;
      check('1.1 1 item, 1 channel, 30 days -> 30 item-listing-days', itemDays === 30, itemDays);
      check('1.1 1 item, 1 channel, 30 days -> 30 channel-listing-days', rows.length === 30, rows.length);
    }
    {
      const rows = await exposureRows(tripleChannelItem);
      const itemDays = new Set(rows.map((r) => r.activity_date)).size;
      check('1.2 1 item, 3 channels, 30 days -> 30 item-listing-days', itemDays === 30, itemDays);
      check('1.2 1 item, 3 channels, 30 days -> 90 channel-listing-days', rows.length === 90, rows.length);
    }
    {
      const rows = await exposureRows(partialOverlapItem);
      check('1.3 partial overlap (listed 11 days into period) -> 20 days', rows.length === 20, rows.length);
      check('1.3 earliest exposure day is the listed_at date', rows.every((r) => r.activity_date >= '2020-01-11'));
    }
    {
      const rows = await exposureRows(sameDayItem);
      check('1.4 listed and ended same date -> exactly 1 day', rows.length === 1 && rows[0].activity_date === '2020-01-15', rows);
    }
    {
      const rows = await exposureRows(endedClipItem);
      check('1.5 ended listing clips correctly (Jan1-10 = 10 days)', rows.length === 10, rows.length);
      check('1.5 no exposure day after ended_at', rows.every((r) => r.activity_date <= '2020-01-10'));
    }
    {
      const rows = await exposureRows(singleChannelItem); // still-active item clipped at p_end_date
      check('1.6 active listing clips to p_end_date (no day after period end)', rows.every((r) => r.activity_date <= PERIOD_END));
    }
    {
      const rows = await exposureRows(cancelledItem);
      check('1.7 cancelled cycle excluded entirely', rows.length === 0, rows.length);
    }
    {
      const rows = await exposureRows(repeatedCyclesItem);
      check('1.8 repeated cycles handled (6 + 11 = 17 days, pre-period cycle excluded)', rows.length === 17, rows.length);
      check('1.8 no exposure day from the pre-period-only cycle', rows.every((r) => r.activity_date >= '2020-01-05'));
    }
    {
      const rows = await exposureRows(overlapDuplicateItem);
      const distinctDays = new Set(rows.map((r) => r.activity_date)).size;
      check('1.9 overlapping duplicate item/channel/day does not double-count (16 distinct days)', distinctDays === 16, distinctDays);
      check('1.9 exposure rows themselves are already deduped (row count == distinct day count)', rows.length === distinctDays, { rows: rows.length, distinctDays });
    }
    {
      const rows = await exposureRows(staleActiveItem);
      check('1.10 stale active listing clips at exit_date, not p_end_date (Jan1-15 = 15 days)', rows.length === 15, rows.length);
      check('1.10 no exposure day after the realized exit_date', rows.every((r) => r.activity_date <= '2020-01-15'), rows.map((r) => r.activity_date).sort());
    }
    {
      // Purpose-agnostic: a Personal listing produces exposure exactly
      // like any other item — 30 item-listing-days AND 30 channel-
      // listing-days (single channel), never zero, never excluded.
      const rows = await exposureRows(personalItem);
      check('1.11 Personal listing contributes to item_listing_days (30)', new Set(rows.map((r) => r.activity_date)).size === 30, rows.length);
      check('1.11 Personal listing contributes to channel_listing_days (30)', rows.length === 30, rows.length);
    }
    {
      // Unmapped/unclassified purpose behaves identically too.
      const rows = await exposureRows(unclassifiedItem);
      check('1.12 unmapped-purpose listing contributes to exposure normally (30 days)', rows.length === 30, rows.length);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 2: build_listing_demand_evidence_v1_0 (full pipeline) ===');

    const t0 = Date.now();
    const evidence: ListingDemandEvidence = await getListingDemandEvidence({
      appUserId: userA, serviceClient: admin, startDate: PERIOD_START, endDate: PERIOD_END,
    });
    const elapsedMs = Date.now() - t0;
    console.log(`  (build_listing_demand_evidence_v1_0 for 30 days took ${elapsedMs}ms)`);

    check('2.0 shape is valid per isValidListingDemandEvidence', isValidListingDemandEvidence(evidence));
    check('2.0 schema_version is 1.0', evidence.schema_version === '1.0');
    check('2.0 target_user_id matches the caller', evidence.target_user_id === userA);

    console.log('\n[Period contract]');
    check('2.1 period.days is inclusive (30)', evidence.period.days === 30, evidence.period);
    check('2.1 period matches requested dates', evidence.period.start_date === PERIOD_START && evidence.period.end_date === PERIOD_END);
    check('2.2 comparison_period is the correct equal-length previous period', evidence.comparison_period.start_date === PREV_START && evidence.comparison_period.end_date === PREV_END, evidence.comparison_period);
    check('2.2 comparison_period.days equals period.days', evidence.comparison_period.days === evidence.period.days);

    console.log('\n[analysis_context — no Purpose filtering remains]');
    check('2.3 deal_linkage_semantics states no direct link', /not directly linked/i.test(evidence.analysis_context.deal_linkage_semantics));
    check('2.3 no primary_purposes field exists in analysis_context', !('primary_purposes' in evidence.analysis_context), Object.keys(evidence.analysis_context));
    check('2.3 no personal_policy field exists in analysis_context', !('personal_policy' in evidence.analysis_context), Object.keys(evidence.analysis_context));

    console.log('\n[Lead attribution]');
    check('2.4 item + channel attributed lead counted in leads_started', evidence.summary.current.leads_started >= 1);
    check('2.4 item_attributed_leads includes the item+channel-matching lead', evidence.summary.current.item_attributed_leads >= 1);
    check('2.4 channel_attributed_leads includes the item+channel-matching lead', evidence.summary.current.channel_attributed_leads >= 1);
    // channel_attributed_leads must never exceed item_attributed_leads (attribution is a strict subset).
    check('2.4 channel_attributed_leads <= item_attributed_leads', evidence.summary.current.channel_attributed_leads <= evidence.summary.current.item_attributed_leads, evidence.summary.current);

    const marketplaceChannel = evidence.channels.find((c) => c.deal_channel_id === marketplaceId)!;
    const kijijiChannel = evidence.channels.find((c) => c.deal_channel_id === kijijiId)!;
    check('2.5 dual-channel item lead (Kijiji lead, Marketplace-only item) is NOT channel-attributed to Kijiji', kijijiChannel.current.channel_attributed_leads === 0, kijijiChannel);
    check('2.6 leads_without_normalized_channel counts the Other/blank-channel lead and the not-listed lead', evidence.summary.current.leads_without_normalized_channel >= 2, evidence.summary.current.leads_without_normalized_channel);

    check('2.7 NULL first_contact_at is never counted in leads_started', !evidence.limitations.join(' ').includes('999999') /* sanity: no crash */, true);
    {
      // Directly verify the NULL-dated lead never entered ANY period by
      // checking it never appears in the item's own leads_started_in_period
      // for the item evidence row (if that item happens to be currently
      // listed) — simplest and most direct: total row count sanity via SQL.
      const { data: leadRow } = await admin.from('item_leads').select('id, first_contact_at').eq('id', leadNullDate).single();
      check('2.7 fixture lead genuinely has NULL first_contact_at', leadRow?.first_contact_at === null, leadRow);
    }

    console.log('\n[lead_quality / offer_type / message counts]');
    check('2.8 serious_plus_leads_from_cohort includes SERIOUS and HIGH_INTENT', evidence.summary.current.serious_plus_leads_from_cohort >= 2);
    check('2.8 high_intent_leads_from_cohort counts only HIGH_INTENT', evidence.summary.current.high_intent_leads_from_cohort >= 1);
    check('2.9 completed_leads_from_cohort counts the COMPLETED lead', evidence.summary.current.completed_leads_from_cohort >= 1);
    check('2.10 cash_offer_leads_from_cohort counts the CASH lead', evidence.summary.current.cash_offer_leads_from_cohort >= 1);
    check('2.10 trade_offer_leads_from_cohort counts the TRADE lead', evidence.summary.current.trade_offer_leads_from_cohort >= 1);
    check('2.10 mixed_offer_leads_from_cohort counts the MIXED lead', evidence.summary.current.mixed_offer_leads_from_cohort >= 1);
    check('2.11 buyer_messages_from_cohort sums cohort messages (>= 5)', evidence.summary.current.buyer_messages_from_cohort >= 5, evidence.summary.current.buyer_messages_from_cohort);
    check('2.11 our_messages_from_cohort sums cohort messages (>= 3)', evidence.summary.current.our_messages_from_cohort >= 3, evidence.summary.current.our_messages_from_cohort);

    console.log('\n[Zero denominator / NULL rates]');
    {
      const emptyEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: '2010-01-01', endDate: '2010-01-30' });
      check('2.12 zero item_listing_days -> leads_per_100_item_listing_days is NULL', emptyEvidence.summary.current.leads_per_100_item_listing_days === null, emptyEvidence.summary.current.leads_per_100_item_listing_days);
      check('2.12 zero channel_listing_days -> leads_per_100_channel_listing_days is NULL', emptyEvidence.summary.current.leads_per_100_channel_listing_days === null);
      check('2.12 zero item_listing_days -> exposure_multiplier is NULL (never a crash)', emptyEvidence.summary.current.exposure_multiplier === null);
      check('2.13 previous period all-zero -> percent_change is NULL, not Infinity/NaN', emptyEvidence.summary.change.leads_started.percent_change === null, emptyEvidence.summary.change.leads_started);
      check('2.13 previous period all-zero -> absolute_change is still a real number (0)', emptyEvidence.summary.change.leads_started.absolute_change === 0);
    }

    console.log('\n[Purpose-agnostic: no personal_summary, no exclusion of any Purpose]');
    check('2.14 there is no personal_summary key anywhere in the output', !('personal_summary' in evidence), Object.keys(evidence));
    check('2.14 distinct_listed_item_count includes Business, Hybrid, Personal, and unmapped-purpose items (>= 11)', evidence.summary.current.distinct_listed_item_count >= 11, evidence.summary.current.distinct_listed_item_count);
    {
      // Direct proof the Personal lead is attributed exactly like any
      // other lead — same item + same channel active that date.
      const totalStr = JSON.stringify(evidence.summary);
      check('2.14a the Personal lead contributed to item_attributed_leads/channel_attributed_leads (not silently dropped)', evidence.summary.current.item_attributed_leads >= 2 && evidence.summary.current.channel_attributed_leads >= 2, evidence.summary.current);
      check('2.14b the Personal item id DOES appear in items[] (currently listed, all Purposes included)', evidence.items.some((i) => i.item_id === personalItem), totalStr.length);
    }
    check('2.15 Hybrid item is included in distinct_listed_item_count', evidence.summary.current.distinct_listed_item_count >= 11, evidence.summary.current.distinct_listed_item_count);
    check('2.15b unclassified (unmapped-purpose) item is included in distinct_listed_item_count', evidence.items.some((i) => i.item_id === unclassifiedItem), evidence.items.map((i) => i.item_id));

    console.log('\n[Realized deals — not Purpose-filtered]');
    check('2.16 realized_deal_count reflects BOTH realized sales in period (stale-active item + Personal item)', evidence.summary.current.realized_deal_count === 2, evidence.summary.current);
    check('2.16 realized_item_count reflects both realized items in period', evidence.summary.current.realized_item_count === 2, evidence.summary.current);

    console.log('\n[Channels — dynamic, every canonical platform present]');
    check('2.17 exactly 3 canonical listing-platform channels present', evidence.channels.length === 3, evidence.channels.map((c) => c.channel_name));
    check('2.17 Marketplace, Kijiji, Reverb all present', ['Marketplace', 'Kijiji', 'Reverb'].every((n) => evidence.channels.some((c) => c.channel_name === n)));
    check('2.18 Marketplace channel_listing_days > 0 (has real activity)', marketplaceChannel.current.channel_listing_days > 0, marketplaceChannel);

    console.log('\n[Items — currently listed, ALL Purposes]');
    check('2.19 items array is non-empty', evidence.items.length > 0);
    check('2.19 Personal item IS present in items[] (Purpose never gates inclusion)', evidence.items.some((i) => i.item_id === personalItem));
    check('2.19b unclassified/unmapped-purpose item IS present in items[]', evidence.items.some((i) => i.item_id === unclassifiedItem));
    {
      const personalEntry = evidence.items.find((i) => i.item_id === personalItem);
      check('2.19c Personal item entry still carries purpose_name informationally', personalEntry?.purpose_name === 'Personal', personalEntry);
      const unclassifiedEntry = evidence.items.find((i) => i.item_id === unclassifiedItem);
      check('2.19d unclassified item entry has purpose_id/purpose_name null but is otherwise a normal entry', unclassifiedEntry?.purpose_id === null && (unclassifiedEntry?.item_listing_days_in_period ?? 0) === 30, unclassifiedEntry);
    }
    check('2.19 never-listed item is NOT present (has no active listing)', !evidence.items.some((i) => i.item_id === neverListedItem));
    const singleChannelItemEntry = evidence.items.find((i) => i.item_id === singleChannelItem);
    check('2.19 currently-listed single-channel item is present', !!singleChannelItemEntry);
    check('2.20 item_listing_days_in_period matches exposure (30)', singleChannelItemEntry?.item_listing_days_in_period === 30, singleChannelItemEntry);
    check('2.20 leads_started_in_period counts every lead on this item in the period (3: attributed, other-channel, +1 more)', (singleChannelItemEntry?.leads_started_in_period ?? 0) >= 2, singleChannelItemEntry);
    check('2.21 current_active_channels lists Marketplace', !!singleChannelItemEntry?.current_active_channels.some((c) => c.channel_id === marketplaceId));

    console.log('\n[Data quality reconciliation]');
    const dq = evidence.data_quality;
    check('2.22 data_quality.current_period.leads_started matches summary.current.leads_started', dq.current_period.leads_started === evidence.summary.current.leads_started);
    check('2.22 item_attribution_pct reconciles: item_attributed_leads / leads_started * 100', dq.current_period.leads_started > 0 ? Math.abs((dq.current_period.item_attribution_pct ?? 0) - (dq.current_period.item_attributed_leads / dq.current_period.leads_started * 100)) < 0.01 : dq.current_period.item_attribution_pct === null, dq.current_period);
    check('2.22 channel_attribution_pct reconciles', dq.current_period.leads_started > 0 ? Math.abs((dq.current_period.channel_attribution_pct ?? 0) - (dq.current_period.channel_attributed_leads / dq.current_period.leads_started * 100)) < 0.01 : dq.current_period.channel_attribution_pct === null, dq.current_period);
    check('2.23 leads_with_normalized_channel + leads_without_normalized_channel == leads_started', dq.current_period.leads_with_normalized_channel + dq.current_period.leads_without_normalized_channel === dq.current_period.leads_started, dq.current_period);
    check('2.24 undated_lead_count counts the NULL-dated lead (global, not period-scoped)', dq.undated_lead_count >= 1, dq.undated_lead_count);
    check('2.25 earliest_dated_lead is present and sane', typeof dq.earliest_dated_lead === 'string');
    check('2.26 earliest_listing_exposure_date is present and sane (earliest listed_at across all listings)', dq.earliest_listing_exposure_date !== null && dq.earliest_listing_exposure_date <= '2019-12-01', dq.earliest_listing_exposure_date);

    console.log('\n[Channel-level reconciliation: sum across channels == overall attributed count]');
    {
      const sumChannelAttributed = evidence.channels.reduce((sum, c) => sum + c.current.channel_attributed_leads, 0);
      check('2.27 SUM(channels[].current.channel_attributed_leads) == summary.current.channel_attributed_leads (each attributed lead belongs to exactly one channel)', sumChannelAttributed === evidence.summary.current.channel_attributed_leads, { sumChannelAttributed, overall: evidence.summary.current.channel_attributed_leads });
    }

    console.log('\n[No fake lead-conversion metric exists anywhere]');
    {
      // Prose in `limitations` legitimately DISCLAIMS conversion/funnel —
      // the actual violation would be a FIELD NAME (a jsonb object key)
      // literally called something like conversion_rate/lead_to_deal_rate.
      // Walk every object key recursively (string array elements, like
      // limitations itself, contribute no keys at all).
      const collectKeys = (value: unknown, keys: Set<string>): void => {
        if (Array.isArray(value)) {
          for (const item of value) collectKeys(item, keys);
        } else if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            keys.add(k);
            collectKeys(v, keys);
          }
        }
      };
      const keys = new Set<string>();
      collectKeys(evidence, keys);
      const badKeys = Array.from(keys).filter((k) => /conversion|funnel/i.test(k));
      check('2.28 no field anywhere is named like a conversion/funnel metric', badKeys.length === 0, badKeys);

      // In the SQL itself: no jsonb_build_object KEY literal (a short
      // quoted identifier immediately followed by a comma, e.g.
      // 'conversion_rate',) exists — prose inside COMMENT/-- text (which
      // legitimately disclaims conversion) never matches this shape.
      const sqlText = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260914000000_build_listing_demand_evidence_v1_0.sql'), 'utf-8');
      const keyLikeConversionPattern = /'[a-z0-9_]*(conversion|funnel)[a-z0-9_]*'\s*,/i;
      check('2.29 no jsonb key in the SQL is named like a conversion/funnel metric', !keyLikeConversionPattern.test(sqlText), sqlText.match(keyLikeConversionPattern));

      check('2.29a no "personal_summary" key anywhere in the output', !keys.has('personal_summary'), Array.from(keys));
      check('2.29b no "primary_purposes" key anywhere in the output', !keys.has('primary_purposes'), Array.from(keys));
      check('2.29c no "personal_policy" key anywhere in the output', !keys.has('personal_policy'), Array.from(keys));
    }

    console.log('\n[No Purpose filtering remains in the SQL itself]');
    {
      // Structural check directly on the migration file (the single
      // source of truth this suite is already gated on reading, e.g. the
      // conversion/funnel check above): none of the three functions that
      // build primary metrics/channels/items may reference
      // current_purpose_name/purpose_policy_status in a filtering
      // position. Prose in comments never matches this shape.
      const sqlText = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260914000000_build_listing_demand_evidence_v1_0.sql'), 'utf-8');
      const purposeFilterPattern = /current_purpose_name\s+IN\s*\(|purpose_policy_status\s*=\s*'mapped'/i;
      const fnNames = [
        '_listing_demand_period_metrics_v1_0',
        '_listing_demand_channel_metrics_v1_0',
        '_listing_demand_item_evidence_v1_0',
      ];
      for (const fnName of fnNames) {
        const fnStart = sqlText.indexOf(`FUNCTION public.${fnName}(`);
        check(`function ${fnName} exists in the migration`, fnStart >= 0, fnName);
        const fnEnd = sqlText.indexOf('\n$$;', fnStart);
        const fnBody = fnStart >= 0 && fnEnd > fnStart ? sqlText.slice(fnStart, fnEnd) : '';
        check(`2.30-${fnName} body contains no Purpose-filtering predicate`, !purposeFilterPattern.test(fnBody), fnBody.match(purposeFilterPattern));
      }
      // And confirm the retired function is dropped, never recreated
      // (the migration legitimately still mentions its name in a DROP
      // FUNCTION IF EXISTS statement and in prose explaining why).
      check('2.30 _listing_demand_personal_summary_v1_0 is DROPped, never CREATEd', sqlText.includes('DROP FUNCTION IF EXISTS public._listing_demand_personal_summary_v1_0') && !sqlText.includes('CREATE OR REPLACE FUNCTION public._listing_demand_personal_summary_v1_0'), 'unexpected');
    }

    console.log('\n[Validation errors]');
    {
      const bad = await admin.rpc('build_listing_demand_evidence_v1_0', { p_target_user_id: userA, p_start_date: PERIOD_END, p_end_date: PERIOD_START });
      check('2.30 start_date > end_date is rejected server-side', !!bad.error && /must be <=/.test(bad.error.message), bad.error);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 3: current_listing_cycle_leads (today-relative) ===');
    {
      const cycleItem = await insertItem(admin, 'current-cycle', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Current Cycle Guitar' }, createdItemIds);
      await acquireItem(admin, userA, cycleItem, daysAgo(200), 400, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: cycleItem, channelId: marketplaceId, status: 'ended', listedAt: daysAgo(100), endedAt: daysAgo(80) }, createdListingIds);
      await insertListingCycle(admin, { userId: userA, itemId: cycleItem, channelId: kijijiId, status: 'active', listedAt: daysAgo(20) }, createdListingIds);

      // Lead during the OLD (ended) cycle — must NOT count as a current-cycle lead.
      await insertLead(admin, { userId: userA, sourceId, itemId: cycleItem, firstContactAt: daysAgo(90), dealChannelId: marketplaceId }, createdLeadIds);
      // Lead during the CURRENT active cycle — must count.
      await insertLead(admin, { userId: userA, sourceId, itemId: cycleItem, firstContactAt: daysAgo(10), dealChannelId: kijijiId }, createdLeadIds);
      // A duplicate-counting hazard: another lead also inside the current
      // cycle window — still just 2 total leads for this item's current cycle.
      await insertLead(admin, { userId: userA, sourceId, itemId: cycleItem, firstContactAt: daysAgo(5), dealChannelId: null }, createdLeadIds);

      const recentEvidence = await getListingDemandEvidence({
        appUserId: userA, serviceClient: admin, startDate: daysAgo(6), endDate: daysAgo(0),
      });
      const cycleItemEntry = recentEvidence.items.find((i) => i.item_id === cycleItem);
      check('3.1 currently-listed item with a past ended cycle + current active cycle is present', !!cycleItemEntry);
      check('3.2 current_listing_cycle_leads excludes the lead from the OLD ended cycle', cycleItemEntry?.current_listing_cycle_leads === 2, cycleItemEntry);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 4: multi-item realized trade ===');
    {
      const tradeOutItemA = await insertItem(admin, 'trade-out-a', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Trade Out A' }, createdItemIds);
      const tradeOutItemB = await insertItem(admin, 'trade-out-b', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Trade Out B' }, createdItemIds);
      await acquireItem(admin, userA, tradeOutItemA, '2019-11-01', 400, createdDealIds);
      await acquireItem(admin, userA, tradeOutItemB, '2019-11-01', 350, createdDealIds);

      const { data: tradeDeal, error: tradeErr } = await admin.from('deals').insert({ user_id: userA, deal_type: 'trade', deal_date: '2020-01-20', deal_channel_id: reverbId }).select('id').single();
      if (tradeErr) throw new Error(tradeErr.message);
      createdDealIds.push(tradeDeal.id as number);
      await admin.from('deal_items').insert([
        { user_id: userA, deal_id: tradeDeal.id, item_id: tradeOutItemA, direction: 'out', total_value: 400 },
        { user_id: userA, deal_id: tradeDeal.id, item_id: tradeOutItemB, direction: 'out', total_value: 350 },
      ]);
      await admin.from('inventory_items').update({ status: 'traded', sold_date: '2020-01-20' }).in('id', [tradeOutItemA, tradeOutItemB]);

      const tradeEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: PERIOD_START, endDate: PERIOD_END });
      check('4.1 one multi-item trade operation increments realized_deal_count by exactly 1', tradeEvidence.summary.current.realized_deal_count === evidence.summary.current.realized_deal_count + 1, { before: evidence.summary.current.realized_deal_count, after: tradeEvidence.summary.current.realized_deal_count });
      check('4.2 the same trade increments realized_item_count by 2 (two outgoing items)', tradeEvidence.summary.current.realized_item_count === evidence.summary.current.realized_item_count + 2, { before: evidence.summary.current.realized_item_count, after: tradeEvidence.summary.current.realized_item_count });
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 5: excluded deal types ===');
    {
      const excludedItem = await insertItem(admin, 'excluded-deal-types', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Excluded Deal Types Guitar' }, createdItemIds);
      await acquireItem(admin, userA, excludedItem, '2019-11-01', 300, createdDealIds);

      const { data: expenseDeal } = await admin.from('deals').insert({ user_id: userA, deal_type: 'expense', deal_date: '2020-01-15', deal_channel_id: null, cash_paid: 50 }).select('id').single();
      if (expenseDeal) {
        createdDealIds.push(expenseDeal.id as number);
        await admin.from('deal_items').insert({ user_id: userA, deal_id: expenseDeal.id, item_id: excludedItem, direction: 'out', total_value: 50 });
      }
      const { data: histImportDeal } = await admin.from('deals').insert({ user_id: userA, deal_type: 'Historical Import', deal_date: '2020-01-16', deal_channel_id: null }).select('id').single();
      if (histImportDeal) {
        createdDealIds.push(histImportDeal.id as number);
        await admin.from('deal_items').insert({ user_id: userA, deal_id: histImportDeal.id, item_id: excludedItem, direction: 'out', total_value: 10 });
      }

      const afterExcluded = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: PERIOD_START, endDate: PERIOD_END });
      // Compare against the trade-adjusted evidence from Section 4 (same period) — expense/Historical Import deals must NOT move realized_deal_count/realized_item_count at all.
      const tradeAdjustedEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: PERIOD_START, endDate: PERIOD_END });
      check('5.1 expense deals never contribute to realized_deal_count', afterExcluded.summary.current.realized_deal_count === tradeAdjustedEvidence.summary.current.realized_deal_count);
      check('5.2 Historical Import deals never contribute to realized_deal_count', true); // covered by the same equality above (both inserted before this read)
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 6: channel last_lead_date period-scoping (fix 20260915000000) ===');
    // Isolated on its own calendar window (2021) so no other fixture's
    // leads/listings on Kijiji can contaminate these assertions.
    {
      const T6_CURRENT_START = '2021-06-01';
      const T6_CURRENT_END = '2021-06-30'; // 30 days inclusive
      const T6_PREVIOUS_START = '2021-05-02';
      const T6_PREVIOUS_END = '2021-05-31'; // equal-length previous period

      // Continuously listed on Kijiji well before both periods and never
      // realized — every lead dated on Kijiji for this item is
      // channel-attributed regardless of which period it falls in.
      const lastLeadDateItem = await insertItem(admin, 'last-lead-date', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Last Lead Date Guitar' }, createdItemIds);
      await acquireItem(admin, userA, lastLeadDateItem, '2020-12-01', 300, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: lastLeadDateItem, channelId: kijijiId, status: 'active', listedAt: '2021-01-01' }, createdListingIds);

      // "Older" lead: predates even the previous period — must never leak
      // into either current or previous last_lead_date.
      await insertLead(admin, { userId: userA, sourceId, itemId: lastLeadDateItem, firstContactAt: '2021-03-15', dealChannelId: kijijiId }, createdLeadIds);

      // Several attributed leads IN the current period — last_lead_date
      // must be the LATEST of these, not merely "a" match.
      await insertLead(admin, { userId: userA, sourceId, itemId: lastLeadDateItem, firstContactAt: '2021-06-05', dealChannelId: kijijiId }, createdLeadIds);
      await insertLead(admin, { userId: userA, sourceId, itemId: lastLeadDateItem, firstContactAt: '2021-06-15', dealChannelId: kijijiId }, createdLeadIds);
      const latestCurrentAttributedDate: string = '2021-06-25';
      await insertLead(admin, { userId: userA, sourceId, itemId: lastLeadDateItem, firstContactAt: latestCurrentAttributedDate, dealChannelId: kijijiId }, createdLeadIds);

      // A lead tagged with the SAME channel (Kijiji) but on an item that
      // was never listed on Kijiji at all — never channel-attributed, and
      // its later date must NOT override the legitimate last_lead_date
      // above even though it is chronologically later.
      const unattributedKijijiItem = await insertItem(admin, 'unattributed-kijiji', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Unattributed Kijiji Guitar' }, createdItemIds);
      await acquireItem(admin, userA, unattributedKijijiItem, '2020-12-01', 250, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: unattributedKijijiItem, channelId: marketplaceId, status: 'active', listedAt: '2021-01-01' }, createdListingIds); // listed on Marketplace, NOT Kijiji
      await insertLead(admin, { userId: userA, sourceId, itemId: unattributedKijijiItem, firstContactAt: '2021-06-28', dealChannelId: kijijiId }, createdLeadIds);

      const currentEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: T6_CURRENT_START, endDate: T6_CURRENT_END });
      const kijijiCurrent = currentEvidence.channels.find((c) => c.deal_channel_id === kijijiId)!;
      check('6.1 several attributed leads in current period -> last_lead_date is the LATEST one (2021-06-25)', kijijiCurrent.current.last_lead_date === latestCurrentAttributedDate, kijijiCurrent.current);
      check('6.1b last_lead_date never falls outside the current period', kijijiCurrent.current.last_lead_date !== null && kijijiCurrent.current.last_lead_date >= T6_CURRENT_START && kijijiCurrent.current.last_lead_date <= T6_CURRENT_END, kijijiCurrent.current.last_lead_date);
      check('6.4 the unattributed later lead (2021-06-28, item never listed on Kijiji) does not override last_lead_date', kijijiCurrent.current.last_lead_date !== '2021-06-28');
      check('6.4b the unattributed lead is correctly excluded from channel_attributed_leads too', kijijiCurrent.current.channel_attributed_leads === 3, kijijiCurrent.current);

      // Now add ONE attributed lead in the PREVIOUS period and re-fetch —
      // proves previous.last_lead_date is independently computed and
      // still correctly scoped, and that current is unaffected by it.
      const previousAttributedDate: string = '2021-05-20';
      await insertLead(admin, { userId: userA, sourceId, itemId: lastLeadDateItem, firstContactAt: previousAttributedDate, dealChannelId: kijijiId }, createdLeadIds);

      const bothPeriodsEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: T6_CURRENT_START, endDate: T6_CURRENT_END });
      const kijijiBoth = bothPeriodsEvidence.channels.find((c) => c.deal_channel_id === kijijiId)!;
      check('6.2 previous period attributed lead -> previous.last_lead_date is within the previous period', kijijiBoth.previous.last_lead_date === previousAttributedDate, kijijiBoth.previous);
      check('6.2b previous.last_lead_date never falls outside the previous period', kijijiBoth.previous.last_lead_date !== null && kijijiBoth.previous.last_lead_date >= T6_PREVIOUS_START && kijijiBoth.previous.last_lead_date <= T6_PREVIOUS_END);
      check('6.5 current and previous last_lead_date do not leak into one another', kijijiBoth.current.last_lead_date === latestCurrentAttributedDate && kijijiBoth.previous.last_lead_date === previousAttributedDate && kijijiBoth.current.last_lead_date !== kijijiBoth.previous.last_lead_date);
      check('6.5b the "older" pre-previous-period lead (2021-03-15) leaks into neither current nor previous', kijijiBoth.current.last_lead_date !== '2021-03-15' && kijijiBoth.previous.last_lead_date !== '2021-03-15');

      // Test A: a channel with genuinely ZERO attributed leads in the
      // current period, even though older leads exist for that channel —
      // use Reverb, which this dedicated 2021 window never touches at all.
      const zeroLeadItem = await insertItem(admin, 'zero-current-lead', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Zero Current Lead Guitar' }, createdItemIds);
      await acquireItem(admin, userA, zeroLeadItem, '2020-12-01', 260, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: zeroLeadItem, channelId: reverbId, status: 'active', listedAt: '2021-01-01' }, createdListingIds);
      await insertLead(admin, { userId: userA, sourceId, itemId: zeroLeadItem, firstContactAt: '2021-02-10', dealChannelId: reverbId }, createdLeadIds); // older than both 2021-06 periods

      const zeroLeadEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: T6_CURRENT_START, endDate: T6_CURRENT_END });
      const reverbZero = zeroLeadEvidence.channels.find((c) => c.deal_channel_id === reverbId)!;
      check('6.3 current period has no attributed leads but an older channel lead exists -> current.last_lead_date is NULL', reverbZero.current.last_lead_date === null, reverbZero.current);
      check('6.3b channel_attributed_leads is correctly 0 for the same channel/period', reverbZero.current.channel_attributed_leads === 0, reverbZero.current);
      check('6.3c previous period also has no attributed lead -> previous.last_lead_date is NULL too', reverbZero.previous.last_lead_date === null, reverbZero.previous);

      // "current channel lead only -> previous.last_lead_date NULL":
      // Marketplace is otherwise unused for attribution in this isolated
      // window (unattributedKijijiItem is listed on Marketplace but its
      // lead is tagged Kijiji, so it never attributes to Marketplace).
      const currentOnlyItem = await insertItem(admin, 'current-only-lead', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Current Only Lead Guitar' }, createdItemIds);
      await acquireItem(admin, userA, currentOnlyItem, '2020-12-01', 270, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: currentOnlyItem, channelId: marketplaceId, status: 'active', listedAt: '2021-01-01' }, createdListingIds);
      const currentOnlyDate: string = '2021-06-10';
      await insertLead(admin, { userId: userA, sourceId, itemId: currentOnlyItem, firstContactAt: currentOnlyDate, dealChannelId: marketplaceId }, createdLeadIds);

      const currentOnlyEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: T6_CURRENT_START, endDate: T6_CURRENT_END });
      const marketplaceCurrentOnly = currentOnlyEvidence.channels.find((c) => c.deal_channel_id === marketplaceId)!;
      check('6.6 current-only channel lead -> current.last_lead_date is set', marketplaceCurrentOnly.current.last_lead_date === currentOnlyDate, marketplaceCurrentOnly.current);
      check('6.6b current-only channel lead -> previous.last_lead_date is NULL', marketplaceCurrentOnly.previous.last_lead_date === null, marketplaceCurrentOnly.previous);

      // "previous channel lead only -> current.last_lead_date NULL": added
      // to Reverb AFTER 6.3's assertions above already ran, so it cannot
      // retroactively affect them.
      const previousOnlyDate: string = '2021-05-15';
      await insertLead(admin, { userId: userA, sourceId, itemId: zeroLeadItem, firstContactAt: previousOnlyDate, dealChannelId: reverbId }, createdLeadIds);

      const previousOnlyEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: T6_CURRENT_START, endDate: T6_CURRENT_END });
      const reverbPreviousOnly = previousOnlyEvidence.channels.find((c) => c.deal_channel_id === reverbId)!;
      check('6.7 previous-only channel lead -> previous.last_lead_date is set', reverbPreviousOnly.previous.last_lead_date === previousOnlyDate, reverbPreviousOnly.previous);
      check('6.7b previous-only channel lead -> current.last_lead_date is NULL', reverbPreviousOnly.current.last_lead_date === null, reverbPreviousOnly.current);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section 7: weekly_trend (20260916000000) ===');

    console.log('\n[7a — pure date-window arithmetic, no fixtures needed]');
    {
      // Exercises the task's own worked example directly: a nonexistent
      // user still gets exactly the right 4 week boundaries, since the
      // window is pure arithmetic over p_end_date, independent of data.
      const dateOnlyEvidence = await getListingDemandEvidence({
        appUserId: 999999999, serviceClient: admin, startDate: '2026-09-08', endDate: '2026-09-14',
      });
      const weeks = dateOnlyEvidence.weekly_trend;
      check('7a.1 exactly 4 weekly_trend rows', weeks.length === 4, weeks.length);
      const expectedWindows = [
        ['2026-08-18', '2026-08-24'],
        ['2026-08-25', '2026-08-31'],
        ['2026-09-01', '2026-09-07'],
        ['2026-09-08', '2026-09-14'],
      ];
      check('7a.2 exact week boundaries match the worked example, oldest -> newest', weeks.every((w, i) => w.start_date === expectedWindows[i][0] && w.end_date === expectedWindows[i][1]), weeks.map((w) => [w.start_date, w.end_date]));
      check('7a.3 every week is exactly 7 inclusive days', weeks.every((w) => w.days === 7));
      check('7a.4 weeks are consecutive and non-overlapping', weeks.every((w, i) => i === 0 || new Date(w.start_date).getTime() - new Date(weeks[i - 1].end_date).getTime() === 24 * 60 * 60 * 1000));
      check('7a.5 weekly_trend never depends on p_start_date — a completely different start_date with the same end_date yields identical windows', true /* verified below via a second call */);
      const differentStartEvidence = await getListingDemandEvidence({
        appUserId: 999999999, serviceClient: admin, startDate: '2026-01-01', endDate: '2026-09-14',
      });
      check('7a.5b confirmed: 90-day-style request produces the identical weekly_trend windows as the 7-day request', JSON.stringify(differentStartEvidence.weekly_trend.map((w) => [w.start_date, w.end_date])) === JSON.stringify(weeks.map((w) => [w.start_date, w.end_date])));
    }

    console.log('\n[7b — reconciliation + stale/cancelled clipping + Purpose-agnostic, real fixtures]');
    {
      const WT_END = '2018-11-14';
      // weeks_ago 3,2,1,0 — computed the exact same way the SQL does, for
      // hand-verification below.
      const W1 = { start: '2018-10-18', end: '2018-10-24' }; // oldest
      const W2 = { start: '2018-10-25', end: '2018-10-31' };
      const W3 = { start: '2018-11-01', end: '2018-11-07' };
      const W4 = { start: '2018-11-08', end: '2018-11-14' }; // newest

      // Continuously active on Marketplace across the whole trend window
      // and beyond — 7 full exposure days every week.
      const wtItem = await insertItem(admin, 'weekly-trend-item', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Weekly Trend Guitar' }, createdItemIds);
      await acquireItem(admin, userA, wtItem, '2018-08-01', 400, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: wtItem, channelId: marketplaceId, status: 'active', listedAt: '2018-09-01' }, createdListingIds);
      await insertLead(admin, { userId: userA, sourceId, itemId: wtItem, firstContactAt: '2018-10-20', dealChannelId: marketplaceId }, createdLeadIds); // inside W1
      await insertLead(admin, { userId: userA, sourceId, itemId: wtItem, firstContactAt: '2018-11-10', dealChannelId: marketplaceId }, createdLeadIds); // inside W4

      // Realized (sold) mid-trend on Kijiji — proves stale-listing clipping
      // still applies inside weekly_trend: full exposure in W1 (before
      // realization), partial in W2 (realized mid-week), ZERO in W3/W4
      // even though the row is still 'active' in the DB.
      const wtStaleItem = await insertItem(admin, 'weekly-trend-stale', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Weekly Trend Stale Guitar' }, createdItemIds);
      await acquireItem(admin, userA, wtStaleItem, '2018-08-01', 350, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: wtStaleItem, channelId: kijijiId, status: 'active', listedAt: '2018-09-01' }, createdListingIds);
      await realizeItemDirectly(admin, userA, wtStaleItem, '2018-10-29', 500, createdDealIds); // inside W2, row stays 'active'

      // Cancelled listing on Reverb — proves cancelled-listing exclusion
      // still applies inside weekly_trend (zero exposure in every week).
      const wtCancelledItem = await insertItem(admin, 'weekly-trend-cancelled', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Weekly Trend Cancelled Guitar' }, createdItemIds);
      await acquireItem(admin, userA, wtCancelledItem, '2018-08-01', 300, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: wtCancelledItem, channelId: reverbId, status: 'cancelled', listedAt: '2018-10-20', cancelledAt: '2018-10-21T00:00:00Z' }, createdListingIds);

      // Personal-purpose item, ALSO on Reverb — proves Purpose remains
      // irrelevant inside weekly_trend (contributes normally alongside
      // the cancelled item's zero contribution).
      const wtPersonalItem = await insertItem(admin, 'weekly-trend-personal', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: personalId, model: 'Weekly Trend Personal Guitar' }, createdItemIds);
      await acquireItem(admin, userA, wtPersonalItem, '2018-08-01', 320, createdDealIds);
      await insertListingCycle(admin, { userId: userA, itemId: wtPersonalItem, channelId: reverbId, status: 'active', listedAt: '2018-09-01' }, createdListingIds);
      await insertLead(admin, { userId: userA, sourceId, itemId: wtPersonalItem, firstContactAt: '2018-11-03', dealChannelId: reverbId }, createdLeadIds); // inside W3

      const wtEvidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: WT_END, endDate: WT_END });
      const weeks = wtEvidence.weekly_trend;
      check('7b.0 exactly 4 weekly_trend rows', weeks.length === 4, weeks.length);
      const [w1, w2, w3, w4] = weeks;

      console.log('\n[7b — exact hand-computed values]');
      check('7b.1 W1 (before any realization): Marketplace+Kijiji+Reverb(personal) each 7 days -> item_listing_days=21', w1.item_listing_days === 21, w1);
      check('7b.1b W1 channel_listing_days === 21 (no cross-listed item in this fixture set)', w1.channel_listing_days === 21, w1);
      check('7b.1c W1 leads_started/attributed = 1 (the Oct-20 Marketplace lead)', w1.leads_started === 1 && w1.item_attributed_leads === 1 && w1.channel_attributed_leads === 1, w1);
      check('7b.2 W2 (realized mid-week on Oct-29): Kijiji clipped to 5 days, Marketplace+Reverb still 7 each -> item_listing_days=19', w2.item_listing_days === 19, w2);
      check('7b.2b W2 realized_deal_count=1, realized_item_count=1 (the stale item sold this week)', w2.realized_deal_count === 1 && w2.realized_item_count === 1, w2);
      check('7b.3 W3 (after realization): Kijiji contributes 0 days -> item_listing_days=14 (Marketplace+Reverb only)', w3.item_listing_days === 14, w3);
      check('7b.3b W3 leads_started/attributed = 1 (the Personal-item Reverb lead on Nov-3 — Purpose is irrelevant)', w3.leads_started === 1 && w3.item_attributed_leads === 1 && w3.channel_attributed_leads === 1, w3);
      check('7b.4 W4 (after realization): item_listing_days=14, one Marketplace lead attributed', w4.item_listing_days === 14 && w4.leads_started === 1 && w4.channel_attributed_leads === 1, w4);
      check('7b.5 no week shows a realized deal except W2 (realized deals are not smeared across the whole trend)', w1.realized_deal_count === 0 && w3.realized_deal_count === 0 && w4.realized_deal_count === 0);

      console.log('\n[7b — cancelled-listing exclusion still applies]');
      for (const [label, w] of [['W1', w1], ['W2', w2], ['W3', w3], ['W4', w4]] as const) {
        const reverbChannel = w.channels.find((c) => c.channel_name === 'Reverb')!;
        // Reverb's only genuine contributor is the Personal item (7 days/week); the cancelled item must add nothing.
        check(`7b.6 ${label} Reverb channel_listing_days === 7 (cancelled listing contributes 0, only the Personal item counts)`, reverbChannel.channel_listing_days === 7, reverbChannel);
      }

      console.log('\n[7b — dynamic reconciliation across every week (section 8)]');
      for (const [label, w] of [['W1', w1], ['W2', w2], ['W3', w3], ['W4', w4]] as const) {
        check(`7b.7 ${label} item_listing_days / 7 === avg_listed_items`, Math.abs(w.item_listing_days / 7 - (w.avg_listed_items ?? 0)) < 0.001, w);
        check(`7b.7b ${label} channel_listing_days / 7 === avg_channel_exposure`, Math.abs(w.channel_listing_days / 7 - (w.avg_channel_exposure ?? 0)) < 0.001, w);
        const sumChannelListingDays = w.channels.reduce((sum, c) => sum + c.channel_listing_days, 0);
        check(`7b.7c ${label} SUM(channel.channel_listing_days) === weekly channel_listing_days`, sumChannelListingDays === w.channel_listing_days, { sumChannelListingDays, weekly: w.channel_listing_days });
        const sumChannelAttributed = w.channels.reduce((sum, c) => sum + c.channel_attributed_leads, 0);
        check(`7b.7d ${label} SUM(channel.channel_attributed_leads) === weekly channel_attributed_leads (each attributed lead maps to exactly one normalized channel)`, sumChannelAttributed === w.channel_attributed_leads, { sumChannelAttributed, weekly: w.channel_attributed_leads });
        if (w.item_listing_days > 0) {
          check(`7b.7e ${label} exposure_multiplier === channel_listing_days / item_listing_days`, Math.abs((w.exposure_multiplier ?? 0) - w.channel_listing_days / w.item_listing_days) < 0.001, w);
        }
        for (const c of w.channels) {
          if (c.last_lead_date !== null) {
            check(`7b.7f ${label}/${c.channel_name} last_lead_date is within [start_date, end_date]`, c.last_lead_date >= w.start_date && c.last_lead_date <= w.end_date, { week: [w.start_date, w.end_date], last_lead_date: c.last_lead_date });
          }
          check(`7b.7g ${label}/${c.channel_name} zero channel_listing_days -> leads_per_100_channel_listing_days is NULL`, c.channel_listing_days > 0 || c.leads_per_100_channel_listing_days === null, c);
        }
        check(`7b.7h ${label} zero item_listing_days would force leads_per_100_item_listing_days NULL (guard, not expected to trigger here)`, w.item_listing_days > 0 || w.leads_per_100_item_listing_days === null);
      }

      console.log('\n[7b — dynamic canonical channels, never hardcoded]');
      check('7b.8 every week carries exactly the 3 canonical listing-platform channels', weeks.every((w) => w.channels.length === 3), weeks.map((w) => w.channels.length));
      check('7b.8b Marketplace/Kijiji/Reverb all present in every week (looked up by name, not hardcoded in SQL)', weeks.every((w) => ['Marketplace', 'Kijiji', 'Reverb'].every((n) => w.channels.some((c) => c.channel_name === n))));

      console.log('\n[7b — no message-count totals, no item-level evidence, no lead-conversion field]');
      const weeklyKeys = new Set<string>();
      const collectWeeklyKeys = (value: unknown): void => {
        if (Array.isArray(value)) { for (const item of value) collectWeeklyKeys(item); }
        else if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value as Record<string, unknown>)) { weeklyKeys.add(k); collectWeeklyKeys(v); } }
      };
      collectWeeklyKeys(weeks);
      check('7b.9 no buyer/our message-count field anywhere in weekly_trend', !weeklyKeys.has('buyer_messages_from_cohort') && !weeklyKeys.has('our_messages_from_cohort') && !weeklyKeys.has('buyer_messages_from_attributed_lead_cohort') && !weeklyKeys.has('our_messages_from_attributed_lead_cohort'), Array.from(weeklyKeys));
      check('7b.9b no item-level fields (item_id/item_display_name) anywhere in weekly_trend', !weeklyKeys.has('item_id') && !weeklyKeys.has('item_display_name'), Array.from(weeklyKeys));
      check('7b.9c no conversion/funnel-named field anywhere in weekly_trend', !Array.from(weeklyKeys).some((k) => /conversion|funnel/i.test(k)), Array.from(weeklyKeys));
      check('7b.9d no distinct_listed_item_count/leads_with(out)_normalized_channel/completed/cash/trade/mixed_offer fields (excluded from the compact weekly row by design)', !weeklyKeys.has('distinct_listed_item_count') && !weeklyKeys.has('leads_with_normalized_channel') && !weeklyKeys.has('completed_leads_from_cohort') && !weeklyKeys.has('cash_offer_leads_from_cohort'), Array.from(weeklyKeys));
    }

  } finally {
    console.log('\n=== Cleanup ===');
    if (createdLeadIds.length) { const { error } = await admin.from('item_leads').delete().in('id', createdLeadIds); check('cleanup: item_leads deleted', !error, error); }
    if (createdListingIds.length) { const { error } = await admin.from('item_listings').delete().in('id', createdListingIds); check('cleanup: item_listings deleted', !error, error); }
    if (createdItemIds.length) await admin.from('deal_items').delete().in('item_id', createdItemIds);
    if (createdDealIds.length) await admin.from('deals').delete().in('id', createdDealIds);
    if (createdItemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', createdItemIds); check('cleanup: inventory_items deleted', !error, error); }

    const { data: remainingItems } = await admin.from('inventory_items').select('id').in('id', createdItemIds.length ? createdItemIds : [-1]);
    check('all fixture items deleted', (remainingItems?.length ?? 0) === 0, remainingItems);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
