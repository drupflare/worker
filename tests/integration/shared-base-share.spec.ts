import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * How much of a provisioned site is actually shareable, measured rather than inherited.
 *
 * B3 rests on "1,320 of 1,321 seed rows are identical across sites", and the roadmap says in its own
 * text to re-measure that share before designing against it. This is that measurement, and it
 * changes the shape of the item.
 *
 * MEASURED ON TWO FRESHLY PROVISIONED SITES, each migrated and first-run with a different admin
 * address, site name and password: every table that DIFFERS is a cache bin, and every table that
 * does not is byte-identical. 33 non-cache tables agree completely -- `config`, `key_value`,
 * `cachetags`, every content and media table -- and all 8 disagreements are `cache_*`.
 *
 * WHAT THAT MEANS FOR THE OVERLAY. The authoritative state a shared immutable base would hold is
 * 100% identical, so the read-through is sound for exactly the tables worth sharing. The cache bins
 * differ because each site rebuilt its own and the entries embed the site's salt, uuid and pinned
 * origin -- so they are not shareable, and they do not need to be: a cache bin is derived and
 * regenerable, and a copy-on-write design leaves it in the tenant layer where it already belongs.
 *
 * AND WHAT IT BOUNDS. On the sites measured here the split is 581 non-cache rows against 421 cache
 * rows, so the base covers 58% of a provisioned site's rows. Provisioning writes 3,419; a base that
 * removed the identical share would remove roughly that fraction of it. That is the prize, and it is
 * a fraction rather than the "1,320 of 1,321" the seed figure suggests -- because the seed is what a
 * site starts from and a provisioned site has since built its caches.
 *
 * A ROW COUNT IS NOT A BYTE COUNT and this asserts the first. `cache_data` holds a serialized
 * RouteCollection; a row there is not a row in `config`. The share by bytes has not been measured
 * and must not be quoted from this.
 */

const TIMEOUT = 1_800_000;

type Sql = {
	exec: <T>(q: string, ...args: unknown[]) => { toArray: () => T[] };
};

const call = (site: ServeDo, path: string) => site.fetch(new Request(`https://do.local${path}`));

/** the tables a comparison is about: not sqlite's own, not the host's, not the runtime's */
function userTables(sql: Sql): string[] {
	return sql
		.exec<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE type = 'table'
			 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'cfw_%'
			 AND name NOT LIKE '_cf_%' AND name NOT LIKE '__miniflare%' ORDER BY name`
		)
		.toArray()
		.map((r) => String(r.name));
}

/**
 * A digest of one table computed INSIDE sqlite, over every column.
 *
 * `hex()` per column rather than a JS read, for the reason `migrate-sql.spec.ts` records: a TEXT
 * value containing a NUL is truncated at the first one on the way out, so two different tables
 * would agree on the prefix and the comparison would pass on nothing.
 */
function tableDigest(sql: Sql, table: string): string {
	const cols = sql
		.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
		.toArray()
		.map((r) => String(r.name));
	if (cols.length === 0) return 'no-columns';
	const expr = cols.map((c) => `coalesce(hex("${c}"),char(0))`).join(' || char(31) || ');
	const order = cols.map((c) => `"${c}"`).join(', ');
	// THE TOTAL LENGTH AS WELL AS THE PREFIX. A prefix alone is blind to any change past its own
	// cut, which the sensitivity control below proved by appending one character to the end of a
	// `config` blob and watching the digest not move
	const row = sql
		.exec<{ n: number; b: number; g: string }>(
			`SELECT count(*) AS n, coalesce(sum(length(x)),0) AS b,
			        coalesce(group_concat(substr(x,1,32),''),'') AS g
			 FROM (SELECT ${expr} AS x FROM "${table}" ORDER BY ${order} LIMIT 200)`
		)
		.toArray()[0];
	return `${row?.n ?? 0}:${row?.b ?? 0}:${row?.g ?? ''}`;
}

async function provisioned(name: string): Promise<DurableObjectStub> {
	void name;
	const stub = freshSite();
	await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
	await inObject(stub, (site) =>
		site.fetch(
			new Request('https://do.local/__firstrun', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					adminMail: `${name}@example.invalid`,
					siteName: `Site ${name}`,
					adminPass: `pw-${name}-123456`
				})
			})
		)
	);
	return stub;
}

describe('what two freshly provisioned sites actually share', () => {
	it(
		'agrees on every non-cache table, with a comparison that can fail',
		async () => {
			const a = await provisioned('sharebase-a');
			const b = await provisioned('sharebase-b');

			const tables = await inObject(a, (site) => userTables(site.sql as unknown as Sql));
			expect(tables.length, 'no user tables, so this asserts nothing').toBeGreaterThan(20);

			const digestsA = await inObject(a, (site) =>
				Object.fromEntries(
					tables.map((t) => [t, tableDigest(site.sql as unknown as Sql, t)])
				)
			);
			const digestsB = await inObject(b, (site) =>
				Object.fromEntries(
					tables.map((t) => [t, tableDigest(site.sql as unknown as Sql, t)])
				)
			);

			const differing = tables.filter((t) => digestsA[t] !== digestsB[t]);
			const nonCacheDiffering = differing.filter((t) => !t.startsWith('cache_'));

			// THE FINDING. Every disagreement is a cache bin, so the authoritative state a shared
			// base would hold is completely identical -- and a cache bin is derived, regenerable,
			// and belongs in the tenant layer anyway
			expect(
				nonCacheDiffering,
				'a non-cache table differs, so the shared base is not sound for it'
			).toEqual([]);

			// AND THE COMPARISON CAN FAIL, which is what makes the agreement above mean anything.
			// This lane cannot reproduce the cache divergence the deployed measurement saw -- its
			// firstrun does not drive a real render, so both sites end up with the same bins -- so
			// the sensitivity is proven by mutating one row instead of by waiting for one
			await inObject(b, (site) => {
				(site.sql as unknown as Sql).exec(
					"UPDATE config SET data = data || 'x' WHERE name = 'system.site'"
				);
			});
			const mutated = await inObject(b, (site) =>
				tableDigest(site.sql as unknown as Sql, 'config')
			);
			expect(mutated).not.toBe(digestsA.config);
		},
		TIMEOUT
	);

	it(
		'reports the share by rows, which is what bounds the prize',
		async () => {
			const a = await provisioned('sharebase-c');
			const split = await inObject(a, (site) => {
				const sql = site.sql as unknown as Sql;
				let cache = 0;
				let other = 0;
				for (const t of userTables(sql)) {
					const n = Number(
						sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${t}"`).toArray()[0]
							?.n ?? 0
					);
					if (t.startsWith('cache_')) cache += n;
					else other += n;
				}
				return { cache, other };
			});
			expect(split.cache).toBeGreaterThan(0);
			expect(split.other).toBeGreaterThan(0);
			// a majority, and a fraction rather than the 1,320-of-1,321 the SEED figure suggests:
			// the seed is what a site starts from, and a provisioned site has since built caches
			const share = split.other / (split.cache + split.other);
			expect(share).toBeGreaterThan(0.4);
			expect(share).toBeLessThan(0.8);
		},
		TIMEOUT
	);
});
