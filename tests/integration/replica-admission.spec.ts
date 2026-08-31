import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * What an object publishes about its own authoritative state, against a real database.
 *
 * The unit spec covers the decision; this covers the two things only a real object can be wrong
 * about: that the fingerprint is computed over rows that actually exist, and that a caller who
 * supplies nothing about the primary gets a REFUSAL rather than a pass. The second is the one worth
 * having, because "no primary fingerprint supplied" and "the fingerprints agree" are the same shape
 * in a lazy implementation and opposite facts.
 */

const TIMEOUT = 120_000;

type ReplicaReport = {
	role: string;
	generation: number;
	fingerprint: string;
	schemaVersion: string | null;
	rowsCovered: number;
	verdict: { admitted: boolean; stage: string; refusals: string[] };
};

async function report(site: ServeDo, query = ''): Promise<ReplicaReport> {
	const res = await site.fetch(new Request(`https://do.local/__replica${query}`));
	expect(res.status, await res.clone().text()).toBe(200);
	return (await res.json()) as ReplicaReport;
}

/** the mandatory installation-globals, written straight in; the point is the reading, not the mint */
function seedMandatory(site: ServeDo): void {
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS key_value (collection TEXT, name TEXT, value BLOB,
			PRIMARY KEY (collection, name))`
	);
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS key_value_expire (collection TEXT, name TEXT, value BLOB,
			expire INTEGER, PRIMARY KEY (collection, name))`
	);
	for (const [collection, name, value] of [
		['state', 'system.private_key', 'pk'],
		['state', 'system.cron_key', 'ck'],
		['state', 'install_time', '1'],
		['state', 'install_task', 'done'],
		['system.schema', 'node', '8000'],
		['post_update', 'existing_updates', 'a:0:{}']
	] as const) {
		site.sql.exec(
			'INSERT OR REPLACE INTO key_value (collection, name, value) VALUES (?, ?, ?)',
			collection,
			name,
			value
		);
	}
}

describe('an object publishes its own authoritative state', () => {
	it(
		'fingerprints the rows it actually holds',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				seedMandatory(site);
				const first = await report(site);
				// one more authoritative row, and the fingerprint must move
				site.sql.exec(
					'INSERT OR REPLACE INTO key_value (collection, name, value) VALUES (?, ?, ?)',
					'state',
					'something.else',
					'v'
				);
				return { first, second: await report(site) };
			});

			expect(out.first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(out.first.rowsCovered).toBeGreaterThan(0);
			expect(out.second.fingerprint).not.toBe(out.first.fingerprint);
			expect(out.second.rowsCovered).toBe(out.first.rowsCovered + 1);
		},
		TIMEOUT
	);

	it(
		'refuses when the caller says nothing about the primary',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				seedMandatory(site);
				return report(site);
			});

			// EVERY mandatory value is present and the object is internally consistent, and it is
			// still not admitted, because nothing is known about the primary
			expect(out.verdict.admitted).toBe(false);
			expect(out.verdict.refusals.join(' ')).toContain('fingerprint');
		},
		TIMEOUT
	);

	it(
		'admits only when the primary agrees on all three',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				seedMandatory(site);
				const self = await report(site);
				const agreeing =
					`?primaryFingerprint=${self.fingerprint}` +
					`&primarySchema=${encodeURIComponent(self.schemaVersion ?? '')}` +
					`&advertisedGeneration=${self.generation}`;
				const disagreeing =
					`?primaryFingerprint=deadbeef` +
					`&primarySchema=${encodeURIComponent(self.schemaVersion ?? '')}` +
					`&advertisedGeneration=${self.generation}`;
				const ahead =
					`?primaryFingerprint=${self.fingerprint}` +
					`&primarySchema=${encodeURIComponent(self.schemaVersion ?? '')}` +
					`&advertisedGeneration=${self.generation - 1}`;
				return {
					agree: await report(site, agreeing),
					disagree: await report(site, disagreeing),
					ahead: await report(site, ahead)
				};
			});

			expect(out.agree.verdict.admitted, out.agree.verdict.refusals.join(' | ')).toBe(true);
			expect(out.disagree.verdict.admitted).toBe(false);
			// ahead of the primary is its own refusal, not silence
			expect(out.ahead.verdict.admitted).toBe(false);
			expect(out.ahead.verdict.refusals.join(' ')).toContain('ahead');
		},
		TIMEOUT
	);

	it(
		'refuses an object missing a mandatory value, however healthy it looks',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				seedMandatory(site);
				site.sql.exec(
					'DELETE FROM key_value WHERE collection = ? AND name = ?',
					'state',
					'system.private_key'
				);
				const self = await report(site);
				return report(
					site,
					`?primaryFingerprint=${self.fingerprint}` +
						`&primarySchema=${encodeURIComponent(self.schemaVersion ?? '')}` +
						`&advertisedGeneration=${self.generation}`
				);
			});

			// the fingerprints agree with themselves, which is exactly why the mandatory check has to
			// be separate: a replica missing the private key is self-consistent and still wrong
			expect(out.verdict.admitted).toBe(false);
			expect(out.verdict.refusals.join(' ')).toContain('system.private_key');
		},
		TIMEOUT
	);
});
