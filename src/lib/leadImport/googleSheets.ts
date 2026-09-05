// GT Lead Log import — server-side Google Sheets read integration (Part 11).
//
// Deliberately dependency-free (no `googleapis`/`google-auth-library`
// package): signs the service-account JWT bearer assertion with Node's
// built-in `crypto` and talks to the OAuth2 token endpoint + Sheets API v4
// with plain `fetch`. Server-only — this file must never be imported from
// client code (no NEXT_PUBLIC_ vars are read here, and nothing here is ever
// returned to a browser).
//
// Required env vars (never NEXT_PUBLIC_, never stored in Supabase):
//   GOOGLE_SHEETS_CLIENT_EMAIL
//   GOOGLE_SHEETS_PRIVATE_KEY
//
// The service account only ever needs read access — scope is
// spreadsheets.readonly. The spreadsheet owner shares their sheet with the
// service account's email as Viewer; one service account can read any
// number of users' spreadsheets this way without per-source credentials.

import crypto from 'crypto';
import { SOURCE_FATAL } from './errorCodes';
import type { SheetCellValue } from './types';

export { extractSpreadsheetId } from './spreadsheetId';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export class GoogleSheetsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GoogleSheetsError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function getCredentials(): { clientEmail: string; privateKey: string } {
  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!clientEmail || !rawKey) {
    throw new GoogleSheetsError(
      SOURCE_FATAL.GOOGLE_CREDENTIALS_MISSING,
      'Google service-account credentials are not configured on the server.',
    );
  }
  // Vercel/.env commonly store the PEM with literal "\n" escapes.
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return { clientEmail, privateKey };
}

interface CachedToken {
  accessToken: string;
  expiresAtEpochSeconds: number;
}

// Module-level cache — safe across requests in the same server process
// (short-lived; each token is valid for 1 hour, refreshed with a 60s
// safety margin). Never persisted, never returned to any caller.
let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAtEpochSeconds - 60 > nowEpochSeconds) {
    return cachedToken.accessToken;
  }

  const { clientEmail, privateKey } = getCredentials();

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowEpochSeconds,
    exp: nowEpochSeconds + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;

  let signature: string;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    signature = base64url(signer.sign(privateKey));
  } catch {
    throw new GoogleSheetsError(
      SOURCE_FATAL.GOOGLE_AUTH_FAILED,
      'Could not sign the Google service-account request. Check GOOGLE_SHEETS_PRIVATE_KEY formatting.',
    );
  }

  const assertion = `${unsigned}.${signature}`;

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
  } catch {
    throw new GoogleSheetsError(SOURCE_FATAL.GOOGLE_API_ERROR, 'Could not reach Google to authenticate (network error).');
  }

  if (!response.ok) {
    throw new GoogleSheetsError(SOURCE_FATAL.GOOGLE_AUTH_FAILED, `Google authentication failed (HTTP ${response.status}).`);
  }

  const json = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: json.access_token, expiresAtEpochSeconds: nowEpochSeconds + json.expires_in };
  return json.access_token;
}

// Fetches the entire populated range of one sheet tab, by name.
// valueRenderOption=UNFORMATTED_VALUE returns numbers as JS numbers (so a
// formatted "$2,500.00" cell comes back as 2500, never re-parsed from a
// display string) and dateTimeRenderOption=SERIAL_NUMBER returns any actual
// Sheets date/datetime cell as a numeric day-serial rather than a locale-
// formatted string — src/lib/leadImport/normalize.ts converts both numeric
// serials and plain text dates/timestamps.
export async function fetchSheetValues(spreadsheetId: string, sheetName: string): Promise<SheetCellValue[][]> {
  const token = await getAccessToken();
  const url =
    `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new GoogleSheetsError(SOURCE_FATAL.GOOGLE_API_ERROR, 'Could not reach Google Sheets (network error).');
  }

  if (response.status === 404) {
    throw new GoogleSheetsError(
      SOURCE_FATAL.SHEET_NOT_FOUND,
      `Sheet tab "${sheetName}" was not found, or the spreadsheet ID is invalid.`,
    );
  }
  if (response.status === 403) {
    throw new GoogleSheetsError(
      SOURCE_FATAL.SPREADSHEET_NOT_ACCESSIBLE,
      'The service account does not have access to this spreadsheet. Share it with the service account email as Viewer.',
    );
  }
  if (!response.ok) {
    throw new GoogleSheetsError(SOURCE_FATAL.GOOGLE_API_ERROR, `Google Sheets API returned HTTP ${response.status}.`);
  }

  const json = (await response.json()) as { values?: SheetCellValue[][] };
  return json.values ?? [];
}
