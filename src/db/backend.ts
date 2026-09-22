/**
 * Where a site's SQL executes, selected rather than assumed.
 *
 * `ctx.storage.sql` is the default and stays it: one object per site holding both the interpreter
 * and the database is what makes a render cost no network, and `docs/external-database.md` is right
 * that nothing about the managed product wants a second one.
 *
 * What it is not right about is the SELF-HOSTED tier, which is why the roadmap promoted this. Every
 * blocker that document lists -- the Hyperdrive configuration cap, the 100,000 queries a day, the
 * missing MySQL `COM_STMT_PREPARE` -- is a property of a Cloudflare account, and a workerd an
 * operator runs has none. An external database is also what removes the 5 GB account-wide storage
 * cap, which is today the only hard limit on fleet size.
 *
 * ## The blocker was never the wire protocol
 *
 * Hyperdrive supplies a pooled endpoint and a connection string, not a client: Cloudflare's own
 * get-started says "you will need a database driver" and its worked example imports `Client` from
 * `pg`. So the client is one npm dependency in the Worker, in JavaScript, and there is no PHP wire
 * protocol to write.
 *
 * The blocker is that `cfwSqlExec` is SYNCHRONOUS by construction -- which is the same sentence that
 * explains why KV, R2, D1 and `env.ASSETS.fetch()` are unreachable from inside a read -- and a `pg`
 * query is not. {@link ../ops/park-drive.ts} is what closes it: PHP yields, the host performs the
 * query while the continuation is frozen, and the chain resumes inside the same invocation.
 */

/** the backends this Worker knows how to reach */
export type BackendName = 'do-sqlite' | 'hyperdrive';

/**
 * Which database the connection string names.
 *
 * Read from the SCHEME rather than configured separately, because a second knob that can disagree
 * with the connection string is a knob that will. Hyperdrive takes `postgres://` and `mysql://` and
 * hands the string straight to a driver, so the string is already the declaration.
 */
export type BackendDialect = 'postgres' | 'mysql';

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
export function dialectOf(connectionString: string): BackendDialect | null {
	const scheme = String(connectionString).slice(0, connectionString.indexOf('://')).toLowerCase();
	if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
	if (scheme === 'mysql') return 'mysql';
	return null;
}

/** what the selection reads; `HYPERDRIVE` is the binding Cloudflare injects */
export type BackendEnv = {
	DB_BACKEND?: string | undefined;
	HYPERDRIVE?: { connectionString?: string } | null | undefined;
};

export const DEFAULT_BACKEND: BackendName = 'do-sqlite';

/**
 * Which backend this site's SQL goes to.
 *
 * DEFAULTS TO THE OBJECT'S OWN STORAGE and says so rather than falling back silently: a deployment
 * that asked for Hyperdrive and did not bind one must read as misconfigured, not as a site quietly
 * running on a different database from the one its operator chose. That is the shape the roadmap's
 * own "decorative configuration" class is made of.
 *
 * @param env the Worker env; `HYPERDRIVE` is the binding rather than a var, so a deploy that omits
 *   the binding cannot be talked into using it by a KV override.
 */
export function selectBackend(env: BackendEnv | null | undefined): BackendSelection {
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
	if (dialect === null) {
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
 * Exactly the reachable external backends. Arming the yield for a backend the host cannot serve is
 * the measured failure this project already has a rule about: a class armed and not served routes
 * every render through `cfw_park_run` for a yield that always falls back.
 */
export function backendNeedsPark(selection: BackendSelection): boolean {
	return selection.available && selection.name !== 'do-sqlite';
}
