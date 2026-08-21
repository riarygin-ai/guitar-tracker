/**
 * test-copy-listing-evidence.ts
 *
 * Focused validation for the "Copy Listing Evidence JSON" utility
 * (src/lib/listingEvidenceClipboard.ts, src/components/
 * CopyListingEvidenceButton.tsx) — a follow-up to Listing Evidence v1.0
 * (commit aa884b2). This is pure logic/unit coverage: getAccessToken,
 * fetch, and clipboard.writeText are all injected dependencies, so none of
 * this needs a DOM, a browser, or a running Next.js server — same "no test
 * framework, local check()" convention as every other script in this
 * directory, just without the local-Supabase safety gate other scripts
 * use, since nothing here touches a database.
 *
 * Usage:
 *   npx tsx scripts/test-copy-listing-evidence.ts
 */

import {
  copyListingEvidenceToClipboard,
  createListingEvidenceCopier,
  type ListingEvidenceCopierDeps,
} from '../src/lib/listingEvidenceClipboard';
import * as fs from 'fs';
import * as path from 'path';

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

// ── Fakes ──────────────────────────────────────────────────────────────

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const SAMPLE_EVIDENCE = {
  schema_version: '1.0',
  generated_at: '2026-08-21T00:00:00.000Z',
  evidence_scope: 'target_user_inventory_population',
  population_summary: { open_item_count: 3 },
  channel_summary: [],
  reconciliation: [],
};

async function main() {
  console.log('\n[A — authenticated request includes the Bearer token]');
  {
    let capturedInput: string | null = null;
    let capturedInit: RequestInit | undefined;
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => 'test-access-token-123',
      fetchImpl: async (input, init) => {
        capturedInput = input;
        capturedInit = init;
        return fakeResponse(200, { target_user_listing_evidence: SAMPLE_EVIDENCE });
      },
      writeText: async () => {},
    };
    const result = await copyListingEvidenceToClipboard(deps);
    check('result is success', result.status === 'success', result);
    check('called GET /api/listing-evidence', capturedInput === '/api/listing-evidence', capturedInput);
    check('method is GET', capturedInit?.method === 'GET', capturedInit?.method);
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    check('Authorization header carries the Bearer token', headers?.Authorization === 'Bearer test-access-token-123', headers);
  }

  console.log('\n[B — unauthenticated session: no request, safe error]');
  {
    let fetchCalled = false;
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => null,
      fetchImpl: async (input, init) => {
        fetchCalled = true;
        return fakeResponse(200, {});
      },
      writeText: async () => {},
    };
    const result = await copyListingEvidenceToClipboard(deps);
    check('fetch was never called', !fetchCalled);
    check('result status is unauthenticated', result.status === 'unauthenticated', result);
    if (result.status === 'unauthenticated') {
      check('message is a fixed, safe string', result.message === 'Not signed in — please sign in again.', result.message);
    }
  }

  console.log('\n[C — successful response copies pretty-printed JSON]');
  {
    const captured: { text: string | null } = { text: null };
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(200, { target_user_listing_evidence: SAMPLE_EVIDENCE }),
      writeText: async (text) => { captured.text = text; },
    };
    const result = await copyListingEvidenceToClipboard(deps);
    check('result is success', result.status === 'success', result);
    const copiedText = captured.text;
    check('copied text is pretty-printed (contains newlines/indentation)', typeof copiedText === 'string' && copiedText.includes('\n  '), copiedText);
    if (typeof copiedText !== 'string') throw new Error('writeText was never called — cannot continue section C');
    check('copied text round-trips to the exact same object the server returned', JSON.stringify(JSON.parse(copiedText)) === JSON.stringify({ target_user_listing_evidence: SAMPLE_EVIDENCE }));
    check('copied text preserves every top-level Listing Evidence key (no summarizing/dropping fields)',
      Object.keys(SAMPLE_EVIDENCE).every((k) => copiedText.includes(`"${k}"`)), copiedText);
  }

  console.log('\n[D — failed endpoint response copies nothing]');
  {
    let writeTextCalled = false;
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(500, { error: 'Unexpected server error' }),
      writeText: async () => { writeTextCalled = true; },
    };
    const result = await copyListingEvidenceToClipboard(deps);
    check('writeText was never called', !writeTextCalled);
    check('result status is request_failed', result.status === 'request_failed', result);
    if (result.status === 'request_failed') {
      check('message never echoes the raw server error body', !result.message.includes('Unexpected server error'), result.message);
    }
  }

  console.log('\n[D2 — 401 from the endpoint also copies nothing, with a safe message]');
  {
    let writeTextCalled = false;
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(401, { error: 'Unauthorized' }),
      writeText: async () => { writeTextCalled = true; },
    };
    const result = await copyListingEvidenceToClipboard(deps);
    check('writeText was never called on 401', !writeTextCalled);
    check('result status is request_failed', result.status === 'request_failed', result);
  }

  console.log('\n[D3 — network error (fetch throws) copies nothing, no crash]');
  {
    let writeTextCalled = false;
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => { throw new Error('ECONNREFUSED some internal detail'); },
      writeText: async () => { writeTextCalled = true; },
    };
    const result = await copyListingEvidenceToClipboard(deps);
    check('writeText was never called', !writeTextCalled);
    check('result status is request_failed', result.status === 'request_failed', result);
    if (result.status === 'request_failed') {
      check('message never leaks the raw error string', !result.message.includes('ECONNREFUSED'), result.message);
    }
  }

  console.log('\n[D4 — clipboard write throws (denied/unavailable): safe failure, no crash]');
  {
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(200, { target_user_listing_evidence: SAMPLE_EVIDENCE }),
      writeText: async () => { throw new Error('NotAllowedError: permission denied'); },
    };
    const result = await copyListingEvidenceToClipboard(deps);
    check('result status is clipboard_failed (not a thrown exception)', result.status === 'clipboard_failed', result);
    if (result.status === 'clipboard_failed') {
      check('message never leaks the raw clipboard error', !result.message.includes('NotAllowedError'), result.message);
    }
  }

  console.log('\n[E — repeated clicks while loading produce only one request]');
  {
    let fetchCallCount = 0;
    let resolveFirstFetch: (() => void) | null = null;
    // Only the FIRST invocation blocks on an external resolve() — every
    // later call resolves immediately, so a legitimate third call (issued
    // only after the first has fully completed) can't hang the test.
    const deps: ListingEvidenceCopierDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          await new Promise<void>((resolve) => { resolveFirstFetch = resolve; });
        }
        return fakeResponse(200, { target_user_listing_evidence: SAMPLE_EVIDENCE });
      },
      writeText: async () => {},
    };
    const copier = createListingEvidenceCopier(deps);

    const firstCall = copier.copy();
    // Second click lands before the first request has resolved.
    const secondResult = await copier.copy();
    check('second concurrent call is rejected as already_in_progress', secondResult.status === 'already_in_progress', secondResult);
    check('fetch was only ever called once so far', fetchCallCount === 1, fetchCallCount);

    // Let the first call finish.
    resolveFirstFetch!();
    const firstResult = await firstCall;
    check('first call still completes successfully', firstResult.status === 'success', firstResult);

    // Now that the first call has finished, a new click must be allowed
    // through again (the guard is per-in-flight-request, not permanent).
    const thirdResult = await copier.copy();
    check('a new call after completion is allowed through (not permanently locked)', thirdResult.status === 'success', thirdResult);
    check('fetch was called exactly twice total (1 first call + 1 third call, second click never issued its own request)', fetchCallCount === 2, fetchCallCount);
  }

  console.log('\n[F — no token is rendered or logged]');
  {
    const libSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'listingEvidenceClipboard.ts'), 'utf8');
    const componentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CopyListingEvidenceButton.tsx'), 'utf8');
    check('listingEvidenceClipboard.ts contains no console.* calls', !/console\.(log|error|warn|info|debug)\s*\(/.test(libSource), 'console call found');
    check('CopyListingEvidenceButton.tsx contains no console.* calls', !/console\.(log|error|warn|info|debug)\s*\(/.test(componentSource), 'console call found');
    check('component never renders the access token or Authorization header in JSX/text', !/\{.*access_token.*\}|\{.*token.*\}<\/|Authorization:.*\{/.test(componentSource), 'possible token render found');

    // Runtime check as well: drive a real success + a real failure through
    // copyListingEvidenceToClipboard with a spying console, confirming
    // nothing is ever written to it and no returned message contains the
    // token value used.
    const SECRET_TOKEN = 'super-secret-access-token-should-never-leak';
    const originalConsole = { log: console.log, error: console.error, warn: console.warn };
    const consoleCalls: unknown[][] = [];
    console.log = (...args: unknown[]) => { consoleCalls.push(args); };
    console.error = (...args: unknown[]) => { consoleCalls.push(args); };
    console.warn = (...args: unknown[]) => { consoleCalls.push(args); };
    try {
      await copyListingEvidenceToClipboard({
        getAccessToken: async () => SECRET_TOKEN,
        fetchImpl: async () => fakeResponse(500, { error: 'boom' }),
        writeText: async () => {},
      });
      await copyListingEvidenceToClipboard({
        getAccessToken: async () => SECRET_TOKEN,
        fetchImpl: async () => fakeResponse(200, { target_user_listing_evidence: SAMPLE_EVIDENCE }),
        writeText: async () => {},
      });
    } finally {
      console.log = originalConsole.log;
      console.error = originalConsole.error;
      console.warn = originalConsole.warn;
    }
    const flat = JSON.stringify(consoleCalls);
    check('nothing was ever logged to the console during success or failure paths', consoleCalls.length === 0, consoleCalls);
    check('the secret token never appears anywhere in console output', !flat.includes(SECRET_TOKEN), flat);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
