/**
 * Which persistent state a replica may hold, keyed on `(table, collection, name)`: `key_value`
 * holds a disposable queue beside `state:system.private_key`, so no per-table verdict is right.
 * Assume the lists are incomplete; anything unlisted is `UNKNOWN` and routes to the primary.
 *
 * @module
 */

/**
 * What a replica may do with a piece of state.
 *
 * - `AUTHORITATIVE`: replicated in, never originated on a replica (identity, secrets, content).
 * - `REPLICABLE_DERIVED`: computed from authoritative state; a replica may recompute it.
 * - `LOCAL_EPHEMERAL`: per-object; a replica keeps its own.
 * - `PRIMARY_ONLY_SIDE_EFFECT`: an outbound effect, never performed on a replica.
 * - `UNKNOWN`: the default, routed to the primary.
 */
export type StateStatus =
	| 'AUTHORITATIVE'
	| 'REPLICABLE_DERIVED'
	| 'LOCAL_EPHEMERAL'
	| 'PRIMARY_ONLY_SIDE_EFFECT'
	| 'UNKNOWN';

// `state:` keys carrying installation identity; the two keys are minted lazily, so a replica
// reaching the code path before replication would mint its own
const AUTHORITATIVE_STATE_KEYS: ReadonlySet<string> = new Set([
	'system.private_key',
	'system.cron_key',
	'install_time',
	'install_task'
]);

// `key_value` collections whose every key is authoritative
const AUTHORITATIVE_COLLECTIONS: ReadonlySet<string> = new Set([
	// module schema versions; the input to `update.php` and to every hook_update_N decision
	'system.schema',
	// which post-updates have run, so a replica disagreeing could re-run one
	'post_update'
]);

// `key_value` collections derived from authoritative state and safe to recompute
const DERIVED_COLLECTION_PREFIXES = [
	'config.entity.key_store.',
	'entity.definitions.',
	'entity.storage_schema.',
	'hook_data',
	'update_fetch_task',
	'update',
	// keyed by an HMAC of its value under the site salt, so every writer writes the same row
	'entity_autocomplete'
] as const;

// tables a replica owns outright (`isReplicaLocalTable()` is the write-path counterpart);
// enumerated, never a pattern, since a wrong match would let a replica originate state
const LOCAL_TABLES: ReadonlySet<string> = new Set([
	'cfw_page',
	'cfw_shell',
	'cfw_shell_verified',
	// a compiled render plan: derived from two renders of a page this object can render again
	'cfw_plan',
	'cfw_meta',
	'cfw_health',
	// the primary's replication log; losing it costs a restore, and a replica never writes one
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
	// checksums for the replica's own bins; one disagreeing with its bin makes rows read stale
	'cachetags'
]);

// derived from authoritative state, so a replica may hold a copy and may rebuild it
const DERIVED_TABLES: ReadonlySet<string> = new Set([
	// compiled from the route definitions, which are themselves config
	'router',
	// built from `menu_link_content`, and rebuilt by Drupal when that changes
	'menu_tree',
	// the packed module files; they arrive with the pack rather than from the primary
	'cfw_module_file',
	// fragment content addresses, all inputs authoritative elsewhere; a lost row costs a re-harvest
	'cfw_fragment'
]);

// tables holding an outbound or externally visible effect
const SIDE_EFFECT_TABLES: ReadonlySet<string> = new Set([
	'cfw_http_queue',
	'cfw_mail_queue',
	'cfw_page_mirror_queue',
	'cfw_file_mirror_queue'
]);

// tables authoritative wholesale: Drupal content and config plus the host's durable stores
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
	// the uploaded module store is the only copy of those bytes (`cfw_module_file` is derived)
	'cfw_module_blob',
	'cfw_module_rev',
	// delivered libraries' autoload maps; settings.php needs them at boot or a class fatals
	'cfw_package_autoload',
	'file_usage',
	'inline_block_usage',
	'taxonomy_index',
	// the batch API's working state; a batch is a write operation and never runs on a replica
	'batch',
	// the id generator: two replicas allocating from their own would mint colliding ids
	'sequences'
]);

// patterns only here, after the lists: a wrong authoritative match only costs a failover, and
// contrib field tables grow without bound
const AUTHORITATIVE_TABLE_PATTERNS: readonly RegExp[] = [
	// a field data table: `node__body`, `media__field_media_image`, `user__user_picture`
	/^[a-z0-9_]+__[a-z0-9_]+$/,
	// any revision storage
	/_revision$/,
	/_revision__[a-z0-9_]+$/,
	/_field_revision$/
];

// dblog rows; each entry is mirrored to `console.log`, which outlives the isolate
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
	// rebuildable by definition, the one safe prefix rule
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
