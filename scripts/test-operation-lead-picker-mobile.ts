/**
 * test-operation-lead-picker-mobile.ts
 *
 * The selected-lead summary in the Sell / Trade operation forms
 * (src/components/leads/OperationLeadPicker.tsx): what it shows, the
 * mobile-first one-column layout (wrapping, no truncation below `sm`), the
 * unchanged desktop layout, the Change / "No matching lead" wiring, and that
 * both forms use this one shared component.
 *
 * Pure render (react-dom/server) + source checks — no database.
 * Usage: npx tsx scripts/test-operation-lead-picker-mobile.ts
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import type { OperationLeadCandidate } from '../src/lib/leads/operationLeads';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}
// JSX is "preserve" in this repo; tsx needs a global React before the component module is imported.
(globalThis as { React?: typeof React }).React = React;
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (el: React.ReactElement) => string };
const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function lead(over: Partial<OperationLeadCandidate> = {}): OperationLeadCandidate {
  return {
    lead_id: 4242, item_id: 7, item_label: 'Fender Stratocaster', contact_name: 'Matt Maccallum', contact_hint: null,
    channel: 'Marketplace', channel_detail: null, status: 'OPEN', outcome_reason: null,
    peak_stage: 'NEGOTIATING', offer_summary: 'C$1,700 cash', last_activity_at: '2026-10-20T15:00:00Z', ...over,
  };
}

(async () => {
  const { LeadSummary, leadDisplayName } = await import('../src/components/leads/OperationLeadPicker');
  const render = (c: OperationLeadCandidate, showItem = false) => renderToStaticMarkup(React.createElement(LeadSummary, { c, showItem }));

  console.log('\n[A — what the selected lead shows]');
  const shortHtml = render(lead());
  const t = text(shortHtml);
  check('1. contact name rendered', /data-lead-name[^>]*>Matt Maccallum</.test(shortHtml));
  check('2. channel visible (own mobile line + desktop detail line)', /data-lead-channel[^>]*>Marketplace</.test(shortHtml) && /Marketplace · /.test(t));
  check('3. peak stage badge shown (modern stage, not legacy quality)', /data-stage="NEGOTIATING"/.test(shortHtml) && !/SERIOUS|Serious/.test(shortHtml));
  check('4. lifecycle status badge shown', /data-status="OPEN"/.test(shortHtml));
  check('5. offer summary shown (existing formatOfferSummary text)', /data-lead-offer[^>]*>[\s\S]*C\$1,700 cash/.test(shortHtml));
  check('order on mobile: name → channel → badges → offer', ['data-lead-name', 'data-lead-channel', 'data-lead-badges', 'data-lead-offer'].every((k, i, a) => i === 0 || shortHtml.indexOf(a[i - 1]) < shortHtml.indexOf(k)));
  check('summary only: no lead id, notes, event history or message counts', !/4242|notes|Event history|messages/i.test(t), t);
  const closed = render(lead({ status: 'CLOSED', peak_stage: null }));
  check('a lead without a peak stage still shows its status (no empty stage chip, as before)', /data-status="CLOSED"/.test(closed) && !/data-stage/.test(closed));
  const unnamed = render(lead({ contact_name: null }));
  check('missing name keeps the existing fallback (never invented)', /Unnamed lead #4242/.test(unnamed) && leadDisplayName({ contact_name: '  ', lead_id: 9 }) === 'Unnamed lead #9');
  check('multi-item operation also shows which item ("For: …")', /For: Fender Stratocaster/.test(render(lead(), true)) && !/For:/.test(shortHtml));

  console.log('\n[B — responsive layout]');
  const longHtml = render(lead({
    contact_name: 'Maximilian-Alexander Featherstonehaugh-Worthington (collector, Ottawa)',
    offer_summary: 'Trade: 2011 Fender American Standard Stratocaster with hardshell case and original tags + C$500 to us',
    channel: 'Regular Buyer/Seller', channel_detail: 'Facebook Group',
  }), true);
  check('9. long name / offer / item lines wrap on mobile ([overflow-wrap:anywhere]) and only truncate from sm up', (longHtml.match(/\[overflow-wrap:anywhere\] sm:truncate/g) ?? []).length >= 3);
  check('9. nothing in the summary truncates at mobile width (no bare `truncate`)', !/(^|[\s"])truncate(?=[\s"])/.test(longHtml), longHtml);
  check('9. full long text is present (wrapping is CSS, nothing cut in markup)', /Featherstonehaugh-Worthington \(collector, Ottawa\)/.test(longHtml) && /original tags \+ C\$500 to us/.test(longHtml));
  check('8. mobile is one column (flex-col) and becomes the desktop row only at sm', /class="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-1\.5"/.test(shortHtml));
  check('8. no fixed multi-column grid anywhere in the picker', !/grid-cols-\d/.test(read('src', 'components', 'leads', 'OperationLeadPicker.tsx')));
  check('badges sit on their own wrapping row', /data-lead-badges[^>]*|class="mt-0\.5 flex flex-wrap items-center gap-1\.5 sm:mt-0"/.test(shortHtml) && /flex flex-wrap items-center gap-1\.5 sm:mt-0" data-lead-badges/.test(shortHtml));
  check('the summary can shrink inside its flex parent (min-w-0 flex-1) → no horizontal overflow', /class="min-w-0 flex-1" data-testid="lead-summary"/.test(shortHtml));
  check('desktop keeps the original detail line: channel · offer · last activity (hidden below sm)', /<span class="hidden sm:inline">Marketplace · <\/span>C\$1,700 cash<span class="hidden sm:inline"> · /.test(shortHtml) && /data-lead-channel/.test(shortHtml) && /sm:hidden" data-lead-channel/.test(shortHtml));

  console.log('\n[C — picker wiring]');
  const src = read('src', 'components', 'leads', 'OperationLeadPicker.tsx');
  check('6. selected lead renders the shared LeadSummary inside the picker trigger', /value\.kind === 'lead' \? \(\s*<LeadSummary\s+c=\{value\.lead\}\s+showItem=\{showItem\}\s+mobileAction=/.test(src));
  check('6. Change stays wired: the whole selected card is the trigger that opens the picker (unchanged onClick)', /onClick=\{\(\) => \{ setOpen\(\(o\) => !o\); setActive\(0\); \}\}/.test(src) && /aria-haspopup="listbox"/.test(src));
  check('6. a visible "Change" cue on mobile only; desktop keeps the chevron', /sm:hidden" data-lead-change>Change</.test(src) && /value\.kind === 'lead' \? 'hidden sm:block' : ''/.test(src));
  check('comfortable tap target: trigger min-h-11 (44px), full width', /flex min-h-11 w-full/.test(src));
  const withAction = renderToStaticMarkup(React.createElement(LeadSummary, { c: lead(), showItem: false, mobileAction: React.createElement('span', { 'data-lead-change': '' }, 'Change') }));
  check('the Change cue shares the NAME row (mobile), so badges/offer get the full width; the row dissolves into the desktop row at sm (sm:contents)',
    /<span class="flex items-start justify-between gap-2 sm:contents"><span[^>]*data-lead-name[^>]*>Matt Maccallum<\/span><span data-lead-change="">Change<\/span><\/span>/.test(withAction), withAction);
  check('7. "No matching lead" option still selects { kind: none } and renders as plain text, not a lead card', /onChange\(o === NONE_ID \? \{ kind: 'none' \} : \{ kind: 'lead', lead: o \}\)/.test(src) && /data-testid="lead-picker-none">No matching lead</.test(src) && /The buyer wasn&apos;t logged as a lead\. Nothing gets linked\./.test(src));
  check('edit flow: linked lead uses the same summary', /data-testid="lead-picker-linked"[\s\S]*<LeadSummary c=\{initial\.linked\}/.test(src));
  check('dropdown options wrap on mobile too (same WRAP rule), still one line from sm', /function CandidateLine[\s\S]*?\$\{WRAP\}[\s\S]*?\$\{WRAP\}/.test(src));
  check('no JS viewport detection (responsive Tailwind only)', !/innerWidth|matchMedia|useMediaQuery/.test(src));

  console.log('\n[D — Sell and Trade share the component]');
  for (const f of ['SellOperationForm.tsx', 'TradeOperationForm.tsx']) {
    const form = read('src', 'components', f);
    check(`10. ${f} renders the shared <OperationLeadPicker> (no local copy of the lead summary)`, /import OperationLeadPicker,/.test(form) && /<OperationLeadPicker\s/.test(form) && !/StageBadge|StatusBadge|offer_summary/.test(form));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
