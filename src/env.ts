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
}
