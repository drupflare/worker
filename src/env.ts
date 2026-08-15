import type { SiteEnv as BaseSiteEnv } from '@drupflare/durabledb/do-sqlite';

/**
 * The worker's environment: `@drupflare/durabledb`'s generic shape plus the vars only this
 * application reads.
 *
 * These four stay here rather than in the package because nothing else could act on them -- heap
 * restore, the R2 mirror drain and prefill are all worker concerns.
 */
export interface SiteEnv extends BaseSiteEnv {
	HEAP_SNAPSHOT?: string;
	HEAP_RESTORE_CHUNKS?: string | number;
	MIRROR_LIMIT?: string | number;
	PREFILL?: string;
	DRUPAL_CRON?: string;
	CRON_MAX_UNITS?: string | number;
	CRON_MAX_ROWS?: string | number;
	CRON_MAX_MS?: string | number;
	/** logs every Drupal statement through console.log, which survives an object reset */
	PW_SQL_TRACE?: string;
	/** first statement number to log, so a 256 KB tail budget covers the END of a long run */
	PW_SQL_TRACE_FROM?: string | number;
}
