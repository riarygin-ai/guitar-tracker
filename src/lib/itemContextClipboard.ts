// Clipboard wiring for the "Copy Item Context" button (Inventory Item
// detail page). Separated from React the same way as
// src/lib/listingEvidenceClipboard.ts / analysisPacketClipboard.ts, so it's
// testable without a DOM. The text may be handed in ready-made or as a
// Promise (the context now includes listing/price/lead history that is
// loaded at click time).

export interface ItemContextClipboardDeps {
  /** Injected so tests never need a real Clipboard API / secure context. */
  writeText: (text: string) => Promise<void>;
  /**
   * Optional: write from a still-pending text (ClipboardItem with a Promise
   * blob). Keeps the user-gesture alive on Safari, which otherwise rejects a
   * clipboard write that happens after an awaited network round trip.
   */
  writeTextFromPromise?: (text: Promise<string>) => Promise<void>;
}

export type CopyItemContextResult =
  | { status: 'success' }
  | { status: 'clipboard_failed'; message: string }
  | { status: 'load_failed'; message: string }
  | { status: 'already_in_progress' };

const LOAD_FAILED = 'Could not load the item’s listing and lead history — nothing was copied. Please try again.';
const CLIPBOARD_FAILED = 'Could not copy to clipboard — your browser may be blocking clipboard access.';

export async function copyItemContextToClipboard(
  deps: ItemContextClipboardDeps,
  text: string | Promise<string>,
): Promise<CopyItemContextResult> {
  if (typeof text === 'string') {
    try {
      await deps.writeText(text);
    } catch {
      return { status: 'clipboard_failed', message: CLIPBOARD_FAILED };
    }
    return { status: 'success' };
  }

  // Track a failure of the TEXT itself separately from a clipboard failure.
  let loadFailed = false;
  const guarded = text.catch((err) => { loadFailed = true; throw err; });

  if (deps.writeTextFromPromise) {
    try {
      await deps.writeTextFromPromise(guarded);
      return { status: 'success' };
    } catch {
      if (loadFailed) return { status: 'load_failed', message: LOAD_FAILED };
      // Fall through: the Promise-based write may simply be unsupported — try the plain path.
    }
  }

  let resolved: string;
  try {
    resolved = await guarded;
  } catch {
    return { status: 'load_failed', message: LOAD_FAILED };
  }
  try {
    await deps.writeText(resolved);
  } catch {
    return { status: 'clipboard_failed', message: CLIPBOARD_FAILED };
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
    async copy(text: string | Promise<string>): Promise<CopyItemContextResult> {
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
