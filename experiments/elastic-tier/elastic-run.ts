import type { SiteEnv } from '../env';
import { LogicalHeap, Pager, physicalPagesFor, type PageStore } from '../runtime/elastic-pager';
import type { SitePhpDurableObject } from '../site-do';
import { type ElasticExecutor, type ElasticResult } from './elastic';
import { GrowthRefused, noteGrowthRefusal } from './growth/cap';
import { route } from './serve';

const MIB = 1_048_576;
const PAGE_BYTES = 65_536;
const PAGE_TABLE = 'cfw_elastic_pages';

/** what one elastic request may hold and spend */
export interface ElasticLimits {
	/** 64 KiB frames resident at once; the rest of the logical heap lives in the page table */
	frames: number;
	/** the most logical memory the request may reach */
	capBytes: number;
	/** page rows the request may write; a Free-plan object has 100,000 rows a day */
	pageWrites: number;
}

function positive(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * The elastic request's own budget. The frame count is the 16 MiB window the deployed paged probe
 * ran at, the cap is its tested ceiling, and the write budget is 5% of the Free-plan row day.
 */
export function elasticLimits(env: SiteEnv | undefined): ElasticLimits {
	return {
		frames: positive(env?.ELASTIC_FRAMES) ?? 256,
		capBytes: positive(env?.ELASTIC_CAP_BYTES) ?? 384 * MIB,
		pageWrites: positive(env?.ELASTIC_PAGE_WRITES) ?? 5_000
	};
}

/** page rows kept in the object's own SQLite for the length of one elastic request */
class SqlPageStore implements PageStore {
	storedBytes = 0;
	reads = 0;
	writes = 0;
	private seen = new Set<number>();

	constructor(
		private sql: SitePhpDurableObject['sql'],
		private budget: number,
		private onBudget: () => never
	) {
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${PAGE_TABLE} (page INTEGER PRIMARY KEY, value BLOB NOT NULL)`
		);
		this.sql.exec(`DELETE FROM ${PAGE_TABLE}`);
	}

	read(page: number, into: Uint8Array): void {
		const row = this.sql.exec(`SELECT value FROM ${PAGE_TABLE} WHERE page = ?`, page).toArray()[0];
		const value = row?.['value'];
		if (!(value instanceof ArrayBuffer) || value.byteLength !== PAGE_BYTES)
			throw new Error(`elastic page ${page} is missing from the page table`);
		into.set(new Uint8Array(value));
		this.reads += 1;
	}

	write(page: number, bytes: Uint8Array): void {
		if (this.writes >= this.budget) this.onBudget();
		this.sql.exec(
			`INSERT INTO ${PAGE_TABLE} VALUES (?, ?) ON CONFLICT(page) DO UPDATE SET value = excluded.value`,
			page,
			bytes.slice().buffer
		);
		if (!this.seen.has(page)) {
			this.seen.add(page);
			this.storedBytes += PAGE_BYTES;
		}
		this.writes += 1;
	}

	drop(): void {
		this.sql.exec(`DROP TABLE IF EXISTS ${PAGE_TABLE}`);
	}
}

/** what the last elastic request cost, for the stats route and the specs */
export interface ElasticRun {
	pageReads: number;
	pageWrites: number;
	faults: number;
	evictions: number;
	logicalBytes: number;
	physicalBytes: number;
}

const unavailable = (reason: string): ElasticResult => ({ state: 'unavailable', reason });

/** an elastic interpreter booted on a site, and what it holds until {@link ElasticSession.close} */
export interface ElasticSession {
	/** reads what the request cost so far */
	read(): ElasticRun;
	/** drops the interpreter, restores the shipped binary seam and clears the page table */
	close(): void;
	pager: Pager;
}

/**
 * Boots the translated interpreter over a pager on `site`. The site's next `run()` and `route()`
 * use it until the session closes. `frames` overrides the configured window.
 */
export async function openElastic(
	site: SitePhpDurableObject,
	limits: ElasticLimits = elasticLimits(site.env)
): Promise<ElasticSession | string> {
	if (site.seamOverride) return 'an elastic request is already running';
	let binary: typeof import('../runtime/elastic-binary');
	try {
		binary = await import('../runtime/elastic-binary');
	} catch {
		return 'no elastic interpreter is installed on this build';
	}
	const layout = {
		...binary.elasticLayout,
		frameRuns: binary.elasticLayout.frameRuns.map(
			([lo, hi]) => [lo, hi ?? Infinity] as [number, number]
		)
	};
	const physical = physicalPagesFor(layout, limits.frames);
	const memory = new WebAssembly.Memory({ initial: physical, maximum: physical });
	const stop = (): never => {
		noteGrowthRefusal(site, {
			fromBytes: pager.logicalBytes,
			toBytes: pager.logicalBytes,
			capBytes: limits.capBytes
		});
		throw Object.assign(new Error('the elastic page budget is spent'), {
			name: 'ExitStatus',
			status: 1
		});
	};
	const store = new SqlPageStore(site.sql, limits.pageWrites, stop);
	const pager = new Pager({
		memory,
		layout,
		frames: limits.frames,
		store,
		logicalBytes: layout.heapStart * PAGE_BYTES
	});
	const heap = new LogicalHeap(pager);
	site.seamOverride = {
		factory: binary.PHPFactory,
		module: binary.wasmModule as WebAssembly.Module,
		elastic: {
			memory,
			pager,
			heap,
			capBytes: limits.capBytes,
			onRefuse: (fromBytes, toBytes) =>
				noteGrowthRefusal(site, { fromBytes, toBytes, capBytes: limits.capBytes })
		}
	};
	try {
		site.dropInterpreter();
		await site.ensurePhp({ skipRestore: true });
	} catch (e) {
		site.seamOverride = undefined;
		site.dropInterpreter();
		throw e;
	}
	return {
		pager,
		read: () => ({
			pageReads: store.reads,
			pageWrites: store.writes,
			faults: pager.stats.slow + pager.stats.wslow,
			evictions: pager.stats.evictions,
			logicalBytes: pager.logicalBytes,
			physicalBytes: memory.buffer.byteLength
		}),
		close: () => {
			site.dropInterpreter();
			site.seamOverride = undefined;
			try {
				store.drop();
			} catch {
				// the page table is scratch; the next request recreates and empties it
			}
		}
	};
}

/**
 * The executor this build ships. It boots the translated interpreter over a pager whose frames are
 * a fixed window, serves the request through the normal route with its own cap, and drops the
 * interpreter after. A request the cap or the write budget stops answers unavailable and its
 * writes roll back with the slice, so the dispatcher answers the refusal it already had.
 */
export function elasticExecutorFor(site: SitePhpDurableObject): ElasticExecutor {
	return async (request) => {
		// the platform's own ladder: a site near its row day does not spend rows on page writes
		if (site.degradation().level !== 'normal')
			return unavailable('the site is past its daily row allowance for discretionary work');
		const session = await openElastic(site);
		if (typeof session === 'string') return unavailable(session);
		try {
			const response = await route(site, request);
			site.lastElastic = session.read();
			return { state: 'served', response };
		} catch (e) {
			if (e instanceof GrowthRefused)
				return unavailable('the request needs more than the elastic cap or page budget');
			throw e;
		} finally {
			session.close();
		}
	};
}
