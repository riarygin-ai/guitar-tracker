/**
 * test-operation-item-economics.ts
 *
 * Item economics on every operation surface:
 *   /operations/new           Trade · Sell · Buy   (shared forms, create mode)
 *   /operations/drafts/[id]   Trade · Sell · Buy   (SAME forms, draft mode)
 *   /operations/[id]          completed, read-only
 *
 *   P — pure: itemEconomics wraps the canonical formulas (outgoingItemGain /
 *       calculateItemProfitMetrics / dealRealizedProfit) — no drift
 *   R — render (react-dom/server) of the ONE shared OperationItemCard:
 *       outgoing Value In + Est. Sold Value + editable Value Out + derived
 *       Expenses/Gain/ROI; incoming Est. Sold Value + editable Value In +
 *       Potential Reward/ROI; Sell "Sale Value"; Create vs Draft identical
 *       economics; mobile stacking
 *   S — source: every form renders items through OperationItemCard with
 *       stored economics from useItemEconomicsInputs; Create + Draft pages
 *       render the same forms; persistence payloads / balance / finalize
 *       untouched; completed page uses the same functions + labels
 *
 * No database. Usage: npx tsx scripts/test-operation-item-economics.ts
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import {
  ECON_LABEL, fmtMoney, fmtPct, fmtSignedMoney, incomingEconomics, outgoingEconomics, parseAmount, sumExpensesByItem,
} from '../src/lib/operations/itemEconomics';
import { dealRealizedProfit, outgoingItemGain } from '../src/lib/operations/operationFinancials';
import { calculateItemProfitMetrics } from '../src/lib/profit';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}
// JSX is "preserve" in this repo; tsx needs a global React before the component module is imported.
(globalThis as { React?: typeof React }).React = React;
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (el: React.ReactElement) => string };
const root = path.join(__dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const near = (a: number | null, b: number | null, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

function pure() {
  console.log('\n[P1 — outgoing = canonical outgoingItemGain (Gibson example)]');
  const g = outgoingEconomics({ itemId: 1, valueIn: 2200, expenses: 75, estimatedSoldValue: 2800, valueOut: 2800 });
  const canon = outgoingItemGain({ item_id: 1, total_value: 2800 }, 2200, 75);
  check('gain = 2800 − 2200 − 75 = +525', g.gain === 525);
  check('gain / ROI identical to outgoingItemGain', g.gain === canon.realized_gain && g.roiPercent === canon.realized_roi_percent);
  check('ROI denominator is Value In (expenses reduce gain, are not added to cost basis): 525/2200', near(g.roiPercent, (525 / 2200) * 100));
  check('no Value Out entered yet → gain/ROI unknown (not 0)', outgoingEconomics({ itemId: 1, valueIn: 2200, expenses: 0, estimatedSoldValue: 2800, valueOut: null }).gain === null);
  const legs = [{ item_id: 1, direction: 'out' as const, total_value: 2800 }, { item_id: 2, direction: 'out' as const, total_value: 300 }, { item_id: 3, direction: 'in' as const, total_value: 900 }];
  const sumItems = outgoingEconomics({ itemId: 1, valueIn: 2200, expenses: 75, estimatedSoldValue: null, valueOut: 2800 }).gain!
    + outgoingEconomics({ itemId: 2, valueIn: 350, expenses: 0, estimatedSoldValue: null, valueOut: 300 }).gain!;
  check('sum of per-item gains = dealRealizedProfit (operations list Profit) — no drift', sumItems === dealRealizedProfit({ deal_type: 'trade' }, legs, { 1: 2200, 2: 350 }, { 1: 75 }));

  console.log('\n[P2 — incoming = canonical calculateItemProfitMetrics (PRS example)]');
  const p = incomingEconomics({ valueIn: 650, expenses: 0, estimatedSoldValue: 950 });
  const m = calculateItemProfitMetrics({ valueIn: 650, estimatedSoldValue: 950, totalExpenses: 0 });
  check('potential reward = 950 − 650 = +300', p.potentialReward === 300);
  check('potential ROI 46.2%', fmtPct(p.potentialRoiPercent) === '46.2%');
  check('identical to calculateItemProfitMetrics', p.potentialReward === m.potentialReward && p.potentialRoiPercent === m.potentialROI);
  check('no ESV → potential unknown (not computed against $0)', incomingEconomics({ valueIn: 650, expenses: 0, estimatedSoldValue: null }).potentialReward === null);
  check('zero Value In with upside → 100% (canonical zero-cost rule)', incomingEconomics({ valueIn: 0, expenses: 0, estimatedSoldValue: 200 }).potentialRoiPercent === 100);

  console.log('\n[P3 — formatting / parsing]');
  check('money', fmtMoney(2200) === '$2,200' && fmtMoney(null) === '—' && fmtMoney(12.5) === '$12.5');
  check('signed money keeps the sign (completed page used Math.abs before)', fmtSignedMoney(525) === '+$525' && fmtSignedMoney(-40) === '−$40' && fmtSignedMoney(0) === '$0');
  check('parseAmount', parseAmount('') === null && parseAmount('650') === 650 && parseAmount('abc') === null);
  check('sumExpensesByItem groups by item and skips unlinked expenses', JSON.stringify(sumExpensesByItem([{ item_id: 1, amount: 50 }, { item_id: 1, amount: 25 }, { item_id: null, amount: 9 }, { item_id: 2, amount: 10 }])) === '{"1":75,"2":10}');
  check('terminology: Est. Sold Value (not ambiguous "Est. Value")', ECON_LABEL.estSoldValue === 'Est. Sold Value' && ECON_LABEL.valueIn === 'Value In' && ECON_LABEL.valueOut === 'Value Out' && ECON_LABEL.saleValue === 'Sale Value');
}

function render() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Card = require('../src/components/operations/OperationItemCard').default as React.ComponentType<Record<string, unknown>>;
  const h = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(Card, props));
  const noop = () => {};

  console.log('\n[R1 — outgoing (Create Trade: Gibson / Draft Trade #5: Vox Bobcat)]');
  const gibson = { itemId: 11, direction: 'out', tone: 'trade', label: '2023 Gibson Les Paul Standard', chips: ['owned', 'Excellent'], estimatedSoldValue: 2800, stored: { valueIn: 2200, expenses: 75 }, valueLabel: ECON_LABEL.valueOut, value: '2800', onValueChange: noop, onRemove: noop };
  const out = h(gibson);
  const t = text(out);
  check('existing Value In visible ($2,200)', /Value In \$2,200/.test(t), t);
  check('Est. Sold Value visible ($2,800)', /Est\. Sold Value \$2,800/.test(t), t);
  check('Value Out stays an editable input', /Value Out/.test(t) && /<input[^>]*type="number"[^>]*value="2800"/.test(out));
  check('Value In is read-only (exactly one input on the card)', (out.match(/<input/g) ?? []).length === 1);
  check('expenses shown as secondary context, read-only', /Expenses \$75/.test(t));
  check('derived Gain +$525 · ROI', /Gain \+\$525/.test(t) && /ROI 23\.9%/.test(t), t);
  const vox = h({ ...gibson, itemId: 5, label: 'Vox Bobcat', estimatedSoldValue: 700, stored: { valueIn: 450, expenses: 0 }, value: '' });
  const vt = text(vox);
  check('Vox Bobcat: Value In visible, Est. Sold Value = $700, empty Value Out input', /Value In \$450/.test(vt) && /Est\. Sold Value \$700/.test(vt) && /<input[^>]*value=""/.test(vox));
  check('no Value Out yet → no Gain/ROI shown; no expenses line when 0', !/Gain/.test(vt) && !/Expenses/.test(vt));
  check('stored economics still loading → "…" (never a fake $0)', /Value In …/.test(text(h({ ...gibson, stored: undefined }))));

  console.log('\n[R2 — Sell (Create / Draft): Value In before the sale value is decided]');
  const sell = text(h({ ...gibson, tone: 'sell', valueLabel: ECON_LABEL.saleValue, value: '' }));
  check('Value In + Est. Sold Value + Sale Value input', /Value In \$2,200/.test(sell) && /Est\. Sold Value \$2,800/.test(sell) && /Sale Value/.test(sell) && !/Value Out/.test(sell));

  console.log('\n[R3 — incoming (Trade receive / Buy): PRS SE Fredrik Åkesson, Epiphone SG]');
  const prsProps = { itemId: 21, direction: 'in', tone: 'trade', label: 'PRS SE Fredrik Åkesson', chips: ['new'], estimatedSoldValue: 950, stored: { valueIn: null, expenses: 0 }, valueLabel: ECON_LABEL.valueIn, value: '650', onValueChange: noop, onRemove: noop };
  const prs = h(prsProps);
  const pt = text(prs);
  check('Est. Sold Value visible', /Est\. Sold Value \$950/.test(pt));
  check('Value In is the editable input', /Value In/.test(pt) && /<input[^>]*value="650"/.test(prs) && (prs.match(/<input/g) ?? []).length === 1);
  check('Potential Reward +$300 · Potential ROI 46.2%', /Potential Reward \+\$300/.test(pt) && /Potential ROI 46\.2%/.test(pt), pt);
  check('incoming never shows a (realized) Gain', !/Gain/.test(pt));
  const sg = text(h({ ...prsProps, itemId: 22, label: 'Epiphone SG Special Satin E1', estimatedSoldValue: null, value: '300' }));
  check('Epiphone SG without ESV: "—" and an explicit "no Est. Sold Value" note', /Est\. Sold Value —/.test(sg) && /no Est\. Sold Value/.test(sg), sg);
  const buy = text(h({ ...prsProps, tone: 'buy', itemId: 31, label: 'Guitar', estimatedSoldValue: 2000, value: '1500' }));
  check('Buy item: Value In + ESV + Potential Reward/ROI', /Est\. Sold Value \$2,000/.test(buy) && /Value In/.test(buy) && /Potential Reward \+\$500/.test(buy) && /Potential ROI 33\.3%/.test(buy), buy);

  console.log('\n[R4 — Create vs Draft: identical economics, only the draft footer differs]');
  const create = h(gibson);
  const footerHtml = '<div data-testid="draft-item-hint-11">Edit item</div>';
  const draft = h({ ...gibson, footer: React.createElement('div', { 'data-testid': 'draft-item-hint-11' }, 'Edit item') });
  check('card markup byte-identical in both modes once the draft footer is removed', draft.includes(footerHtml) && draft.replace(footerHtml, '') === create);
  check('draft adds only its footer', draft.includes('draft-item-hint-11') && !create.includes('draft-item-hint-11'));

  console.log('\n[R5 — mobile layout]');
  check('mobile: economics full-width under identity (col-span-2), 2-col stat grid; desktop row from md', /col-span-2 grid grid-cols-2[^"]*md:col-span-1 md:flex/.test(out));
  check('mobile: input is fluid (w-full / flex-1), fixed width only from md', /min-w-0 flex-1 md:w-28 md:flex-none/.test(out) && /class="w-full rounded-xl/.test(out));
  check('mobile: identity column can shrink + wraps long names (no horizontal overflow)', /grid-cols-\[4rem_minmax\(0,1fr\)\]/.test(out) && /break-words/.test(out) && !/overflow-x|min-w-\[|w-\[\d{3,}px\]/.test(out));
  check('mobile: secondary line wraps', /flex flex-wrap gap-x-3/.test(out));
}

function source() {
  const forms = {
    Trade: src('src/components/TradeOperationForm.tsx'),
    Sell: src('src/components/SellOperationForm.tsx'),
    Buy: src('src/components/BuyOperationForm.tsx'),
  };
  console.log('\n[S1 — shared forms render items through the ONE OperationItemCard]');
  for (const [name, s] of Object.entries(forms)) {
    check(`${name}: imports OperationItemCard + useItemEconomicsInputs`, /import OperationItemCard from '@\/components\/operations\/OperationItemCard'/.test(s) && /useItemEconomicsInputs\(/.test(s));
    check(`${name}: no hand-built economics left (no "Est. Value", no inline gain/ROI)`, !/Est\. Value|Est\. sold:|Purchase cost|Sale price/.test(s) && !/\/ totalCost\) \* 100|\/ totalCostBasis\) \* 100/.test(s));
    check(`${name}: stored economics are display-only (passed as stored=, never in a payload)`, /stored=\{economics\.byItemId\[/.test(s) && !/total_value:[^,\n]*economics/.test(s) && !/planned_value:[^,\n]*economics/.test(s));
    check(`${name}: draft hint is the card footer (only draft-mode difference)`, /footer=\{isDraft \? <DraftItemHint/.test(s));
  }
  const tr = forms.Trade;
  check('Trade: outgoing → Value Out, incoming → Value In', (tr.match(/<OperationItemCard/g) ?? []).length === 2 && /direction="out"[\s\S]*?valueLabel=\{ECON_LABEL\.valueOut\}/.test(tr) && /direction="in"[\s\S]*?valueLabel=\{ECON_LABEL\.valueIn\}/.test(tr));
  check('Sell: outgoing, labelled Sale Value (same stored Value Out)', /direction="out"[\s\S]*?valueLabel=\{ECON_LABEL\.saleValue\}/.test(forms.Sell));
  check('Buy: incoming, labelled Value In', /direction="in"[\s\S]*?valueLabel=\{ECON_LABEL\.valueIn\}/.test(forms.Buy));

  console.log('\n[S2 — Create and Draft pages render the same forms]');
  const newPage = src('src/app/operations/new/page.tsx');
  const draftPage = src('src/app/operations/drafts/[id]/page.tsx');
  for (const f of ['Trade', 'Sell', 'Buy']) {
    check(`${f}: /operations/new renders <${f}OperationForm />`, new RegExp(`<${f}OperationForm />`).test(newPage));
    check(`${f}: /operations/drafts/[id] renders <${f}OperationForm draft={context}`, new RegExp(`<${f}OperationForm\\s+draft=\\{context\\}`).test(draftPage));
  }
  check('no draft-only economics component exists', !/OperationItemCard|ECON_LABEL|Value In/.test(draftPage));

  console.log('\n[S3 — regression: balance / persistence / finalize untouched]');
  check('Trade balance rule unchanged', /const totalGiven = outgoingTotal \+ cashOutTotal/.test(tr) && /const totalReceived = incomingTotal \+ cashInTotal/.test(tr) && /const isBalanced = difference === 0/.test(tr) && /finalizeBlocked=\{!isBalanced\}/.test(tr));
  check('Trade payloads unchanged (total_value from the form values)', (tr.match(/total_value: Number\(ti\.value \|\| 0\)/g) ?? []).length === 2);
  check('Trade draft planned values unchanged', /direction: 'out' as const, planned_value: plannedValue\(t\.value\)/.test(tr) && /direction: 'in' as const, planned_value: plannedValue\(t\.value\)/.test(tr));
  check('Sell draft cash_received = sum of sale values (unchanged)', /cash_received: total,/.test(forms.Sell));
  check('Buy payload + draft cash_paid unchanged', (forms.Buy.match(/total_value: li\.cost/g) ?? []).length === 3 && /cash_paid: items\.reduce\(\(sum, li\) => sum \+ \(li\.cost \|\| 0\), 0\)/.test(forms.Buy));
  check('Buy keeps its existing allocation (cash paid = Σ Value In), no new balancing mechanism', /data-testid="buy-cash-paid"/.test(forms.Buy) && /cash paid is the sum of their Value In/.test(forms.Buy));
  check('finalize paths unchanged', /finalizeDraft\(draftId!, 'trade', operationArgs\)/.test(tr) && /finalizeDraft\(draftId!, 'purchase'/.test(forms.Buy));
  const hook = src('src/lib/operations/useItemEconomicsInputs.ts');
  check('hook only reads (value_in view + inventory_expenses), never writes', /getInventoryItemsWithValueByIds/.test(hook) && /getInventoryExpensesByItemIds/.test(hook) && !/\.(insert|update|upsert|delete|rpc)\(/.test(hook));
  check('Value In source = inventory_items_with_value.value_in (acquisition deal_items.total_value)', /from\('inventory_items_with_value'\)\.select\('id, value_in'\)\.in\('id', ids\)/.test(src('src/lib/supabase.ts')));

  console.log('\n[S4 — completed /operations/[id]: same functions, read-only, correct labels]');
  const done = src('src/app/operations/[id]/page.tsx');
  check('uses outgoingEconomics / incomingEconomics / sumExpensesByItem (no inline formulas)', /outgoingEconomics\(/.test(done) && /incomingEconomics\(/.test(done) && /sumExpensesByItem\(result\.data\)/.test(done) && !/valueOut - valueIn - itemExpenses|estimatedSold - valueIn/.test(done));
  check('outgoing: Value In · Expenses · Value Out / Sale Value · Realized Gain · ROI', /ECON_LABEL\.valueIn/.test(done) && /ECON_LABEL\.expenses/.test(done) && /deal\.deal_type === 'sale' \? ECON_LABEL\.saleValue : ECON_LABEL\.valueOut/.test(done) && /ECON_LABEL\.realizedGain/.test(done) && /ECON_LABEL\.roi\b/.test(done));
  check('incoming: Value In · Est. Sold Value · Potential Reward · Potential ROI (prospective labels)', /ECON_LABEL\.estSoldValue/.test(done) && /ECON_LABEL\.potentialReward/.test(done) && /ECON_LABEL\.potentialRoi/.test(done) && !/Est\. Profit|Purchase Cost|Realized Profit/.test(done));
  check('incoming that has since exited: no potential shown as if still owned', /const exited = item\.status === 'sold' \|\| item\.status === 'traded'/.test(done) && /\{!exited && \(/.test(done));
  check('gains keep their sign (fmtSignedMoney, not Math.abs)', /fmtSignedMoney\(econ\.gain\)/.test(done) && /fmtSignedMoney\(econ\.potentialReward\)/.test(done));
  check('no inputs on the completed page', !/<input/.test(done));
}

pure();
render();
source();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
