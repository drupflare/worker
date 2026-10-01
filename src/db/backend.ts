/** the backends this Worker knows how to reach */
export type BackendName = 'do-sqlite' | 'hyperdrive';

/**
 * Which database the connection string names.
 *
 * Read from the scheme, not a second knob that could disagree with the connection string.
 */
export type BackendDialect = 'postgres' | 'mysql';

/** the chosen backend, whether this deployment can reach it, and how to talk to it */
export type BackendSelection = {
	name: BackendName;
	/** false when the deployment names a backend it cannot reach; `why` says what is missing */
	available: boolean;
	why: string;
	/** the pooled connection string, present only for a reachable external backend */
	connectionString?: string;
	/** which client answers it; absent when there is no external backend */
	dialect?: BackendDialect;
};

/** `postgres://`, `postgresql://` and `mysql://` are what Hyperdrive itself accepts */
export function dialectOf(connectionString: string): BackendDialect | undefined {
	const scheme = String(connectionString).slice(0, connectionString.indexOf('://')).toLowerCase();
	if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
	if (scheme === 'mysql') return 'mysql';
	return undefined;
}

/** what the selection reads; `HYPERDRIVE` is the binding Cloudflare injects */
export type BackendEnv = {
	DB_BACKEND?: string | undefined;
	HYPERDRIVE?: { connectionString?: string } | undefined;
};

/** the object's own storage, which stays the default */
export const DEFAULT_BACKEND: BackendName = 'do-sqlite';

/**
 * Which backend this site's SQL goes to.
 *
 * Defaults to the object's own storage (a render costs no network). A deployment that asked for
 * Hyperdrive without binding one reads as unavailable, with `why`, not as a silent fallback.
 * An external backend needs the park: `cfwSqlExec` is synchronous and a `pg` query is not.
 *
 * @param env the Worker env; `HYPERDRIVE` is a binding rather than a var, so a KV override cannot
 *   talk a deploy that omits it into using it.
 */
export function selectBackend(env: BackendEnv | undefined): BackendSelection {
	const asked = String(env?.DB_BACKEND ?? '')
		.trim()
		.toLowerCase();
	if (asked === '' || asked === DEFAULT_BACKEND) {
		return { name: DEFAULT_BACKEND, available: true, why: '' };
	}
	if (asked !== 'hyperdrive') {
		return {
			name: DEFAULT_BACKEND,
			available: false,
			why: `DB_BACKEND must be do-sqlite or hyperdrive; got ${asked}`
		};
	}
	const connectionString = String(env?.HYPERDRIVE?.connectionString ?? '');
	if (connectionString === '') {
		return {
			name: 'hyperdrive',
			available: false,
			why: 'DB_BACKEND=hyperdrive but no HYPERDRIVE binding is bound to this Worker'
		};
	}
	const dialect = dialectOf(connectionString);
	if (dialect === undefined) {
		return {
			name: 'hyperdrive',
			available: false,
			why: 'the HYPERDRIVE connection string names neither postgres:// nor mysql://'
		};
	}
	return { name: 'hyperdrive', available: true, why: '', connectionString, dialect };
}

/**
 * Whether PHP should yield its SQL to the host instead of calling the synchronous bridge.
 *
 * Exactly the reachable external backends: arming a yield the host cannot serve routes every
 * render through `cfw_park_run` for a yield that always falls back.
 */
export function backendNeedsPark(selection: BackendSelection): boolean {
	return selection.available && selection.name !== 'do-sqlite';
}
