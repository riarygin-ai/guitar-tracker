// Server-only. The MCP get_item_context tool result: the item-context JSON
// as one TextContent block (unchanged), plus the item's photo as one MCP
// ImageContent block when it has one.
//
// Photo (Guitar Tracker stores at most one per item):
//   - row: inventory_item_photos through the caller's RLS client (policy:
//     own rows only) — the same pick the UI's getDisplayPhotosForItems makes
//     (is_main first, then sort_order); limit 1;
//   - bytes: downloaded server-side from the "inventory-photos" bucket with
//     that same request-scoped client. No URL is created or returned.
//   - MIME: sniffed from the bytes (the row's content_type is stale for
//     photos re-compressed to JPEG by scripts/compress-existing-photos.ts);
//     only JPEG / PNG / WebP are sent.
//   - size: stored photos are already compressed (≤ ~1 MB at rollout);
//     anything above MCP_ITEM_PHOTO_MAX_BYTES is skipped, never re-encoded.
// A missing photo adds nothing; a photo that cannot be loaded adds a short
// second TextContent note — the item context itself is never withheld.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getItemContextForMcp } from './itemContextMcp';

export const ITEM_PHOTO_BUCKET = 'inventory-photos';
export const MCP_ITEM_PHOTO_MAX_BYTES = 3 * 1024 * 1024;

export type ItemPhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';

type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; data: string; mimeType: ItemPhotoMime };
export interface ItemContextToolResult {
  [key: string]: unknown;
  content: (TextBlock | ImageBlock)[];
  isError?: boolean;
}

export type ItemPhotoLoad =
  | { status: 'ok'; data: string; mimeType: ItemPhotoMime; bytes: number }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

/** MIME type from the file signature, or null for anything that is not JPEG / PNG / WebP. */
export function sniffImageMime(b: Uint8Array): ItemPhotoMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** The item's single stored photo, read with the caller's own client. Never throws. */
export async function loadItemPhotoForMcp(client: SupabaseClient, itemId: number): Promise<ItemPhotoLoad> {
  try {
    const { data: row, error } = await client
      .from('inventory_item_photos')
      .select('storage_path')
      .eq('inventory_item_id', itemId)
      .order('is_main', { ascending: false })
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return { status: 'unavailable', reason: 'photo record could not be read' };
    if (!row?.storage_path) return { status: 'none' };

    const { data: blob, error: dlError } = await client.storage.from(ITEM_PHOTO_BUCKET).download(row.storage_path as string);
    if (dlError || !blob) return { status: 'unavailable', reason: 'photo file could not be downloaded' };
    if (blob.size > MCP_ITEM_PHOTO_MAX_BYTES) return { status: 'unavailable', reason: `photo is ${Math.round(blob.size / 1024)} KB, above the ${MCP_ITEM_PHOTO_MAX_BYTES / 1024 / 1024} MB limit` };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) return { status: 'unavailable', reason: 'photo is not a JPEG, PNG or WebP image' };
    return { status: 'ok', data: Buffer.from(bytes).toString('base64'), mimeType, bytes: bytes.length };
  } catch {
    return { status: 'unavailable', reason: 'photo could not be loaded' };
  }
}

/** get_item_context: context JSON (text) + the photo (image) when present. */
export async function buildItemContextToolResult(
  client: SupabaseClient,
  args: { item_id: number; lead_id?: number; full_history?: boolean },
  loadPhoto: typeof loadItemPhotoForMcp = loadItemPhotoForMcp,
): Promise<ItemContextToolResult> {
  // RLS scopes both reads to the caller; the photo is only used when the item itself resolved.
  const [result, photo] = await Promise.all([
    getItemContextForMcp(client, args.item_id, { lead_id: args.lead_id, full_history: args.full_history }),
    loadPhoto(client, args.item_id).catch((): ItemPhotoLoad => ({ status: 'unavailable', reason: 'photo could not be loaded' })),
  ]);
  if (result === null) return { content: [{ type: 'text', text: 'Item not found.' }], isError: true };
  if ('error' in result) return { content: [{ type: 'text', text: 'Lead not found on this item.' }], isError: true };

  const content: ItemContextToolResult['content'] = [{ type: 'text', text: JSON.stringify(result) }];
  if (photo.status === 'ok') content.push({ type: 'image', data: photo.data, mimeType: photo.mimeType });
  else if (photo.status === 'unavailable') content.push({ type: 'text', text: `Note: the item photo could not be included (${photo.reason}).` });
  return { content };
}
