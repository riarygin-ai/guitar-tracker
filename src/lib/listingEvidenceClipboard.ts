// Core logic for the "Copy Listing Evidence JSON" admin/developer utility
// (Analytics page). Deliberately separated from the React component so it
// is testable without a DOM/React-testing setup — this project has neither
// installed (see scripts/test-copy-listing-evidence.ts). Never logs or
// otherwise surfaces the access token; every returned message is a fixed,
// safe string, never a raw fetch/Supabase error or response body.

export interface ListingEvidenceCopierDeps {
  /** Resolves the current Supabase access token, or null if unauthenticated. */
  getAccessToken: () => Promise<string | null>;
  /** Injected so tests never need a real network stack. */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injected so tests never need a real Clipboard API / secure context. */
  writeText: (text: string) => Promise<void>;
}

export type CopyListingEvidenceResult =
  | { status: 'success' }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string }
  | { status: 'clipboard_failed'; message: string }
  | { status: 'already_in_progress' };

const LISTING_EVIDENCE_ENDPOINT = '/api/listing-evidence';

export async function copyListingEvidenceToClipboard(
  deps: ListingEvidenceCopierDeps,
): Promise<CopyListingEvidenceResult> {
  const token = await deps.getAccessToken();
  if (!token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  let res: Response;
  try {
    res = await deps.fetchImpl(LISTING_EVIDENCE_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { status: 'request_failed', message: 'Could not reach the server. Please try again.' };
  }

  if (!res.ok) {
    return { status: 'request_failed', message: `Could not load listing evidence (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'request_failed', message: 'Received an unexpected response from the server.' };
  }

  const text = JSON.stringify(payload, null, 2);

  try {
    await deps.writeText(text);
  } catch {
    return { status: 'clipboard_failed', message: 'Could not copy to clipboard — your browser may be blocking clipboard access.' };
  }

  return { status: 'success' };
}

/**
 * Wraps copyListingEvidenceToClipboard with an in-flight guard so repeated
 * clicks while a copy is already running never issue a second request —
 * enforced here (not just via a disabled button) so it holds even if two
 * calls race before React re-renders.
 */
export function createListingEvidenceCopier(deps: ListingEvidenceCopierDeps) {
  let inFlight = false;

  return {
    async copy(): Promise<CopyListingEvidenceResult> {
      if (inFlight) {
        return { status: 'already_in_progress' };
      }
      inFlight = true;
      try {
        return await copyListingEvidenceToClipboard(deps);
      } finally {
        inFlight = false;
      }
    },
  };
}
