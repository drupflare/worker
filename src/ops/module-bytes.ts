/**
 * How a delivered file's bytes sit in a TEXT column.
 *
 * `cfw_module_file.source` and `cfw_module_blob.source` are TEXT, and SQLite cuts TEXT at its first
 * NUL and a UTF-8 round trip rewrites any byte sequence that is not text. A file that survives that
 * round trip is stored as the text it is; every other file is stored as this mark followed by its
 * base64, so one string still carries every file and the text paths (plans, comparisons, rollback)
 * keep working over strings.
 *
 * @module
 */
import { binaryToBytes } from '../util/base64';

/** what a binary file's stored string starts with; control characters no delivered text opens with */
export const BINARY_MARK = '\u0001cfw-base64\u0001';

/** how a blob's `source` was written by the client */
export type BlobEncoding = 'utf8' | 'base64';

const CHUNK = 0x8000;

/** base64 of a byte array, in chunks so a large file does not overflow the call stack */
export function bytesToBase64(bytes: Uint8Array): string {
	let raw = '';
	for (let at = 0; at < bytes.length; at += CHUNK) {
		raw += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
	}
	return btoa(raw);
}

/** the bytes of a base64 string, or undefined when it is not base64 */
export function base64ToBytes(text: string): Uint8Array | undefined {
	try {
		return binaryToBytes(atob(text));
	} catch {
		return undefined;
	}
}

/** whether a stored string holds a binary file */
export function isBinarySource(source: string): boolean {
	return source.startsWith(BINARY_MARK);
}

/**
 * The stored string for a file's bytes: the text itself when decoding and encoding it again gives
 * the same bytes with no NUL in them, else the mark and the base64.
 */
export function bytesToSource(bytes: Uint8Array): string {
	try {
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		if (!text.includes('\0') && !text.startsWith(BINARY_MARK)) return text;
	} catch {
		// not UTF-8, so it is held as base64
	}
	return BINARY_MARK + bytesToBase64(bytes);
}

/**
 * The bytes a stored string stands for, which is what the mount hands to PHP and what a file's
 * hash and integrity record cover. A binary string that is not base64 reads as empty.
 */
export function sourceBytes(source: string): Uint8Array {
	if (!isBinarySource(source)) return new TextEncoder().encode(source);
	return base64ToBytes(source.slice(BINARY_MARK.length)) ?? new Uint8Array(0);
}

/**
 * The bytes a client sent in a blob, or undefined when its encoding is not one this route reads
 * or its base64 does not decode.
 */
export function blobBytes(source: unknown, encoding: unknown): Uint8Array | undefined {
	if (typeof source !== 'string') return undefined;
	if (encoding === undefined || encoding === 'utf8') return new TextEncoder().encode(source);
	if (encoding === 'base64') return base64ToBytes(source);
	return undefined;
}

/**
 * The SQL that answers a stored string's byte length without loading it, bound to
 * {@link BINARY_MARK} twice: a binary row is its base64 length turned back into bytes.
 */
export const STORED_BYTES_SQL = `CASE WHEN substr(source, 1, ?) = ?
  THEN ((length(source) - ?) * 3) / 4 - (substr(source, -1) = '=') - (substr(source, -2, 1) = '=')
  ELSE length(CAST(source AS BLOB)) END`;

/** the three bindings {@link STORED_BYTES_SQL} takes, in order */
export const STORED_BYTES_BINDINGS: readonly [number, string, number] = [
	BINARY_MARK.length,
	BINARY_MARK,
	BINARY_MARK.length
];
