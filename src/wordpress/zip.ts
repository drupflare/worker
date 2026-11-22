import { inflateSync } from 'fflate';

/** the rules a plugin or theme archive can break; each one is a refusal with this name */
export type ZipRule =
	| 'not-a-zip'
	| 'archive-too-large'
	| 'zip64'
	| 'encrypted'
	| 'unsupported-compression'
	| 'too-many-entries'
	| 'invalid-name'
	| 'path-traversal'
	| 'absolute-path'
	| 'drive-letter'
	| 'backslash'
	| 'symlink'
	| 'device-entry'
	| 'duplicate-name'
	| 'case-collision'
	| 'overlap'
	| 'entry-too-large'
	| 'expanded-too-large'
	| 'ratio'
	| 'size-mismatch'
	| 'layout'
	| 'php-outside-folder';

/** the caps an archive is held to; chosen values, not measured */
export interface ZipLimits {
	/** compressed bytes of the whole archive */
	archiveBytes: number;
	/** entries, directories included */
	entries: number;
	/** expanded bytes of one file; a Durable Object row holds at most 2,199,995 */
	entryBytes: number;
	/** expanded bytes of every file together */
	expandedBytes: number;
	/** expanded over compressed, for one file over {@link ZipLimits.ratioFloorBytes} and for the whole */
	ratio: number;
	/** files below this size are exempt from the per-file ratio, since a tiny file compresses oddly */
	ratioFloorBytes: number;
}

/** the caps the host applies */
export const ZIP_LIMITS: Readonly<ZipLimits> = {
	archiveBytes: 20 * 1024 * 1024,
	entries: 1500,
	entryBytes: 2_000_000,
	expandedBytes: 20 * 1024 * 1024,
	ratio: 100,
	ratioFloorBytes: 64 * 1024
};

/** a refusal: which rule, which entry when one is to blame, and a sentence for the receipt */
export class ZipRefused extends Error {
	/** the rule that was broken */
	readonly rule: ZipRule;
	/** the entry name the rule is about, when there is one */
	readonly entry: string | undefined;

	constructor(rule: ZipRule, detail: string, entry?: string) {
		super(`${rule}: ${detail}`);
		this.name = 'ZipRefused';
		this.rule = rule;
		this.entry = entry;
	}
}

/** one file kept from an archive, named relative to the package folder */
export interface ZipFile {
	path: string;
	bytes: Uint8Array;
}

/** what a checked archive holds */
export interface ZipPackage {
	/** the one top-level folder, which is the package slug */
	folder: string;
	files: ZipFile[];
	/** entries left out on purpose, each with the reason */
	skipped: { path: string; why: string }[];
	/** expanded bytes of `files` */
	totalBytes: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;

/** unix file types in the high half of the external attributes, when the entry was made on unix */
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const DEVICE_TYPES = new Set([0o020000, 0o060000, 0o010000, 0o140000]);

const PHP_EXTENSION = /\.(php[0-9]?|phtml|pht|phps|phar)$/i;
const HIDDEN_OR_VENDORED = /(^|\/)(\.[^/]+|node_modules)(\/|$)/;

interface Entry {
	name: string;
	method: number;
	compressed: number;
	expanded: number;
	offset: number;
	directory: boolean;
	dataStart: number;
}

function u16(view: DataView, at: number): number {
	return view.getUint16(at, true);
}

function u32(view: DataView, at: number): number {
	return view.getUint32(at, true);
}

function endRecord(view: DataView): number {
	const earliest = Math.max(0, view.byteLength - EOCD_BYTES - 0xffff);
	for (let at = view.byteLength - EOCD_BYTES; at >= earliest; at--) {
		if (u32(view, at) === EOCD) return at;
	}
	throw new ZipRefused('not-a-zip', 'no end-of-archive record');
}

/** the entry's name checked against the path rules; throws the first one it breaks */
function checkName(name: string): void {
	if (name === '' || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new ZipRefused(
			'invalid-name',
			'the name is empty or holds a control character',
			name
		);
	}
	if (name.includes('\\')) throw new ZipRefused('backslash', 'the name holds a backslash', name);
	if (name.startsWith('/')) throw new ZipRefused('absolute-path', 'the name is absolute', name);
	if (/^[A-Za-z]:/.test(name)) {
		throw new ZipRefused('drive-letter', 'the name starts with a drive letter', name);
	}
	if (name.split('/').includes('..')) {
		throw new ZipRefused('path-traversal', 'the name climbs out of the folder', name);
	}
}

function readEntries(view: DataView, limits: ZipLimits): Entry[] {
	const end = endRecord(view);
	if (u16(view, end + 4) !== 0 || u16(view, end + 6) !== 0) {
		throw new ZipRefused('not-a-zip', 'the archive spans several disks');
	}
	const count = u16(view, end + 10);
	const size = u32(view, end + 12);
	const start = u32(view, end + 16);
	if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
		throw new ZipRefused('zip64', 'zip64 archives are not read');
	}
	if (count > limits.entries) {
		throw new ZipRefused('too-many-entries', `${count} entries, the cap is ${limits.entries}`);
	}
	if (start + size > end) throw new ZipRefused('not-a-zip', 'the directory runs past its end');
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	const entries: Entry[] = [];
	let at = start;
	for (let i = 0; i < count; i++) {
		if (at + CENTRAL_BYTES > end || u32(view, at) !== CENTRAL) {
			throw new ZipRefused('not-a-zip', `directory entry ${i} is malformed`);
		}
		const made = u16(view, at + 4);
		const flags = u16(view, at + 8);
		const method = u16(view, at + 10);
		const compressed = u32(view, at + 20);
		const expanded = u32(view, at + 24);
		const nameLength = u16(view, at + 28);
		const extra = u16(view, at + 30);
		const comment = u16(view, at + 32);
		const external = u32(view, at + 38);
		const offset = u32(view, at + 42);
		const next = at + CENTRAL_BYTES + nameLength + extra + comment;
		if (next > end) throw new ZipRefused('not-a-zip', `directory entry ${i} runs past the end`);
		let name: string;
		try {
			name = decoder.decode(
				new Uint8Array(view.buffer, view.byteOffset + at + CENTRAL_BYTES, nameLength)
			);
		} catch {
			throw new ZipRefused('invalid-name', `entry ${i} is not valid UTF-8`);
		}
		checkName(name);
		if ((flags & 1) !== 0) throw new ZipRefused('encrypted', 'the entry is encrypted', name);
		if (method !== 0 && method !== 8) {
			throw new ZipRefused('unsupported-compression', `method ${method}`, name);
		}
		if (made >> 8 === UNIX_HOST) {
			const type = (external >>> 16) & S_IFMT;
			if (type === S_IFLNK) throw new ZipRefused('symlink', 'the entry is a symlink', name);
			if (DEVICE_TYPES.has(type)) {
				throw new ZipRefused('device-entry', 'the entry is a device, pipe or socket', name);
			}
		}
		const directory = name.endsWith('/');
		if (directory && expanded !== 0) {
			throw new ZipRefused('size-mismatch', 'a directory entry carries data', name);
		}
		if (expanded > limits.entryBytes) {
			throw new ZipRefused(
				'entry-too-large',
				`${expanded} bytes, the cap is ${limits.entryBytes}`,
				name
			);
		}
		entries.push({ name, method, compressed, expanded, offset, directory, dataStart: 0 });
		at = next;
	}
	return entries;
}

/** local header lengths give the data start; ranges must stay inside the archive and apart */
function locate(view: DataView, entries: Entry[]): void {
	for (const entry of entries) {
		if (entry.offset + LOCAL_BYTES > view.byteLength || u32(view, entry.offset) !== LOCAL) {
			throw new ZipRefused('not-a-zip', 'a local header is missing', entry.name);
		}
		entry.dataStart =
			entry.offset +
			LOCAL_BYTES +
			u16(view, entry.offset + 26) +
			u16(view, entry.offset + 28);
		if (entry.dataStart + entry.compressed > view.byteLength) {
			throw new ZipRefused('not-a-zip', 'the data runs past the archive', entry.name);
		}
	}
	const byOffset = entries.filter((e) => !e.directory).sort((a, b) => a.offset - b.offset);
	for (let i = 1; i < byOffset.length; i++) {
		const previous = byOffset[i - 1] as Entry;
		const current = byOffset[i] as Entry;
		if (previous.dataStart + previous.compressed > current.offset) {
			throw new ZipRefused('overlap', 'two entries share bytes', current.name);
		}
	}
}

function checkNames(entries: Entry[]): void {
	const seen = new Map<string, string>();
	for (const { name } of entries) {
		const key = name.replace(/\/$/, '').toLowerCase();
		const first = seen.get(key);
		if (first === undefined) seen.set(key, name);
		else if (first === name) {
			throw new ZipRefused('duplicate-name', 'the name appears twice', name);
		} else {
			throw new ZipRefused('case-collision', `differs from ${first} only in case`, name);
		}
	}
}

/** the single folder every entry sits under, which must be `expected` */
function checkLayout(entries: Entry[], expected: string): string {
	const tops = new Set<string>();
	for (const { name, directory } of entries) {
		const top = name.split('/')[0] as string;
		const isFile = !directory && !name.includes('/');
		if (isFile && PHP_EXTENSION.test(name)) {
			throw new ZipRefused('php-outside-folder', 'a PHP file sits beside the folder', name);
		}
		if (isFile) throw new ZipRefused('layout', 'a file sits beside the folder', name);
		tops.add(top);
	}
	if (tops.size !== 1) {
		throw new ZipRefused(
			'layout',
			tops.size === 0
				? 'the archive is empty'
				: `${tops.size} top-level folders: ${[...tops].join(', ')}`
		);
	}
	const [folder] = [...tops] as [string];
	if (folder !== expected) {
		throw new ZipRefused('layout', `the folder is ${folder}, the package is ${expected}`);
	}
	return folder;
}

/**
 * Reads a plugin or theme archive after holding it to every rule, and returns its files.
 *
 * Nothing is expanded before the directory passes: names, types, counts and declared sizes are all
 * judged from it. Each file is then inflated into a buffer one byte over its declared size, so a
 * header that understates its data fails instead of growing memory, and the length is compared
 * with the declared one. (`inflateSync` truncates to a supplied buffer without saying so, which is
 * why the extra byte is the check.) Entries are named by the central directory only.
 *
 * @param archive the archive bytes
 * @param folder the package slug; the archive must hold exactly this one folder
 * @param limits the caps, defaulting to {@link ZIP_LIMITS}
 */
export function readZipPackage(
	archive: Uint8Array,
	folder: string,
	limits: ZipLimits = ZIP_LIMITS
): ZipPackage {
	if (archive.byteLength > limits.archiveBytes) {
		throw new ZipRefused(
			'archive-too-large',
			`${archive.byteLength} bytes, the cap is ${limits.archiveBytes}`
		);
	}
	if (archive.byteLength < EOCD_BYTES) throw new ZipRefused('not-a-zip', 'too short');
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	const entries = readEntries(view, limits);
	checkNames(entries);
	const root = checkLayout(entries, folder);
	locate(view, entries);

	const files = entries.filter((e) => !e.directory);
	const declared = files.reduce((n, e) => n + e.expanded, 0);
	if (declared > limits.expandedBytes) {
		throw new ZipRefused(
			'expanded-too-large',
			`${declared} bytes, the cap is ${limits.expandedBytes}`
		);
	}
	if (declared > Math.max(archive.byteLength, 1) * limits.ratio) {
		throw new ZipRefused(
			'ratio',
			`the archive expands ${Math.round(declared / archive.byteLength)} to 1`
		);
	}
	for (const e of files) {
		if (
			e.method === 8 &&
			e.expanded > limits.ratioFloorBytes &&
			e.expanded > Math.max(e.compressed, 1) * limits.ratio
		) {
			throw new ZipRefused(
				'ratio',
				`the file expands ${Math.round(e.expanded / e.compressed)} to 1`,
				e.name
			);
		}
		if (e.method === 0 && e.compressed !== e.expanded) {
			throw new ZipRefused('size-mismatch', 'a stored entry has two sizes', e.name);
		}
	}

	const kept: ZipFile[] = [];
	const skipped: { path: string; why: string }[] = [];
	let totalBytes = 0;
	for (const e of files) {
		const rel = e.name.slice(root.length + 1);
		if (rel === '') continue;
		if (HIDDEN_OR_VENDORED.test(rel)) {
			skipped.push({ path: rel, why: 'a hidden or vendored path that nothing mounts' });
			continue;
		}
		const raw = archive.subarray(e.dataStart, e.dataStart + e.compressed);
		let bytes: Uint8Array;
		if (e.method === 0) bytes = raw.slice();
		else {
			try {
				bytes = inflateSync(raw, { out: new Uint8Array(e.expanded + 1) });
			} catch {
				throw new ZipRefused('size-mismatch', 'the data does not inflate', e.name);
			}
		}
		if (bytes.length !== e.expanded) {
			throw new ZipRefused(
				'size-mismatch',
				`the header says ${e.expanded} bytes and the data says otherwise`,
				e.name
			);
		}
		kept.push({ path: rel, bytes });
		totalBytes += bytes.length;
	}
	return { folder: root, files: kept, skipped, totalBytes };
}
