import {
	MIRRORABLE_SCHEMES,
	OFFLOAD_SCHEMES,
	hydrateFile,
	privateUriForPath,
	type FileBucket,
	type FileBuckets,
	type MirrorBucket
} from '../db/file-store';
import type { FileOffloadHost } from './host';
import { r2WriteBudget } from './levers';

/** the origin public bytes are served from, or '' when everything goes through the Worker */
export function publicFilesOrigin(host: FileOffloadHost): string {
	return String(host.env?.FILES_PUBLIC_URL ?? '').replace(/\/+$/, '');
}

/**
 * The R2 bucket to offload files to, or undefined when there is none.
 *
 * An absent bucket is supported (the free-tier default): files live durably in DO SQL and R2
 * only buys serving headroom. Typed structurally so the drain runs over a stand-in.
 */
export function mirrorBucket(host: FileOffloadHost): MirrorBucket | undefined {
	const bucket = (host.env as { FILES?: MirrorBucket } | undefined)?.FILES;
	return bucket && typeof bucket.put === 'function' ? bucket : undefined;
}

/**
 * The sites whose R2 prefix this site may read or copy from: the comma-separated names under
 * `file_clone:<this site>` in `CONFIG_KV`. Only the platform writes that key (a tenant's own
 * writes land on `plan:` and `settings:` keys), so a restore body cannot name a prefix into it.
 * Empty when there is no grant or no KV, and a failed read grants nothing.
 */
export async function trustedFileSources(host: FileOffloadHost): Promise<ReadonlySet<string>> {
	const now = Date.now();
	if (host.fileOffload.grant !== undefined && now - host.fileOffload.grant.at < 30_000)
		return host.fileOffload.grant.sources;
	let sources = new Set<string>();
	try {
		const kv = (host.env as { CONFIG_KV?: KVNamespace } | undefined)?.CONFIG_KV;
		const raw = kv ? await kv.get(`file_clone:${host.siteName()}`) : null;
		sources = new Set(
			String(raw ?? '')
				.split(',')
				.map((n) => n.trim())
				.filter((n) => n !== '' && n !== host.siteName())
		);
	} catch (e) {
		host.noteError('trustedFileSources', e);
	}
	host.fileOffload.grant = { at: now, sources };
	return sources;
}

/** whether R2 is the file store: `FILE_STORE=r2` and `FILES` bound */
export function fileStoreR2(host: FileOffloadHost): boolean {
	return String(host.env?.FILE_STORE ?? '') === 'r2' && host.mirrorBucket() !== undefined;
}

/** the readable buckets; `private` is unbound unless the managed config attaches it */
export function fileBuckets(host: FileOffloadHost): FileBuckets {
	const env = host.env as { FILES?: FileBucket; FILES_PRIVATE?: FileBucket } | undefined;
	const usable = (b?: FileBucket) =>
		b && typeof b.put === 'function' && typeof b.get === 'function' ? b : undefined;
	return { public: usable(env?.FILES), private: usable(env?.FILES_PRIVATE) };
}

/**
 * The schemes a write queues for R2. `private://` joins only when R2 is the store and a private
 * bucket is bound; otherwise it stays in the object, as it always has.
 */
export function fileSchemes(host: FileOffloadHost): readonly string[] {
	return host.fileStoreR2() && host.fileBuckets().private ? OFFLOAD_SCHEMES : MIRRORABLE_SCHEMES;
}

/**
 * Restores an evicted private file before PHP serves it. A download reads the file inside a
 * synchronous run that cannot wait for R2, so the restore has to happen first; one read of the
 * row on every `/system/files/` request, and nothing for any other path.
 */
export async function hydrateForRequest(host: FileOffloadHost, url: URL): Promise<void> {
	const path = url.pathname === '/__serve' ? url.searchParams.get('path') : null;
	const uri = path === null ? undefined : privateUriForPath(path);
	if (uri === undefined) return;
	try {
		await hydrateFile(host.sql, host.fileBuckets(), uri, {
			nowMs: host.nowMs(),
			site: host.siteName(),
			schemes: host.fileSchemes(),
			trust: () => host.trustedFileSources()
		});
	} catch (e) {
		// PHP then answers its own refusal and queues the restore
		host.noteError('hydrateForRequest', e);
	}
}

/** this month's R2 writes against {@link r2WriteBudget}; the key carries the month */
export function r2Allowance(host: FileOffloadHost): {
	month: string;
	used: number;
	budget: number;
	left: number;
} {
	const month = new Date().toISOString().slice(0, 7);
	const used = Number(host.metaGet(`r2_writes:${month}`, '0')) || 0;
	const budget = r2WriteBudget(host.env);
	return { month, used, budget, left: Math.max(0, budget - used) };
}

/** adds `ops` to this month's R2 write tally (deletes count too, so it reads high) */
export function chargeR2(host: FileOffloadHost, ops: number): void {
	if (ops <= 0) return;
	const { month, used } = host.r2Allowance();
	host.metaSet(`r2_writes:${month}`, used + ops);
}
