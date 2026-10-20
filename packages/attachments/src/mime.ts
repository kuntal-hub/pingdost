/**
 * File types from their first bytes (REQ §10.1): file names and declared types are never
 * trusted. Pass at least the first 4 KiB (`SNIFF_BYTES`); for ZIP-based office files, the
 * first local file entries.
 */
export const SNIFF_BYTES = 4_096;

export type AttachmentCategory = 'image' | 'video' | 'audio' | 'document';

export interface SniffedType {
  mimeType: string;
  category: AttachmentCategory;
}

const ascii = (data: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...data.subarray(start, start + length));

const startsWith = (data: Uint8Array, bytes: readonly number[], offset = 0) =>
  bytes.every((byte, i) => data[offset + i] === byte);

/** ISO base media (MP4, MOV, HEIC, M4A, 3GP): the brand after `ftyp`. */
function isoBrand(data: Uint8Array): SniffedType | undefined {
  if (data.length < 12 || ascii(data, 4, 4) !== 'ftyp') return undefined;
  const brand = ascii(data, 8, 4);
  if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
    return { mimeType: 'image/heic', category: 'image' };
  }
  if (brand === 'avif' || brand === 'avis') return { mimeType: 'image/avif', category: 'image' };
  if (brand === 'M4A ' || brand === 'M4B ') return { mimeType: 'audio/mp4', category: 'audio' };
  if (brand === 'qt  ') return { mimeType: 'video/quicktime', category: 'video' };
  if (brand.startsWith('3gp') || brand.startsWith('3g2')) {
    return { mimeType: 'video/3gpp', category: 'video' };
  }
  return { mimeType: 'video/mp4', category: 'video' };
}

/** ZIP containers: Office Open XML, OpenDocument, or a plain ZIP. */
function zipKind(data: Uint8Array): SniffedType {
  const head = ascii(data, 0, Math.min(data.length, SNIFF_BYTES));
  if (head.includes('mimetypeapplication/vnd.oasis.opendocument.text')) {
    return { mimeType: 'application/vnd.oasis.opendocument.text', category: 'document' };
  }
  if (head.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')) {
    return { mimeType: 'application/vnd.oasis.opendocument.spreadsheet', category: 'document' };
  }
  if (head.includes('word/')) {
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      category: 'document',
    };
  }
  if (head.includes('xl/')) {
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      category: 'document',
    };
  }
  if (head.includes('ppt/')) {
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      category: 'document',
    };
  }
  return { mimeType: 'application/zip', category: 'document' };
}

/** Plain text if the head is valid UTF-8 without NUL or other binary control bytes. */
function isText(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      return false;
    }
    if (byte < 0x80) continue;
    const extra = byte >= 0xf0 ? 3 : byte >= 0xe0 ? 2 : byte >= 0xc2 ? 1 : -1;
    if (extra < 0 || byte > 0xf4) return false;
    for (let n = 1; n <= extra; n++) {
      // A sequence cut off at the end of the sample is fine.
      if (i + n >= data.length) return true;
      if (((data[i + n] ?? 0) & 0xc0) !== 0x80) return false;
    }
    i += extra;
  }
  return true;
}

export function sniffMime(head: Uint8Array): SniffedType {
  const d = head;
  if (startsWith(d, [0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', category: 'image' };
  if (startsWith(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', category: 'image' };
  }
  if (ascii(d, 0, 6) === 'GIF87a' || ascii(d, 0, 6) === 'GIF89a') {
    return { mimeType: 'image/gif', category: 'image' };
  }
  if (ascii(d, 0, 4) === 'RIFF') {
    const kind = ascii(d, 8, 4);
    if (kind === 'WEBP') return { mimeType: 'image/webp', category: 'image' };
    if (kind === 'WAVE') return { mimeType: 'audio/wav', category: 'audio' };
    if (kind === 'AVI ') return { mimeType: 'video/x-msvideo', category: 'video' };
  }
  if (ascii(d, 0, 2) === 'BM' && d.length >= 26)
    return { mimeType: 'image/bmp', category: 'image' };
  const iso = isoBrand(d);
  if (iso) return iso;
  if (startsWith(d, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(d, 0, Math.min(d.length, 64)).includes('webm')
      ? { mimeType: 'video/webm', category: 'video' }
      : { mimeType: 'video/x-matroska', category: 'video' };
  }
  if (ascii(d, 0, 3) === 'ID3') return { mimeType: 'audio/mpeg', category: 'audio' };
  if (d[0] === 0xff && ((d[1] ?? 0) & 0xf6) === 0xf0) {
    return { mimeType: 'audio/aac', category: 'audio' }; // ADTS
  }
  if (d[0] === 0xff && ((d[1] ?? 0) & 0xe0) === 0xe0) {
    return { mimeType: 'audio/mpeg', category: 'audio' }; // MPEG audio frame
  }
  if (ascii(d, 0, 4) === 'OggS') return { mimeType: 'audio/ogg', category: 'audio' };
  if (ascii(d, 0, 4) === 'fLaC') return { mimeType: 'audio/flac', category: 'audio' };
  if (ascii(d, 0, 6) === '#!AMR\n') return { mimeType: 'audio/amr', category: 'audio' };
  if (ascii(d, 0, 5) === '%PDF-') return { mimeType: 'application/pdf', category: 'document' };
  if (startsWith(d, [0x50, 0x4b, 0x03, 0x04])) return zipKind(d);
  if (startsWith(d, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mimeType: 'application/x-ole-storage', category: 'document' }; // legacy Office
  }
  if (isText(d)) return { mimeType: 'text/plain', category: 'document' };
  return { mimeType: 'application/octet-stream', category: 'document' };
}
