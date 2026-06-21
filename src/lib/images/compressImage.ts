import imageCompression from 'browser-image-compression';

const ACCEPTED_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024; // 30 MB

/**
 * Compresses a browser File to a JPEG under ~0.7 MB, max 1600px.
 * Throws on unsupported type, oversized original, or compression failure.
 */
export async function compressImage(file: File): Promise<File> {
  if (!ACCEPTED_TYPES.has(file.type.toLowerCase())) {
    throw new Error(
      `Unsupported file type: ${file.type || 'unknown'}. Use JPEG, PNG, WebP, or HEIC.`,
    );
  }
  if (file.size > MAX_ORIGINAL_BYTES) {
    throw new Error(
      `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 30 MB.`,
    );
  }

  const blob = await imageCompression(file, {
    maxSizeMB:        0.7,
    maxWidthOrHeight: 1600,
    useWebWorker:     true,
    fileType:         'image/jpeg',
    initialQuality:   0.75,
  });

  // Replace whatever extension the original had with .jpg
  const baseName  = file.name.replace(/\.[^.]+$/, '');
  const compressed = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });

  if (process.env.NODE_ENV === 'development') {
    const origMB = (file.size       / 1024 / 1024).toFixed(2);
    const compMB = (compressed.size / 1024 / 1024).toFixed(2);
    console.log(`[compressImage] ${file.name}: ${origMB} MB → ${compMB} MB`);
  }

  return compressed;
}
