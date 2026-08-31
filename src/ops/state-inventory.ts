/**
 * Which persistent state a replica may hold, at the granularity the state actually has.
 *
 * A TABLE IS NOT AN EFFECT, and this module exists because that was measured twice. `key_value`
 * holds the disposable `update_fetch_task:*` queue in the same table as `state:system.private_key`,
 * which Drupal mints lazily and keys CSRF tokens on -- two replicas each minting their own would
 * issue tokens the others reject. A per-table verdict is wrong in whichever direction it is set, so
 * classification here keys on `(table, collection, name)`.
 *
 * The second secret was found by enumerating rather than by reasoning: `state:system.cron_key` is
 * the token in the cron URL, and nothing had named it. Assume the list is still incomplete -- that
 * is what {@link UNKNOWN} and `tests/integration/state-inventory.spec.ts` are for.
 */

/**
 * What a replica may do with a piece of state.
 *
 * - `AUTHORITATIVE` -- one execution authority owns it. A replica receives it by replication and may
 *   never originate it. Installation identity and secrets live here.
 * - `REPLICABLE_DERIVED` -- computed from authoritative state. A replica may hold a copy and may
 *   recompute it locally without diverging.
 * - `LOCAL_EPHEMERAL` -- per-object by construction; a replica keeps its own and nothing is lost.
 * - `PRIMARY_ONLY_SIDE_EFFECT` -- an outbound or externally visible effect. Never performed on a
 *   replica, and dropping it is not automatically safe either.
 * - `UNKNOWN` -- unclassified, and therefore routed to the primary. This is the default.
 */
export type StateStatus =
	| 'AUTHORITATIVE'
	| 'REPLICABLE_DERIVED'
	| 'LOCAL_EPHEMERAL'
	| 'PRIMARY_ONLY_SIDE_EFFECT'
	| 'UNKNOWN';

/**
 * The `state:` keys that carry installation identity, enumerated from a provisioned site.
 *
 * `system.private_key` keys CSRF tokens and other HMACs; `system.cron_key` is the token in the cron
 * URL. Both are minted lazily on first use, which is exactly what makes them dangerous: a replica
 * that reaches the code path before replication has delivered the value will happily create one.
 */
const AUTHORITATIVE_STATE_KEYS: ReadonlySet<string> = new Set([
	'system.private_key',
	'system.cron_key',
	'install_time',
	'install_task'
]);

/** `key_value` collections whose every key is authoritative */
const AUTHORITATIVE_COLLECTIONS: ReadonlySet<string> = new Set([
	// module schema versions; the input to `update.php` and to every hook_update_N decision
	'system.schema',
	// which post-updates have run, so a replica disagreeing could re-run one
	'post_update'
]);

/** `key_value` collections that are derived from authoritative state and safe to recompute */
const DERIVED_COLLECTION_PREFIXES = [
	'config.entity.key_store.',
	'entity.definitions.',
	'entity.storage_schema.',
	'hook_data',
	'update_fetch_task',
	'update'
] as const;

/**
 * Tables a replica owns outright; see `isReplicaLocalTable()` for the write-path counterpart.
 *
 * ENUMERATED, never matched by pattern. A pattern that wrongly calls something local lets a replica
 * originate authoritative state, which is the failure mode this module exists to prevent; a pattern
 * that wrongly calls something authoritative only costs a failover, so the two directions get
 * different treatment; see {@link AUTHORITATIVE_TABLE_PATTERNS}.
 */
const LOCAL_TABLES: ReadonlySet<string> = new Set([
	'cfw_page',
	'cfw_shell',
	'cfw_shell_verified',
	// a compiled render plan: derived from two renders of a page this object can render again
	'cfw_plan',
	'cfw_meta',
	'cfw_health',
	// the primary's own replication log. Derived entirely from authoritative writes it already
	// committed, so losing it costs a replica a restore rather than any state; and a REPLICA never
	// writes one, because logging its own cache fills would replicate them back
	'cfw_repl_log',
	'cfw_fill_queue',
	'cfw_serve',
	// the fetch cache, and the boot heap snapshot: both rebuildable, both per-object
	'cfw_http_cache',
	'cfw_heap_chunk',
	'cfw_heap_snapshot',
	// workerd's own storage for `ctx.storage.put` and its metadata
	'_cf_KV',
	'_cf_METADATA',
	// invalidation checksums for the cache bins above, and a replica owns those bins. It must own
	// these with them: a checksum disagreeing with the bin it guards makes every row read as stale
	'cachetags'
]);

/** derived from authoritative state, so a replica may hold a copy and may rebuild it */
const DERIVED_TABLES: ReadonlySet<string> = new Set([
	// compiled from the route definitions, which are themselves config
	'router',
	// built from `menu_link_content`, and rebuilt by Drupal when that changes
	'menu_tree',
	// the packed module files; they arrive with the pack rather than from the primary
	'cfw_module_file'
]);

/** tables holding an outbound or externally visible effect */
const SIDE_EFFECT_TABLES: ReadonlySet<string> = new Set([
	'cfw_http_queue',
	'cfw_mail_queue',
	'cfw_page_mirror_queue',
	'cfw_file_mirror_queue'
]);

/**
 * Tables whose rows are authoritative wholesale.
 *
 * Drupal's own content and configuration, plus the host's durable file store. Listed rather than
 * inferred: an entity table added by a contrib module is UNKNOWN and routes to the primary, which
 * is the direction that fails safely.
 */
const AUTHORITATIVE_TABLES: ReadonlySet<string> = new Set([
	'config',
	'sessions',
	'users',
	'users_data',
	'users_field_data',
	'user__roles',
	'node',
	'node_field_data',
	'node_field_revision',
	'node_revision',
	'node__body',
	'node_access',
	'taxonomy_term_data',
	'taxonomy_term_field_data',
	'path_alias',
	'file_managed',
	'menu_link_content',
	'menu_link_content_data',
	'media',
	'media_field_data',
	'block_content',
	'block_content_field_data',
	'semaphore',
	'flood',
	'queue',
	'cfw_file',
	'cfw_file_chunk',
	'cfw_migrate',
	'cfw_updb_run',
	'cfw_updb_unit',
	'file_usage',
	'inline_block_usage',
	'taxonomy_index',
	// the batch API's working state; a batch is a write operation and never runs on a replica
	'batch',
	/**
	 * THE ID GENERATOR, and the third lazily-dangerous value this inventory turned up.
	 *
	 * Two replicas each allocating from their own `sequences` would mint colliding entity ids, and
	 * nothing would error until the rows met. In the same family as the two secrets: the danger is
	 * that a replica can ORIGINATE the value rather than that it merely holds it.
	 */
	'sequences'
]);

/**
 * Patterns that make a table authoritative, applied only after every explicit list above.
 *
 * PATTERNS ARE ALLOWED HERE AND NOWHERE ELSE, because this is the direction that fails safely: a
 * table wrongly matched costs a failover to the primary, while a table wrongly matched as local or
 * derived lets a replica originate state. Entity storage is where the table count actually grows --
 * a contrib module adds `node__field_x`, `node_revision__field_x` and so on -- and enumerating it
 * would be a list nobody prunes.
 */
const AUTHORITATIVE_TABLE_PATTERNS: readonly RegExp[] = [
	// a field data table: `node__body`, `media__field_media_image`, `user__user_picture`
	/^[a-z0-9_]+__[a-z0-9_]+$/,
	// any revision storage
	/_revision$/,
	/_revision__[a-z0-9_]+$/,
	/_field_revision$/
];

/** a dblog row; the entry is mirrored to `console.log`, which outlives the isolate the row lives in */
const LOG_TABLES: ReadonlySet<string> = new Set(['watchdog']);

/**
 * The status of one piece of state.
 *
 * @param table
 *   The SQL table.
 * @param collection
 *   For `key_value` and `key_value_expire`, the collection column. Ignored otherwise.
 * @param name
 *   For `key_value` and `key_value_expire`, the name column. Ignored otherwise.
 */
export function classifyState(table: string, collection?: string, name?: string): StateStatus {
	if (table === '') return 'UNKNOWN';
	// derived and rebuildable by definition, and the one prefix rule that is safe here
	if (table.startsWith('cache_')) return 'LOCAL_EPHEMERAL';
	if (LOCAL_TABLES.has(table)) return 'LOCAL_EPHEMERAL';
	if (SIDE_EFFECT_TABLES.has(table)) return 'PRIMARY_ONLY_SIDE_EFFECT';
	if (LOG_TABLES.has(table)) return 'PRIMARY_ONLY_SIDE_EFFECT';

	if (table === 'key_value' || table === 'key_value_expire') {
		// a collection with no name cannot be judged: the same collection carries both classes
		if (collection === undefined || collection === '') return 'UNKNOWN';
		if (collection === 'state') {
			if (name === undefined || name === '') return 'UNKNOWN';
			return AUTHORITATIVE_STATE_KEYS.has(name) ? 'AUTHORITATIVE' : 'REPLICABLE_DERIVED';
		}
		if (AUTHORITATIVE_COLLECTIONS.has(collection)) return 'AUTHORITATIVE';
		if (DERIVED_COLLECTION_PREFIXES.some((p) => collection === p || collection.startsWith(p))) {
			return 'REPLICABLE_DERIVED';
		}
		return 'UNKNOWN';
	}

	if (AUTHORITATIVE_TABLES.has(table)) return 'AUTHORITATIVE';
	if (DERIVED_TABLES.has(table)) return 'REPLICABLE_DERIVED';
	// last, so an explicit verdict always wins over a pattern
	if (AUTHORITATIVE_TABLE_PATTERNS.some((p) => p.test(table))) return 'AUTHORITATIVE';
	return 'UNKNOWN';
}

/** whether a replica may hold this state at all without the primary handing it over */
export function replicaMayOriginate(status: StateStatus): boolean {
	return status === 'LOCAL_EPHEMERAL' || status === 'REPLICABLE_DERIVED';
}

/**
 * Whether a request touching this state may be answered by a replica.
 *
 * `UNKNOWN` answers false, which is what the status is for.
 */
export function replicaMayServe(status: StateStatus): boolean {
	return status !== 'UNKNOWN' && status !== 'PRIMARY_ONLY_SIDE_EFFECT';
}
