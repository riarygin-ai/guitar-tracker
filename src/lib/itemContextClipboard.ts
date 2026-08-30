// Clipboard wiring for the "Copy Item Context" button (Inventory Item
// detail page). Separated from React the same way as
// src/lib/listingEvidenceClipboard.ts / analysisPacketClipboard.ts, so it's
// testable without a DOM. Unlike those two, there is no fetch step — the
// Item Detail page already has every field the text needs, so the caller
// just hands in the pre-built text.

export interface ItemContextClipboardDeps {
  /** Injected so tests never need a real Clipboard API / secure context. */
  writeText: (text: string) => Promise<void>;
}

export type CopyItemContextResult =
  | { status: 'success' }
  | { status: 'clipboard_failed'; message: string }
  | { status: 'already_in_progress' };

export async function copyItemContextToClipboard(
  deps: ItemContextClipboardDeps,
  text: string,
): Promise<CopyItemContextResult> {
  try {
    await deps.writeText(text);
  } catch {
    return { status: 'clipboard_failed', message: 'Could not copy to clipboard — your browser may be blocking clipboard access.' };
  }
  return { status: 'success' };
}

/**
 * Wraps copyItemContextToClipboard with an in-flight guard so repeated
 * clicks while a copy is already running never race — same pattern as
 * createListingEvidenceCopier.
 */
export function createItemContextCopier(deps: ItemContextClipboardDeps) {
  let inFlight = false;

  return {
    async copy(text: string): Promise<CopyItemContextResult> {
      if (inFlight) {
        return { status: 'already_in_progress' };
      }
      inFlight = true;
      try {
        return await copyItemContextToClipboard(deps, text);
      } finally {
        inFlight = false;
      }
    },
  };
}
