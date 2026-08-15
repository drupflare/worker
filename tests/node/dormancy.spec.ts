import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	auditDormancy,
	CAPABILITIES,
	dormantSummary,
	NO_ACTIVATION_NEEDED
} from '../../src/ops/dormancy';

const here = dirname(fileURLToPath(import.meta.url));
const SITE_DB = join(here, '..', '..', 'assets', 'drupal', 'site.sqlite');
const available = existsSync(SITE_DB);

if (!available && process.env.REQUIRE_ARTIFACTS) {
	throw new Error(`no ${SITE_DB}, and REQUIRE_ARTIFACTS says this lane has it`);
}

/**
 * Reads the artifact.
 *
 * `NOCASE_UTF8` is a collation Drupal's own sqlite driver registers at connect time; a raw handle
 * has never heard of it and fails on any read touching a column declared with it.
 */
function readArtifact(): { configNames: string[]; modules: string[]; keyValue: Set<string> } {
	const db = new DatabaseSync(SITE_DB, { readOnly: true });
	try {
		const configNames = db
			.prepare('SELECT name FROM config ORDER BY name')
			.all()
			.map((r) => String((r as { name: unknown }).name));

		const row = db
			.prepare('SELECT hex(data) AS h FROM config WHERE name = ?')
			.get('core.extension');
		const blob = Buffer.from(String((row as { h: string }).h), 'hex').toString('latin1');
		const modules = [...blob.matchAll(/s:\d+:"([a-z_0-9]+)";i:\d+;/g)].map(
			(m) => m[1] as string
		);

		const keyValue = new Set(
			db
				.prepare('SELECT name FROM key_value')
				.all()
				.map((r) => String((r as { name: unknown }).name))
		);
		return { configNames, modules, keyValue };
	} finally {
		db.close();
	}
}

describe.skipIf(!available)('the shipped artifact has no undecided capabilities', () => {
	const { configNames, modules, keyValue } = available
		? readArtifact()
		: { configNames: [], modules: [], keyValue: new Set<string>() };

	/**
	 * The assertion the whole file exists for.
	 *
	 * `undecided` means a capability the project intends to be active with nothing activating it --
	 * the shape that produced the content-type, cron and pathauto defects. There is no third state.
	 */
	it('every capability is active or deliberately dormant', () => {
		const rows = auditDormancy(configNames, {
			'runtime:cron': true,
			'runtime:deferred-outbound': true
		});
		const undecided = rows.filter((r) => r.state === 'undecided');
		expect(
			undecided.map((r) => `${r.id}: ${r.detail}`),
			'a capability is neither active nor deliberately dormant'
		).toEqual([]);
	});

	/**
	 * A module in the pack that nobody has classified is the next instance of the class waiting to
	 * happen, so it fails here rather than in production.
	 */
	it('every installed module has been classified', () => {
		const known = new Set([...CAPABILITIES.map((c) => c.id), ...NO_ACTIVATION_NEEDED]);
		const unclassified = modules.filter((m) => !known.has(m));
		expect(
			unclassified,
			`these modules are installed and nobody decided whether they need activation config: ${unclassified.join(', ')}`
		).toEqual([]);
	});

	it('every deliberately dormant capability carries its reason and how to activate it', () => {
		for (const cap of CAPABILITIES) {
			if (cap.posture !== 'dormant-by-design') continue;
			expect(cap.reason, cap.id).toBeDefined();
			expect((cap.reason ?? '').length, cap.id).toBeGreaterThan(40);
			expect(cap.toActivate, cap.id).toBeDefined();
		}
	});

	it('reports the dormant list an operator should be shown', () => {
		const rows = auditDormancy(configNames, {
			'runtime:cron': true,
			'runtime:deferred-outbound': true
		});
		const summary = dormantSummary(rows);
		expect(summary.length).toBeGreaterThan(0);
		expect(summary.join(' ')).toContain('Pathauto');
		for (const line of summary) expect(line).toContain('will do nothing until configured');
	});

	/** the fix that landed: content types, which every save depends on */
	it('content types are active, which they were not before the recipe was applied', () => {
		expect(configNames.filter((n) => n.startsWith('node.type.')).length).toBeGreaterThan(0);
	});

	/**
	 * **automated_cron must stay disabled**, and this is now a regression guard rather than a finding.
	 *
	 * It was written the other way round: the artifact shipped `interval = 10800` while CLAUDE.md
	 * claimed 0, and `system.cron_last` was absent -- so core's automated_cron treated cron as
	 * never-run and fired `drupal_cron()` INLINE on the first visitor request. 187 queries and hooks
	 * reaching for sockets this runtime lacks, on the render path, which is exactly the monolith the
	 * Durable Object alarm exists to replace.
	 *
	 * The interval is now 0, so the value is never consulted and `cron_last` is correctly NOT stamped
	 * -- writing a build-time timestamp into state would be inventing data that is wrong the moment
	 * anyone deploys.
	 *
	 * The fourth instance of the dormancy class, and the one that changes its shape: `firstRunConfig()`
	 * already set `interval = 0` and TECHNICAL_REPORT.md called it "a prerequisite, not tidiness". It
	 * only ran on the explicit `/__firstrun` route, so a site that merely received traffic never
	 * applied it. **A fix that exists and does not run is the same failure as a capability that ships
	 * and is not activated.**
	 */
	it('keeps automated_cron disabled so cron stays on the alarm', () => {
		const db = new DatabaseSync(SITE_DB, { readOnly: true });
		try {
			const row = db
				.prepare('SELECT hex(data) AS h FROM config WHERE name = ?')
				.get('automated_cron.settings');
			const blob = Buffer.from(String((row as { h: string }).h), 'hex').toString('latin1');
			const interval = Number(/s:8:"interval";i:(\d+)/.exec(blob)?.[1] ?? -1);

			expect(
				interval,
				'a non-zero interval makes core fire drupal_cron() inline on a visitor request'
			).toBe(0);
			// correctly absent: with the interval at 0 it is never read, and a build-time timestamp
			// would be wrong on every deployment
			expect(keyValue.has('system.cron_last')).toBe(false);
		} finally {
			db.close();
		}
	});
});

describe('auditDormancy', () => {
	it('calls a capability undecided when it is meant to be active and nothing activates it', () => {
		const rows = auditDormancy([], {}, [
			{ id: 'x', label: 'X', activatedBy: 'x.thing.', posture: 'must-be-active' }
		]);
		expect(rows[0]?.state).toBe('undecided');
		expect(rows[0]?.detail).toContain('silently do nothing');
	});

	it('calls the same capability active as soon as one object ships', () => {
		const rows = auditDormancy(['x.thing.one'], {}, [
			{ id: 'x', label: 'X', activatedBy: 'x.thing.', posture: 'must-be-active' }
		]);
		expect(rows[0]?.state).toBe('active');
		expect(rows[0]?.found).toBe(1);
	});

	it('accepts a deliberate dormancy and carries the reason through', () => {
		const rows = auditDormancy([], {}, [
			{
				id: 'y',
				label: 'Y',
				activatedBy: 'y.pattern.',
				posture: 'dormant-by-design',
				reason: 'a site owner decides this and guessing is worse than leaving it empty',
				toActivate: 'add one'
			}
		]);
		expect(rows[0]?.state).toBe('dormant-by-design');
		expect(rows[0]?.detail).toContain('guessing is worse');
	});
});
