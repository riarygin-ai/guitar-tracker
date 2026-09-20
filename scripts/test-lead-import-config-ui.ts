/**
 * test-lead-import-config-ui.ts
 *
 * No-DB validation for the simplified Admin -> Lead Log Import source
 * configuration: the pure view-model rules (sourceConfigView.ts) and the
 * page wiring (src/app/admin/lead-import/page.tsx) — current-user default,
 * compact summary, "Change configuration" maintenance mode, user switching
 * without leakage, the no-config state, and that server-side authorization
 * and saved-config resolution are untouched.
 *
 * Usage:  npx tsx scripts/test-lead-import-config-ui.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildConfigDraft, canOfferPreview, configPanelMode, defaultSelectedUserId, describeSpreadsheet, formatImportTimestamp, summarizeSource, DEFAULT_SHEET_NAME,
} from '../src/lib/leadImport/sourceConfigView';
import type { LeadImportSource } from '../src/lib/leadImport/types';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const SHEET_A = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_ROMAN';
const SHEET_B = '1ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLlKkJj_OTHERUSER';

function src(over: Partial<LeadImportSource> & { user_id: number }): LeadImportSource {
  return {
    id: over.user_id * 10, source_code: 'GT_LEAD_LOG', source_name: `User ${over.user_id} Log`, provider: 'GOOGLE_SHEETS', spreadsheet_id: SHEET_A, sheet_name: 'Leads',
    is_enabled: true, last_successful_import_at: '2026-09-19T00:36:00Z', last_source_updated_at_seen: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...over,
  };
}

const page = read('src', 'app', 'admin', 'lead-import', 'page.tsx');
const pageNc = strip(page);
const editStart = pageNc.indexOf('{editing && (');
const summaryStart = pageNc.indexOf("configPanelMode(currentSource, editing) === 'summary'");
const setupStart = pageNc.indexOf("configPanelMode(currentSource, editing) === 'setup'");
const previewResultStart = pageNc.indexOf('Preview result');
const configCard = pageNc.slice(pageNc.indexOf('Source configuration'), pageNc.indexOf('{previewError'));
const beforeEdit = configCard.slice(0, configCard.indexOf('{editing && ('));
const editBlock = configCard.slice(configCard.indexOf('{editing && ('));

console.log('\n[A — default state: current user + saved config, no form]');
{
  check('the normal view defaults to the CURRENT authenticated user', defaultSelectedUserId(42) === 42);
  check('the page selects the authenticated user (not the first picker entry)', /defaultSelectedUserId\(user!\.id\)/.test(pageNc) && !/payload\.users\[0\]/.test(pageNc));
  check('the saved source is looked up automatically for the selected user', /sources\.find\(\(s\) => s\.user_id === selectedUserId\)/.test(pageNc));
  const mine = src({ user_id: 1 });
  check('a saved source renders the compact summary (not the form)', configPanelMode(mine, false) === 'summary');
  check('summary offers Preview immediately (no "Change configuration" click needed)', canOfferPreview(mine, false) === true);
  check('user dropdown is NOT in the default view (only inside the editing block)', !/<select/.test(beforeEdit) && /<select/.test(editBlock) && editStart > 0);
  check('spreadsheet input is NOT in the default view', !/Spreadsheet URL or ID/.test(beforeEdit) && /Spreadsheet URL or ID/.test(editBlock));
  check('sheet-name input is NOT in the default view', !/<input/.test(beforeEdit) && !/placeholder="Leads"/.test(beforeEdit) && /placeholder="Leads"/.test(editBlock));
  check('Source Name / Enabled switch / Guitar Tracker user labels are only in the editing block', ['Source Name', 'Guitar Tracker user', 'role="switch"'].every((t) => !beforeEdit.includes(t) && editBlock.includes(t)));
  check('the summary shows source name, spreadsheet, sheet, status, last successful import', /summary\.title/.test(beforeEdit) && /summary\.spreadsheetLabel/.test(beforeEdit) && /summary\.sheetName/.test(beforeEdit) && /summary\.statusLabel/.test(beforeEdit) && /Last successful import/.test(beforeEdit) && /formatImportTimestamp/.test(beforeEdit));
  check('Preview Lead Import button is in the summary; Change configuration sits beside it', /Preview Lead Import/.test(beforeEdit) && /Change configuration/.test(beforeEdit));
  check('nothing is offered before the config has loaded (no "not configured" flash)', /!configLoaded && !editing/.test(pageNc) && /configLoaded && configPanelMode/.test(pageNc));
}

console.log('\n[B — compact summary content]');
{
  const s = summarizeSource(src({ user_id: 1, source_name: 'Roman GT Lead Log', sheet_name: 'Leads', is_enabled: true }));
  check('title/sheet/status', s.title === 'Roman GT Lead Log' && s.sheetName === 'Leads' && s.statusLabel === 'Enabled');
  check('disabled state is labelled', summarizeSource(src({ user_id: 1, is_enabled: false })).statusLabel === 'Disabled');
  check('the long spreadsheet id is NOT shown as a primary value', !s.spreadsheetLabel.includes(SHEET_A) && /^Configured/.test(s.spreadsheetLabel), s.spreadsheetLabel);
  check('describeSpreadsheet: compact label with only a short tail; empty -> Not configured', describeSpreadsheet(SHEET_A) === `Configured (…${SHEET_A.slice(-6)})` && describeSpreadsheet('') === 'Not configured' && describeSpreadsheet('short') === 'Configured');
  check('the page never renders the raw spreadsheet_id in the summary', !/currentSource\.spreadsheet_id/.test(beforeEdit) && !/spreadsheet_id/.test(beforeEdit));
  check('last successful import formatted readably; never imported -> Never', /2026/.test(formatImportTimestamp('2026-09-19T00:36:00Z')) && formatImportTimestamp(null) === 'Never' && formatImportTimestamp('garbage') === 'Never');
}

console.log('\n[C — Change configuration (maintenance mode)]');
{
  const mine = src({ user_id: 1 });
  check('editing switches the panel to the form regardless of saved state', configPanelMode(mine, true) === 'edit' && configPanelMode(null, true) === 'edit');
  check('Preview is not offered while editing', canOfferPreview(mine, true) === false);
  check('edit mode reveals user selector, source name, spreadsheet, sheet and enabled control', ['Guitar Tracker user', 'Source Name', 'Spreadsheet URL or ID', 'Sheet Name', 'Enabled', 'role="switch"'].every((t) => editBlock.includes(t)));
  check('Save changes and Cancel buttons exist in edit mode', /Save changes/.test(editBlock) && />Cancel</.test(editBlock) && /onClick=\{handleSave\}/.test(editBlock) && /onClick=\{cancelConfig\}/.test(editBlock));
  check('Change configuration opens edit mode in place (no navigation)', /function openConfig\(\)[\s\S]*?setEditing\(true\)/.test(pageNc) && !/router\.push/.test(pageNc.slice(pageNc.indexOf('function openConfig'), pageNc.indexOf('function cancelConfig'))));
  check('opening rebuilds the draft from the selected user\'s saved source (discarding stale edits)', /function openConfig\(\)[\s\S]*?applyDraft\(draftFor\(selectedUserId\)\)/.test(pageNc));
  check('Cancel closes edit mode, discards unsaved values and returns to the current user', /function cancelConfig\(\)[\s\S]*?setEditing\(false\)[\s\S]*?setSelectedUserId\(home\)[\s\S]*?applyDraft\(draftFor\(home\)\)/.test(pageNc) && /const home = user \? defaultSelectedUserId\(user\.id\)/.test(pageNc));
  const save = pageNc.slice(pageNc.indexOf('async function handleSave'), pageNc.indexOf('async function runPreview'));
  check('Save keeps the existing behavior (validation, upsert, refreshed sources)', /Source Name is required/.test(save) && /extractSpreadsheetId/.test(save) && /upsertLeadImportSource\(/.test(save) && /setSources\(/.test(save));
  check('after a successful Save edit mode closes and the summary refreshes (no page navigation)', /setEditing\(false\)/.test(save) && /setSavedNotice\(/.test(save) && !/router\./.test(save));
  check('after Save the view returns to the current authenticated user (other user is not made the page default)', /setSelectedUserId\(defaultSelectedUserId\(user\.id\)\)/.test(save));
  check('a failed Save stays in edit mode with the error (editing only closes on success)', save.indexOf('setEditing(false)') > save.indexOf('if (error) {') && /setSaveError\(error\.message/.test(save));
}

console.log('\n[D — user switching without leakage]');
{
  const a = src({ user_id: 1, source_name: 'Roman Log', spreadsheet_id: SHEET_A, sheet_name: 'Leads', is_enabled: true });
  const b = src({ user_id: 2, source_name: 'Sam Log', spreadsheet_id: SHEET_B, sheet_name: 'Sam Leads', is_enabled: false });
  const da = buildConfigDraft(a, 'Roman');
  const db = buildConfigDraft(b, 'Sam');
  check('each user\'s draft comes only from that user\'s own source', da.spreadsheetInput === SHEET_A && da.sheetName === 'Leads' && da.isEnabled && db.spreadsheetInput === SHEET_B && db.sheetName === 'Sam Leads' && !db.isEnabled && db.sourceName === 'Sam Log');
  const none = buildConfigDraft(null, 'Casey');
  check('a user with NO source gets neutral defaults — nothing from the previously selected user', none.spreadsheetInput === '' && none.sheetName === DEFAULT_SHEET_NAME && none.isEnabled === true && none.sourceName === 'Casey GT Lead Log' && !JSON.stringify(none).includes(SHEET_A) && !JSON.stringify(none).includes('Sam'));
  check('an unknown user name yields an empty (not stale) source name', buildConfigDraft(undefined, null).sourceName === '');
  check('switching the picker loads that user\'s config (selectedUserId effect rebuilds ALL four fields)', /applyDraft\(buildConfigDraft\(existing, pickerUser\?\.display_name \?\? null\)\)/.test(pageNc) && /\[selectedUserId\]/.test(pageNc));
  check('applyDraft resets all four fields (name, spreadsheet, sheet, enabled)', /function applyDraft[\s\S]*?setSourceName[\s\S]*?setSpreadsheetInput[\s\S]*?setSheetName[\s\S]*?setIsEnabled/.test(pageNc));
  check('the picker is inside edit mode only and switches selectedUserId', /<select[\s\S]*?setSelectedUserId\(Number\(e\.target\.value\)\)/.test(editBlock) && !/setSelectedUserId\(Number/.test(beforeEdit));
  check('switching users resets stale preview / import state', /setPreviewResult\(null\)/.test(pageNc.slice(pageNc.indexOf('[selectedUserId]') - 900, pageNc.indexOf('[selectedUserId]'))));
}

console.log('\n[E — no-config state]');
{
  check('no saved source -> setup state (not summary, not form)', configPanelMode(null, false) === 'setup' && configPanelMode(undefined, false) === 'setup');
  check('Preview is unavailable without a source', canOfferPreview(null, false) === false);
  check('setup copy: "Lead Log import is not configured for this user."', /Lead Log import is not configured for this user\./.test(pageNc));
  const setup = pageNc.slice(setupStart, pageNc.indexOf('{editing && ('));
  check('setup state offers Configure source and NO Preview button', /Configure source/.test(setup) && !/Preview Lead Import/.test(setup) && /onClick=\{openConfig\}/.test(setup));
  check('the Preview button exists only inside the summary state', (pageNc.match(/Preview Lead Import/g) ?? []).length === 1 && pageNc.indexOf('Preview Lead Import') > summaryStart && pageNc.indexOf('Preview Lead Import') < setupStart);
  check('a brand-new source can be created from edit mode (Save works with no existing source)', /handleSave/.test(editBlock) && /upsertLeadImportSource/.test(pageNc));
}

console.log('\n[F — saved configuration is what Preview/Import use; security unchanged]');
{
  check('Preview and Import send only sourceId (never spreadsheet/sheet/name from the browser)', (pageNc.match(/body: JSON\.stringify\(\{ sourceId(?:: currentSource\.id)? \}\)/g) ?? []).length === 2 && !/spreadsheet(Id|_id|Input)?[^\n]*JSON\.stringify|JSON\.stringify\([^)]*(spreadsheet|sheetName)/.test(pageNc.slice(pageNc.indexOf('async function runPreview'), pageNc.indexOf('async function toggleRunDetail'))));
  check('Preview acts on the saved current source', /handlePreview[\s\S]*?runPreview\(currentSource\.id\)/.test(pageNc));
  for (const route of ['preview', 'import']) {
    const r = strip(read('src', 'app', 'api', 'admin', 'lead-import', route, 'route.ts'));
    check(`/api/admin/lead-import/${route} still authorizes admins server-side and resolves the source by id`, /authorizeAdminApiRequest/.test(r) && /sourceId/.test(r) && /\.from\('lead_import_sources'\)/.test(r) && !/spreadsheet_id\s*[:=]\s*(body|req)/i.test(r));
  }
  const auth = strip(read('src', 'lib', 'leadImport', 'adminApiAuth.ts'));
  check('admin authorization (token -> app user -> admin flag) is unchanged and server-side', /appUser\.admin/.test(auth) && /auth\.getUser/.test(auth));
  check('the page still requires admin (non-admins see Access denied)', /!user\.admin/.test(pageNc) && /Access denied/.test(pageNc));
  check('hiding the picker is UX only: saving still goes through upsertLeadImportSource (RLS) for the chosen user', /user_id: selectedUserId/.test(pageNc));
}

console.log('\n[G — schema: no migration needed]');
{
  const migs = fs.readdirSync(path.join(root, 'supabase', 'migrations')).sort();
  const base = migs.find((m) => m.startsWith('20260908000000_lead_import_sources'))!;
  const sql = read('supabase', 'migrations', base);
  check('lead_import_sources already stores per-user source_name / spreadsheet_id / sheet_name / is_enabled', ['source_name', 'spreadsheet_id', 'sheet_name', 'is_enabled'].every((c) => sql.includes(c)) && /UNIQUE \(user_id, source_code\)|unique[^;]*user_id[^;]*source_code/i.test(sql));
  const laterAlters = migs.filter((m) => m > base).filter((m) => /ALTER TABLE public\.lead_import_sources/i.test(read('supabase', 'migrations', m)));
  check('no later migration alters lead_import_sources and none was added for this change', laterAlters.length === 0, laterAlters);
  check('no migration mentions the TRADE warning / normalization', !migs.some((m) => /TRADE_CASH_COMPONENT_DEFAULTED/.test(read('supabase', 'migrations', m))));
}

console.log('\n[H — TRADE normalization wiring (source-level)]');
{
  const v = strip(read('src', 'lib', 'leadImport', 'validate.ts'));
  check('normalization happens in validation, before classification and before the payload is built', v.indexOf("TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO") < v.indexOf('let classification') && /cashComponent: cashComponentValue/.test(v));
  check('the warning is severity "warning", never "error"', /issue\('warning', ROW_WARNING\.TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO/.test(v));
  check('the importer never writes back to Google Sheets (read-only API)', !/spreadsheets\.values\.(update|append)|method: 'PUT'|values:append/i.test(read('src', 'lib', 'leadImport', 'googleSheets.ts')));
  const errs = read('src', 'lib', 'leadImport', 'errorCodes.ts');
  check('warning code registered', /TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO: 'TRADE_CASH_COMPONENT_DEFAULTED_TO_ZERO'/.test(errs));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
