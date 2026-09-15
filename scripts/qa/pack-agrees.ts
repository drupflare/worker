import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { packVersionsHash } from '../pack-hash.js';

/**
 * Whether the pack on disk and the tracked database were built from the same composer state.
 *
 * `DrupalKernel::getContainerCacheKey()` folds `DrupalInstalled::VERSIONS_HASH` in, so the pack and
 * the database each carry it and they must agree. When they do not, every first `$kernel->boot()`
 * rebuilds a 482 KB container -- 1,024 ms against 86 -- and a handful of specs fail with magnitudes
 * that look unrelated to each other: a container cid mismatch, a table count one short, a rows-per-
 * fill figure eight low.
 *
 * THE FAILURE MODE THIS EXISTS FOR IS `hydrate` HANDING BACK AN OLDER PACK. The database is tracked
 * and arrives at HEAD; `assets/drupal-pf` arrives from a published release payload, which was built
 * whenever that release was cut. A tree whose database has since been rebuilt therefore hydrates
 * into a disagreement, and nothing said so -- the three specs above did, in three different
 * vocabularies, none of which names the cause.
 *
 * Exits 0 when they agree or when there is nothing to compare, 1 when they disagree, so a lane can
 * use it to decide whether to rebuild from source.
 */
export function packAgreesWithDatabase(root = process.cwd()): {
	agrees: boolean;
	pack: string | null;
	database: string | null;
	why?: string;
} {
	const db = `${root}/assets/drupal/site.sqlite`;
	if (!existsSync(db)) return { agrees: true, pack: null, database: null, why: 'no database' };

	let pack: string | null = null;
	try {
		pack = packVersionsHash();
	} catch {
		return { agrees: true, pack: null, database: null, why: 'no pack' };
	}

	// NOT `readOnly`, and a read failure is NOT agreement. The first version opened read-only and
	// swallowed every exception as "nothing to compare", which made it exit 0 on a database it could
	// not open at all -- `readOnly: true` fails with `unable to open database file` whenever a WAL
	// needs recovering, so the guard reported agreement on exactly the broken trees it exists for.
	// Falsifying it is what found that; an unreadable database is now a hard error.
	let database: string | null = null;
	try {
		const handle = new DatabaseSync(db);
		const row = handle.prepare('SELECT cid FROM cache_container LIMIT 1').get() as
			{ cid?: string } | undefined;
		handle.close();
		if (row === undefined)
			return { agrees: true, pack, database: null, why: 'no container row' };
		// `service_container:prod:<hash>::Linux:...`, and the hash is the third field
		database = String(row.cid ?? '').split(':')[2] ?? null;
	} catch (e) {
		return {
			agrees: false,
			pack,
			database: null,
			why: `the database could not be read: ${String((e as Error)?.message ?? e)}`
		};
	}

	if (!database)
		return { agrees: false, pack, database: null, why: 'the container row has no hash' };
	return { agrees: pack === database, pack, database };
}

if (import.meta.main) {
	const out = packAgreesWithDatabase();
	if (out.why && out.agrees) {
		console.log(`pack-agrees: nothing to compare (${out.why})`);
		process.exit(0);
	}
	console.log(`pack-agrees: pack ${out.pack} database ${out.database ?? 'unreadable'}`);
	if (!out.agrees) {
		console.error(
			out.why ??
				'the hydrated pack and the tracked database were built from different composer states'
		);
		process.exit(1);
	}
}
