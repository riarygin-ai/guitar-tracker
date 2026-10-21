/**
 * backfill-lead-semantics.ts — one-time historical backfill for the direct
 * lead writes model (migration 20261021000003_lead_semantics_backfill_function).
 *
 * Usage:
 *   npx tsx scripts/backfill-lead-semantics.ts --target=local|production [--mode=report|apply] [--show-names] [--no-audit]
 *
 * --mode=report (default) is READ-ONLY: it computes and prints exactly what
 * apply would change. --mode=apply calls apply_lead_semantics_backfill_v1 ONCE
 * (one transaction; leads that already have a LEGACY_SNAPSHOT are skipped, so
 * re-running is safe) and then verifies. Writes only with service_role.
 *
 * Per lead:
 *   - peak_stage: the 2026-10-21 read-only classification audit
 *     (scripts/data/lead-stage-audit-2026-10-21.json) → LEGACY_AUDIT; leads
 *     the audit did not cover → legacyStructuredStage() → LEGACY_STRUCTURED.
 *   - negotiation_rounds / offer_is_concrete / latest_cash_offer / contact_key.
 *   - parenthetical qualifier restoration for NOTES_PREFIX_V1 names whose
 *     note prefix was "<name> (<qualifier>) — …" (stripped by 20261020).
 *   - ONE LEGACY_SNAPSHOT event (baseline; no reconstructed chronology).
 *   - OPEN leads on sold/traded items → CLOSED / ITEM_UNAVAILABLE.
 * Reported but NEVER changed: duplicate pairs, leads missing from the latest
 * sheet import, ambiguous identities, DECLINED_BY_ME + FOUND_ANOTHER rows.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { contactKey, baseChannelKey, legacyStructuredStage } from '../src/lib/leads/classification';
import { buildLegacyPayload, type LeadSnapshotRow } from '../src/lib/leads/leadWriteService';
import { SEMANTICS_VERSION, type LeadStage } from '../src/lib/leads/semantics';

const root = path.join(__dirname, '..');
const CODE_TO_STAGE: Record<string, LeadStage> = { I: 'INQUIRY', E: 'ENGAGED', N1: 'NEGOTIATING', N2: 'NEGOTIATING', H: 'HIGH_INTENT', C: 'CONVERTED' };

interface Config { target: string; mode: string; showNames: boolean; url: string; key: string; audit: { leads: Record<string, { stage: string; confidence: string }> } }

function loadConfig(): Config {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
  const target = args.target;
  const mode = args.mode ?? 'report';
  if (target !== 'local' && target !== 'production') { console.error('--target=local|production is required'); process.exit(2); }
  if (mode !== 'report' && mode !== 'apply') { console.error('--mode must be report or apply'); process.exit(2); }
  let url: string, key: string;
  if (target === 'production') {
    dotenv.config({ path: path.join(root, '.env.local') });
    url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (/127\.0\.0\.1|localhost/.test(url)) throw new Error('target=production but .env.local points at a local URL');
  } else {
    url = process.env.LOCAL_SUPABASE_URL ?? 'http://127.0.0.1:54321';
    key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!key) throw new Error('LOCAL_SUPABASE_SERVICE_ROLE_KEY is required for --target=local');
    if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error('target=local must point at a local URL');
    // Local ids do not correspond to the production audit ids.
    if (args['no-audit'] !== 'true') { console.error('--target=local requires --no-audit (audit ids are production ids)'); process.exit(2); }
  }
  const audit = args['no-audit'] === 'true' ? { leads: {} } : JSON.parse(fs.readFileSync(path.join(root, 'scripts/data/lead-stage-audit-2026-10-21.json'), 'utf8'));
  return { target, mode, showNames: args['show-names'] === 'true', url, key, audit };
}

async function all<T>(db: SupabaseClient, table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from(table).select(cols).order('id').range(offset, offset + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type Row = LeadSnapshotRow & { contact_name_source: string | null; created_at: string; source_id: number | null };

/** "Nick (collector) — …" + stored "Nick" → "Nick (collector)". Deterministic or null. */
export function restoredQualifierName(notes: string | null, stored: string | null): string | null {
  if (!notes || !stored) return null;
  const m = notes.trim().match(/^(.+?)\s+—\s/);
  if (!m || m[1].includes('—')) return null;
  const q = m[1].match(/^(.*\S)\s*\(([^()]+)\)\s*$/);
  if (!q) return null;
  const base = q[1].replace(/\s+/g, ' ').trim();
  if (base !== stored.trim()) return null;
  return `${base} (${q[2].replace(/\s+/g, ' ').trim()})`;
}

async function main() {
  const { target, mode, showNames, url, key, audit } = loadConfig();
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  console.log(`[backfill] target=${target} mode=${mode} url=${url.replace(/^https?:\/\//, '').split('.')[0]}…`);

  const LEGACY_COLS = 'id, user_id, inventory_item_id, lead_id, source_id, source_channel, deal_channel_id, contact_name, contact_name_source, lead_quality, status, outcome_reason, deal_id, offer_type, initial_cash_offer, best_cash_offer, trade_item, cash_component, trade_est_value, buyer_message_count, our_message_count, first_contact_at, last_contact_at, notes, created_at';
  const NEW_COLS = 'channel_detail, contact_key, latest_cash_offer, offer_is_concrete, offer_assessment, offer_assessment_source, last_inbound_at, last_outbound_at, waiting_on, unanswered_followups, reopen_count, peak_stage, peak_stage_source, peak_stage_at, negotiation_rounds, origin, last_write_source, version, semantics_version';
  const probe = await db.from('item_leads').select('peak_stage').limit(1);
  const migrated = !probe.error;
  if (!migrated && mode === 'apply') throw new Error('schema not migrated (item_leads.peak_stage missing) — apply migrations 20261021000000..03 first');
  if (!migrated) console.log('[backfill] schema NOT migrated yet — report computed from legacy columns only');
  const leads = (await all<Row>(db, 'item_leads', migrated ? `${LEGACY_COLS}, ${NEW_COLS}` : LEGACY_COLS))
    .map((l) => ({ ...l, origin: l.origin ?? 'SHEET', negotiation_rounds: l.negotiation_rounds ?? 0, unanswered_followups: l.unanswered_followups ?? 0, reopen_count: l.reopen_count ?? 0 }));
  const items = await all<{ id: number; status: string }>(db, 'inventory_items', 'id, status');
  const itemStatus = new Map(items.map((i) => [i.id, i.status]));
  const snaps = migrated ? (await all<{ id: number; item_lead_id: number; event_type: string }>(db, 'lead_events', 'id, item_lead_id, event_type')).filter((e) => e.event_type === 'LEGACY_SNAPSHOT') : [];
  const snapped = new Set(snaps.map((s) => s.item_lead_id));
  const runs = await all<{ id: number; source_id: number }>(db, 'lead_import_runs', 'id, source_id');
  const latestRunBySource = new Map<number, number>();
  for (const r of runs) latestRunBySource.set(r.source_id, Math.max(latestRunBySource.get(r.source_id) ?? 0, r.id));
  const latestRunLeadIds = new Set<string>();
  for (const runId of Array.from(latestRunBySource.values())) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from('lead_import_run_rows').select('lead_id').eq('import_run_id', runId).range(offset, offset + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) if (r.lead_id) latestRunLeadIds.add(String(r.lead_id).toLowerCase());
      if ((data ?? []).length < 1000) break;
    }
  }

  const name = (s: string | null) => (showNames ? s : s ? `${s[0]}…(${s.length})` : null);
  const rows: Record<string, unknown>[] = [];
  const byProvenance: Record<string, Record<string, number>> = {};
  const closures: number[] = [];
  const restored: { id: number; from: string; to: string }[] = [];
  let skipped = 0;
  const auditIds = new Set(Object.keys(audit.leads).map(Number));

  for (const l of leads) {
    if (snapped.has(l.id)) { skipped++; continue; }
    const a = audit.leads[String(l.id)];
    const structured = legacyStructuredStage({ ...l, cash_component: l.cash_component == null ? null : Number(l.cash_component), initial_cash_offer: l.initial_cash_offer == null ? null : Number(l.initial_cash_offer), best_cash_offer: l.best_cash_offer == null ? null : Number(l.best_cash_offer) });
    const stage: LeadStage = a ? CODE_TO_STAGE[a.stage] : structured;
    const source = a ? 'LEGACY_AUDIT' : 'LEGACY_STRUCTURED';
    (byProvenance[source] ??= {})[stage] = ((byProvenance[source] ??= {})[stage] ?? 0) + 1;

    const concreteStructured = structured === 'NEGOTIATING' || ((structured === 'HIGH_INTENT' || structured === 'CONVERTED') && l.offer_type !== 'NONE');
    const offerIsConcrete = l.offer_type === 'NONE' ? null : a ? ['N1', 'N2', 'H', 'C'].includes(a.stage) : concreteStructured;
    const rounds = a ? (a.stage === 'N2' ? 2 : a.stage === 'N1' ? 1 : (a.stage === 'H' || a.stage === 'C') && offerIsConcrete ? 1 : 0) : (offerIsConcrete ? 1 : 0);
    const latestCash = l.offer_type === 'CASH' ? (l.best_cash_offer ?? l.initial_cash_offer ?? null) : null;

    let finalName = l.contact_name;
    const restoredName = l.contact_name_source === 'NOTES_PREFIX_V1' ? restoredQualifierName(l.notes, l.contact_name) : null;
    if (restoredName && restoredName !== l.contact_name) { restored.push({ id: l.id, from: l.contact_name!, to: restoredName }); finalName = restoredName; }

    const close = l.status === 'OPEN' && ['sold', 'traded'].includes(itemStatus.get(l.inventory_item_id) ?? '');
    if (close) closures.push(l.id);

    const set = { peak_stage: stage, peak_stage_source: source, negotiation_rounds: rounds, offer_is_concrete: offerIsConcrete, latest_cash_offer: latestCash, contact_key: contactKey(finalName), semantics_version: SEMANTICS_VERSION };
    const payload = buildLegacyPayload({ ...l, ...set, peak_stage: stage, peak_stage_source: source as LeadSnapshotRow['peak_stage_source'], contact_name: finalName });
    const occurred = (l.last_contact_at ?? l.first_contact_at ?? l.created_at.slice(0, 10)) + 'T12:00:00Z';
    rows.push({
      lead_id: l.id,
      set,
      ...(restoredName && restoredName !== l.contact_name ? { restore_contact_name: { from: l.contact_name, to: restoredName } } : {}),
      snapshot_event: { occurred_at: occurred, summary: 'Legacy Lead Log baseline (backfill) — earlier history is in the legacy notes, not reconstructed as events', payload, content_hash: crypto.createHash('sha256').update(`legacy-snapshot:${l.id}`).digest('hex') },
      close_item_unavailable: close,
    });
  }

  // Reported, never changed.
  const groups = new Map<string, Row[]>();
  for (const l of leads) {
    const k = contactKey(restored.find((r) => r.id === l.id)?.to ?? l.contact_name);
    if (!k) continue;
    const g = `${l.inventory_item_id}|${baseChannelKey(l.source_channel)}|${k}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(l);
  }
  const dupGroups = Array.from(groups.values()).filter((g) => g.length > 1);
  const missingFromSheet = leads.filter((l) => l.origin === 'SHEET' && latestRunBySource.size > 0 && !latestRunLeadIds.has(l.lead_id.toLowerCase()));
  const declinedFoundAnother = leads.filter((l) => l.status === 'DECLINED_BY_ME' && l.outcome_reason === 'FOUND_ANOTHER');

  const stageTotals: Record<string, number> = {};
  for (const r of rows) stageTotals[(r.set as { peak_stage: string }).peak_stage] = (stageTotals[(r.set as { peak_stage: string }).peak_stage] ?? 0) + 1;
  console.log('\n=== Backfill report ===');
  console.log(`total leads: ${leads.length}; to backfill: ${rows.length}; already backfilled (skipped): ${skipped}`);
  console.log(`audit coverage: ${leads.filter((l) => auditIds.has(l.id)).length} leads in audit; ${leads.filter((l) => !auditIds.has(l.id)).length} not in audit (LEGACY_STRUCTURED); audit ids missing from DB: ${Array.from(auditIds).filter((id) => !leads.some((l) => l.id === id)).length}`);
  console.log('stages (all):', JSON.stringify(stageTotals));
  for (const [src, m] of Object.entries(byProvenance)) console.log(`stages by provenance ${src}:`, JSON.stringify(m));
  console.log(`OPEN leads on sold/traded items → CLOSED / ITEM_UNAVAILABLE: ${closures.length}`);
  console.log(`  ids: ${closures.join(', ')}`);
  console.log(`contact qualifiers restored: ${restored.length}`);
  for (const r of restored) console.log(`  #${r.id}: "${name(r.from)}" → "${showNames ? r.to : r.to.replace(r.from, name(r.from) ?? '')}"`);
  console.log(`\nLEFT UNTOUCHED (manual resolution):`);
  console.log(`  same item + channel + contact groups (possible duplicates / separate episodes): ${dupGroups.length}`);
  for (const g of dupGroups) console.log(`    item ${g[0].inventory_item_id} ${g[0].source_channel} "${name(g[0].contact_name)}": ${g.map((l) => `#${l.id} ${l.status}`).join(' | ')}`);
  console.log(`  leads not present in the latest sheet import run: ${missingFromSheet.length} → ${missingFromSheet.map((l) => `#${l.id} ${l.status}${l.deal_id ? ' deal ' + l.deal_id : ''}`).join(', ')}`);
  console.log(`  DECLINED_BY_ME + FOUND_ANOTHER (not remapped): ${declinedFoundAnother.length} → ${declinedFoundAnother.map((l) => '#' + l.id).join(', ')}`);
  console.log(`  leads without contact_name (no contact_key): ${leads.filter((l) => !l.contact_name).length}`);
  console.log(`payload size: ${(JSON.stringify(rows).length / 1024).toFixed(0)} KB`);

  if (mode === 'report') { console.log('\nREPORT ONLY — nothing written.'); return; }

  console.log('\n=== APPLY ===');
  const { data, error } = await db.rpc('apply_lead_semantics_backfill_v1', { p_rows: rows });
  if (error) throw new Error(`apply failed (rolled back): ${error.message}`);
  console.log('result:', JSON.stringify(data));

  const after = await all<{ id: number; peak_stage: string | null; peak_stage_source: string | null; status: string; outcome_reason: string | null }>(db, 'item_leads', 'id, peak_stage, peak_stage_source, status, outcome_reason');
  const snapsAfter = await all<{ item_lead_id: number; event_type: string }>(db, 'lead_events', 'id, item_lead_id, event_type');
  const cnt = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  console.log('verify peak_stage:', JSON.stringify(cnt(after.map((l) => l.peak_stage ?? 'NULL'))));
  console.log('verify provenance:', JSON.stringify(cnt(after.map((l) => l.peak_stage_source ?? 'NULL'))));
  console.log('verify status:', JSON.stringify(cnt(after.map((l) => l.status))));
  console.log('verify CLOSED/ITEM_UNAVAILABLE:', after.filter((l) => l.status === 'CLOSED' && l.outcome_reason === 'ITEM_UNAVAILABLE').length);
  console.log('verify LEGACY_SNAPSHOT events:', snapsAfter.filter((e) => e.event_type === 'LEGACY_SNAPSHOT').length, '; leads without one:', after.filter((l) => !snapsAfter.some((e) => e.item_lead_id === l.id && e.event_type === 'LEGACY_SNAPSHOT')).length);
}

if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message ?? e); process.exit(1); });
