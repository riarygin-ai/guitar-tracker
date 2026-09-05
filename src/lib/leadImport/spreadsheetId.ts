// Pure, client-safe helper — split out of googleSheets.ts (which pulls in
// Node's `crypto` and reads server-only env vars) so the admin config form
// can canonicalize a pasted URL/ID in the browser without bundling any of
// that.

// Accepts either a full Google Sheets URL or a bare spreadsheet ID and
// returns the canonical ID alone — the only form ever stored in
// lead_import_sources.spreadsheet_id.
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch) return urlMatch[1];

  // A bare ID contains only URL-safe base64-ish characters, no slashes/spaces.
  if (/^[a-zA-Z0-9-_]+$/.test(trimmed)) return trimmed;

  return null;
}
