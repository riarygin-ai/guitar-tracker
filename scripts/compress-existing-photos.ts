/**
 * compress-existing-photos.ts
 *
 * One-time compression tool for existing photos in Supabase Storage.
 * Downloads each image, compresses with sharp, and re-uploads to the same
 * path so all existing DB references remain intact.
 *
 * Usage:
 *   npx tsx scripts/compress-existing-photos.ts --path "user-id/item-id/photo.jpg" --dry-run
 *   npx tsx scripts/compress-existing-photos.ts --path "user-id/item-id/photo.jpg"
 *   npx tsx scripts/compress-existing-photos.ts --all --dry-run
 *   npx tsx scripts/compress-existing-photos.ts --all
 *   npx tsx scripts/compress-existing-photos.ts --all --limit 5
 *
 * Required env vars (loaded from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   PHOTO_BUCKET  (optional, defaults to "inventory-photos")
 */

import { config as loadEnv } from 'dotenv';
// Load .env.local first (Next.js convention), fall back to .env
loadEnv({ path: '.env.local' });
loadEnv();
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL          = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET                = process.env.PHOTO_BUCKET ?? 'inventory-photos';

const COMPRESS_QUALITY      = 72;
const MAX_WIDTH             = 1600;
const MIN_SIZE_BYTES        = 1 * 1024 * 1024; // skip files under 1 MB
const DRY_RUN_PREVIEW_PATH  = path.join(process.cwd(), '.tmp', 'compressed-preview.jpg');

// ── Argument parsing ──────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isAll    = args.includes('--all');

const pathFlagIdx  = args.indexOf('--path');
const targetPath   = pathFlagIdx !== -1 ? args[pathFlagIdx + 1] : null;

const limitFlagIdx = args.indexOf('--limit');
const limitRaw     = limitFlagIdx !== -1 ? args[limitFlagIdx + 1] : null;
const limit        = limitRaw ? parseInt(limitRaw, 10) : null;

// ── Validate args ─────────────────────────────────────────────────────────────

if (!targetPath && !isAll) {
  console.log(`
Guitar Tracker — Photo Compression Tool
========================================

USAGE:

  Single file (recommended for first test):
    npx tsx scripts/compress-existing-photos.ts --path "STORAGE_PATH" --dry-run
    npx tsx scripts/compress-existing-photos.ts --path "STORAGE_PATH"

  All eligible files:
    npx tsx scripts/compress-existing-photos.ts --all --dry-run
    npx tsx scripts/compress-existing-photos.ts --all --limit 5
    npx tsx scripts/compress-existing-photos.ts --all

FLAGS:
  --path "..."    Process exactly one file by its storage path.
  --all           Process all eligible files. Must be explicit.
  --dry-run       Simulate only. No uploads. For --path, saves preview to .tmp/compressed-preview.jpg
  --limit N       Cap the number of files processed (useful with --all for batch testing).

FIND LARGE PHOTOS (run in Supabase SQL Editor):
  select name, round(((metadata->>'size')::bigint/1024.0/1024.0)::numeric,2) as size_mb
  from storage.objects
  where bucket_id = 'inventory-photos'
  order by (metadata->>'size')::bigint desc
  limit 10;
`);
  process.exit(1);
}

// ── Validate env ──────────────────────────────────────────────────────────────

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  console.error('Add SUPABASE_SERVICE_ROLE_KEY to your .env.local file.');
  process.exit(1);
}

// ── Supabase client (service role — never expose to frontend) ─────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface StorageObject {
  name: string;
  metadata: {
    size?: number;
    mimetype?: string;
    [key: string]: unknown;
  } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isImageFile(obj: StorageObject): boolean {
  const mime = obj.metadata?.mimetype ?? '';
  if (mime.startsWith('image/')) return true;
  const ext = path.extname(obj.name).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
}

function getFileSize(obj: StorageObject): number {
  return obj.metadata?.size ?? 0;
}

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function compressImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()                          // auto-rotate from EXIF
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: COMPRESS_QUALITY, mozjpeg: true })
    .toBuffer();
}

async function downloadFile(storagePath: string): Promise<Buffer> {
  // The bucket is public, so use the public URL — no JWT signing required.
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const res = await fetch(data.publicUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${data.publicUrl}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function processFile(storagePath: string, dryRun: boolean): Promise<{ saved: number; skipped: boolean; error?: string }> {
  // ── Download ────────────────────────────────────────────────────────────────
  let originalBuffer: Buffer;
  try {
    originalBuffer = await downloadFile(storagePath);
  } catch (err) {
    return { saved: 0, skipped: false, error: `Download failed: ${(err as Error).message}` };
  }
  const originalSize   = originalBuffer.byteLength;

  // ── Skip small files ────────────────────────────────────────────────────────
  if (originalSize < MIN_SIZE_BYTES) {
    console.log(`  ⤼ SKIP  ${storagePath}  (${formatMB(originalSize)} — under 1 MB threshold)`);
    return { saved: 0, skipped: true };
  }

  // ── Compress ────────────────────────────────────────────────────────────────
  let compressed: Buffer;
  try {
    compressed = await compressImage(originalBuffer);
  } catch (err) {
    return { saved: 0, skipped: false, error: `Compression failed: ${(err as Error).message}` };
  }

  const compressedSize = compressed.byteLength;
  const savedBytes     = originalSize - compressedSize;

  console.log(`  ${dryRun ? '[DRY-RUN]' : '✓'} ${storagePath}`);
  console.log(`    Original : ${formatMB(originalSize)}`);
  console.log(`    Compressed: ${formatMB(compressedSize)}`);
  console.log(`    Saved    : ${formatMB(Math.max(0, savedBytes))}${savedBytes < 0 ? '  (already smaller — would skip upload)' : ''}`);

  if (savedBytes < 0) {
    // Compressed is larger — already optimal, skip
    return { saved: 0, skipped: true };
  }

  if (dryRun) {
    // Save local preview so caller can inspect before committing
    const previewDir = path.dirname(DRY_RUN_PREVIEW_PATH);
    if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(DRY_RUN_PREVIEW_PATH, compressed);
    console.log(`    Preview  : ${DRY_RUN_PREVIEW_PATH}`);
    return { saved: savedBytes, skipped: false };
  }

  // ── Upload (replace same path) ──────────────────────────────────────────────
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, compressed, {
      contentType: 'image/jpeg',
      upsert: true,           // overwrite existing object at same path
    });

  if (uploadErr) {
    return { saved: 0, skipped: false, error: `Upload failed: ${uploadErr.message}` };
  }

  return { saved: savedBytes, skipped: false };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nGuitar Tracker — Photo Compression');
  console.log('====================================');
  console.log(`Bucket  : ${BUCKET}`);
  console.log(`Mode    : ${isDryRun ? 'DRY-RUN (no uploads)' : 'UPDATE (will replace files)'}`);
  if (targetPath) console.log(`Path    : ${targetPath}`);
  if (limit)      console.log(`Limit   : ${limit}`);
  console.log('');

  // ── Single-file mode ───────────────────────────────────────────────────────
  if (targetPath) {
    const result = await processFile(targetPath, isDryRun);
    if (result.error) {
      console.error(`\nERROR: ${result.error}`);
      process.exit(1);
    }
    if (!result.skipped) {
      console.log(`\nDone. Saved ${formatMB(result.saved)}.`);
      if (isDryRun) console.log(`Inspect preview at: ${DRY_RUN_PREVIEW_PATH}`);
    }
    return;
  }

  // ── List all objects in bucket (recursive) ────────────────────────────────
  // The bucket has structure: {user-uuid}/{item-id}/{filename}
  // list('') only returns top-level folder entries (the UUID folders), so we
  // must recurse: list each UUID folder, then each item-id subfolder.
  const PAGE = 100;

  async function listAll(prefix: string): Promise<StorageObject[]> {
    const results: StorageObject[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) { console.error(`ERROR listing ${prefix || 'root'}:`, error.message); process.exit(1); }
      if (!data || data.length === 0) break;
      for (const entry of data as StorageObject[]) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!entry.metadata) {
          // It's a folder — recurse one level deeper
          results.push(...await listAll(fullPath));
        } else {
          results.push({ name: fullPath, metadata: entry.metadata });
        }
      }
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return results;
  }

  const allObjects = await listAll('');

  const images = allObjects.filter(isImageFile);
  const eligible = images.filter(obj => getFileSize(obj) >= MIN_SIZE_BYTES);
  const toProcess = limit ? eligible.slice(0, limit) : eligible;

  console.log(`Files in bucket : ${allObjects.length}`);
  console.log(`Image files     : ${images.length}`);
  console.log(`Eligible (≥1 MB): ${eligible.length}`);
  console.log(`Will process    : ${toProcess.length}`);
  console.log('');

  if (toProcess.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;
  let totalSaved = 0;

  for (const obj of toProcess) {
    const result = await processFile(obj.name, isDryRun);
    if (result.error) {
      console.error(`  ERROR: ${result.error}`);
      errors++;
    } else if (result.skipped) {
      skipped++;
    } else {
      processed++;
      totalSaved += result.saved;
    }
  }

  console.log('\n── Summary ──────────────────────────────');
  console.log(`Processed : ${processed}`);
  console.log(`Skipped   : ${skipped}`);
  console.log(`Errors    : ${errors}`);
  console.log(`Total saved: ${formatMB(totalSaved)}`);
  if (isDryRun) console.log('\nDry-run complete. No files were modified.');
}

main().catch(err => {
  console.error('\nFatal error:', err.message ?? err);
  process.exit(1);
});
