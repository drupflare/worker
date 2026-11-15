import { firstRow } from '../util/sql';
import { columnText, enabledModules, type ReconcileSql } from './reconcile';

/** Strata's module name in `core.extension` */
export const STRATA_MODULE = 'strata';

/** whether `core.extension` lists the module; an unreadable row reads as not enabled */
export function strataEnabled(sql: ReconcileSql): boolean {
	return enabledModules(sql)?.includes(STRATA_MODULE) ?? false;
}

/**
 * `capture.statements` as the stored row says it, or undefined when there is no `strata.settings`
 * row. A row without the key reads false, which is what `CaptureScope::tapsStatements()` does.
 */
export function capturesStatements(sql: ReconcileSql): boolean | undefined {
	let data: string | undefined;
	try {
		data = columnText(
			firstRow(
				sql.exec(
					"SELECT data FROM config WHERE collection = '' AND name = ?",
					'strata.settings'
				)
			)?.data
		);
	} catch {
		return undefined;
	}
	if (data === undefined) return undefined;
	const capture = data.indexOf('s:7:"capture";');
	if (capture < 0) return false;
	const key = 's:10:"statements";';
	const at = data.indexOf(key, capture);
	if (at < 0) return false;
	return /^b:1;/.test(data.slice(at + key.length));
}

/** the S3 submodule's name in `core.extension` */
export const STRATA_S3_MODULE = 'strata_s3';

/** whether `core.extension` lists the S3 submodule */
export function strataS3Enabled(sql: ReconcileSql): boolean {
	return enabledModules(sql)?.includes(STRATA_S3_MODULE) ?? false;
}

/** what `POST /strata-store` takes, after validation */
export type StrataStoreRequest = {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	pathStyle: boolean;
	/** true also sets Strata's `enabled`; false never clears it */
	enable: boolean;
};

/** what the stored row says about the store; carries no key and no secret */
export type StrataStoreView = {
	provider: string;
	enabled: boolean;
	bucket: string;
	endpoint: string;
	region: string;
	hasKey: boolean;
	hasCredentials: boolean;
};

const ENDPOINT = /^https:\/\/[^/?#@\s]+\/?$/;
const BUCKET = /^[a-z0-9-]{3,63}$/;
const REGION = /^[A-Za-z0-9._-]{1,64}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,256}$/;

/** validates a request body; the refusal is a stable code and never repeats a value */
export function parseStoreRequest(
	body: unknown
): { ok: true; value: StrataStoreRequest } | { ok: false; code: string } {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, code: 'invalid_body' };
	}
	const b = body as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' ? v : '');
	const raw = str(b['endpoint']);
	let origin = '';
	if (raw.length <= 300 && ENDPOINT.test(raw)) {
		try {
			const url = new URL(raw);
			if (url.hostname !== '' && url.pathname === '/') origin = url.origin;
		} catch {
			// origin stays empty and the endpoint is refused below
		}
	}
	if (origin === '') return { ok: false, code: 'invalid_endpoint' };
	if (!BUCKET.test(str(b['bucket']))) return { ok: false, code: 'invalid_bucket' };
	if (!REGION.test(str(b['region']))) return { ok: false, code: 'invalid_region' };
	if (!CREDENTIAL.test(str(b['accessKeyId'])))
		return { ok: false, code: 'invalid_access_key_id' };
	if (!CREDENTIAL.test(str(b['secretAccessKey']))) {
		return { ok: false, code: 'invalid_secret_access_key' };
	}
	if (typeof b['pathStyle'] !== 'boolean') return { ok: false, code: 'invalid_path_style' };
	if (b['enable'] !== undefined && typeof b['enable'] !== 'boolean') {
		return { ok: false, code: 'invalid_enable' };
	}
	return {
		ok: true,
		value: {
			endpoint: origin,
			bucket: str(b['bucket']),
			region: str(b['region']),
			accessKeyId: str(b['accessKeyId']),
			secretAccessKey: str(b['secretAccessKey']),
			pathStyle: b['pathStyle'],
			enable: b['enable'] === true
		}
	};
}

/** the audit detail for a store write: the bucket, six characters of the key id, `enable=1` if set */
export function storeAuditDetail(want: StrataStoreRequest): string {
	const base = `bucket=${want.bucket}&accessKeyId=${encodeURIComponent(want.accessKeyId.slice(0, 6))}`;
	return want.enable ? `${base}&enable=1` : base;
}

/** unserialises the subset a config row holds: arrays, strings, numbers, booleans and null */
function parseSerialized(text: string): unknown {
	const bytes = new TextEncoder().encode(text);
	const decoder = new TextDecoder();
	let at = 0;
	const until = (stop: number): string => {
		const start = at;
		while (at < bytes.length && bytes[at] !== stop) at++;
		if (at >= bytes.length) throw new Error('truncated');
		return decoder.decode(bytes.subarray(start, at++));
	};
	const expect = (char: string): void => {
		if (bytes[at++] !== char.charCodeAt(0)) throw new Error('malformed');
	};
	const value = (): unknown => {
		const tag = String.fromCharCode(bytes[at++] ?? 0);
		if (tag === 'N') {
			expect(';');
			return null;
		}
		expect(':');
		switch (tag) {
			case 'b':
				return until(59) === '1';
			case 'i':
			case 'd':
				return Number(until(59));
			case 's': {
				const length = Number(until(58));
				expect('"');
				if (!(length >= 0) || at + length > bytes.length) throw new Error('truncated');
				const out = decoder.decode(bytes.subarray(at, at + length));
				at += length;
				expect('"');
				expect(';');
				return out;
			}
			case 'a': {
				const count = Number(until(58));
				expect('{');
				const out = Object.create(null) as Record<string, unknown>;
				for (let i = 0; i < count; i++) {
					const key = String(value());
					out[key] = value();
				}
				expect('}');
				return out;
			}
			default:
				throw new Error('unsupported');
		}
	};
	return value();
}

/** `strata.settings` as a tree, or undefined when the row is missing or unreadable */
function settingsTree(sql: ReconcileSql): Record<string, unknown> | undefined {
	try {
		const data = columnText(
			firstRow(
				sql.exec(
					"SELECT data FROM config WHERE collection = '' AND name = ?",
					'strata.settings'
				)
			)?.data
		);
		const tree = data === undefined ? undefined : parseSerialized(data);
		return typeof tree === 'object' && tree !== null
			? (tree as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function pick(tree: Record<string, unknown>, ...path: string[]): unknown {
	let node: unknown = tree;
	for (const key of path) {
		if (typeof node !== 'object' || node === null) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** the stored store settings without any secret, or undefined when there is no row */
export function readStrataStore(sql: ReconcileSql): StrataStoreView | undefined {
	const tree = settingsTree(sql);
	if (tree === undefined) return undefined;
	return {
		provider: text(pick(tree, 'provider')),
		enabled: pick(tree, 'enabled') === true,
		bucket: text(pick(tree, 's3', 'bucket')),
		endpoint: text(pick(tree, 's3', 'endpoint')),
		region: text(pick(tree, 's3', 'region')),
		hasKey: text(pick(tree, 'key')).trim() !== '',
		hasCredentials:
			text(pick(tree, 's3', 'access_key_id')).trim() !== '' &&
			text(pick(tree, 's3', 'secret_access_key')).trim() !== ''
	};
}

/** whether the stored row already holds this request and has a key; compares, never returns */
export function storeMatches(sql: ReconcileSql, want: StrataStoreRequest): boolean {
	const tree = settingsTree(sql);
	if (tree === undefined) return false;
	return (
		pick(tree, 'provider') === 's3' &&
		pick(tree, 's3', 'endpoint') === want.endpoint &&
		pick(tree, 's3', 'bucket') === want.bucket &&
		pick(tree, 's3', 'region') === want.region &&
		pick(tree, 's3', 'access_key_id') === want.accessKeyId &&
		pick(tree, 's3', 'secret_access_key') === want.secretAccessKey &&
		pick(tree, 's3', 'path_style') === want.pathStyle &&
		(!want.enable || pick(tree, 'enabled') === true) &&
		text(pick(tree, 'key')).trim() !== ''
	);
}
