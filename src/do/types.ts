import type { LazyBinary, LazyFS } from '@drupflare/cartridge/fs';
import type { RowBudget } from '../ops/replica-demand';

/** a sliced operation request: the op name, positional args and paging options */
export type OpsJob = {
	name: string;
	args: string[];
	options: {
		offset?: number;
		limit?: number;
		payload?: unknown;
		collections?: unknown;
		budget?: unknown;
	};
};

/**
 * A parsed-JSON payload (a PHP fragment's reply, a migrator step, a GC ledger, an updb beat).
 * `any` values, not `unknown`: callers add fields after the fact and casts would not be safer.
 */
export type Payload = Record<string, any>;

/** One fault a catch absorbed, as `/serve-stats` reports it under `recentErrors`. */
export type ErrorNote = {
	/** epoch ms the catch ran */
	at: number;
	/** the function whose catch absorbed it */
	where: string;
	/** the thrown value's message */
	message: string;
	/** the start of the stack, when the thrown value had one */
	stack?: string;
};

/** A result row, with the index signature `exec<T>()` requires alongside the columns named. */
export type Row<T> = T & Record<string, SqlStorageValue>;

/** One `cfw_page` row, which is what both serving lanes read and `pageResponse()` renders. */
export type PageRow = Row<{
	status: number;
	content_type: string | null;
	html: string;
	rendered_at: number;
	render_ms: number | null;
}>;

/**
 * The php-wasm Module as the host uses it: php-wasm types `FS` as bare `object` and the `cfw*`
 * members are installed here, so the shape is named once and cast where `php.binary` resolves.
 */
export interface SiteBinary extends LazyBinary {
	FS: LazyFS & { readFile(path: string): Uint8Array };
	[key: string]: unknown;
}

/** php-wasm's `output` / `error` events; `detail` is one line or a batch of them. */
export type PhpOutputEvent = Event & { detail?: string | string[] };

/**
 * What one fill produced: `filled` is the path or null, and the rest belongs to one of three
 * outcomes (rendered, failed, or an empty queue).
 */
export interface FillOutcome {
	filled: string | null;
	remaining: number;
	failed?: string;
	error?: string;
	/** what PHP printed instead of its result, for the log only */
	raw?: string;
	/** the site is not ready (Drupal redirected to `/core/install.php`); the render is fine */
	notReady?: boolean;
	attempts?: number;
	bytes?: unknown;
	renderMs?: unknown;
	pageCache?: unknown;
	dynamicCache?: unknown;
	/**
	 * whether this fill also paid for the interpreter boot.
	 * Measured inside the fill: `!this.php` at the caller can read cold when an alarm has booted
	 * the object before the render runs. Distinct from `booted`, which means an interpreter is up.
	 */
	bootedInFill?: boolean;
	/** the sorted role set this render was for (the edge plan key), or undefined */
	roles?: string[];
	/**
	 * The rendered response, present only when it was not cached.
	 * A GET is read back from `cfw_page` by the caller; a submission or authenticated GET is never
	 * stored there, so it comes back here instead.
	 */
	page?: {
		status: number;
		contentType: string;
		html: unknown;
		renderMs: number;
		/** `Set-Cookie` lines Drupal produced; without these a login cannot be kept */
		setCookie: string[];
		/** `Location`, so a login's redirect survives instead of rendering as an empty 302 body */
		location?: string;
		/** the `x-drupal-*` headers the client reads; see {@link passThroughHeaders} */
		passHeaders?: Record<string, string>;
	};
}

/**
 * How a shell-served response was authorised for the visitor who received it.
 * `proven` and `refused` both answer from the visitor's own harvest; they differ in what happened
 * to the stored shell.
 */
export type ShellVerdict = 'cached' | 'proven' | 'refused';

/** The methods of the vrzno handle table that a delegating wrapper forwards. */
export type HandleTableOps = {
	get(id: number): unknown;
	add(o: object): number;
	getId(o: object): number | undefined;
	has(o: object): number | undefined;
	hasId(id: number): unknown;
	remove(id: number): void;
};

/** a shell-served page: the assembled html, holes filled and how it was authorised */
export type ShellAssembly = {
	html: string;
	holes: number;
	verified: ShellVerdict;
	roles?: string[];
};

/** a rendered response a herd of identical requests shares (the leader's body, status, headers) */
export type SharedRender = {
	body: ArrayBuffer;
	status: number;
	headers: [string, string][];
};

/** What a lane's forwarded write came to: the primary's verdict, or the lane's own refusal. */
export type ForwardOutcome = { action: string; reason: string; generation?: number };

/** The row-budget reading that stopped a pool growing, stamped with when and at what size. */
export type LaneRowsCap = { at: number; lanes: number } & RowBudget;
