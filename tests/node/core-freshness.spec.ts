import { describe, expect, it } from 'vitest';
import {
	assess,
	branchOf,
	compareVersions,
	formatFreshness,
	parseReleases,
	parseSupportedBranches
} from '../../scripts/qa/core-freshness';
import { SHIPPED_CORE_VERSION } from '../../src/ops/shipped-lock';

/**
 * The staleness check for the core this repo ships.
 *
 * Nothing compared `SHIPPED_CORE_VERSION` to upstream, so the first notice of a core advisory was a
 * human reading drupal.org. The check needs the network and therefore cannot join the hermetic gate;
 * what CAN be gated is the parsing and the verdict, over a fixture shaped like the real feed.
 *
 * The case worth having a test for is `branch-unsupported`. A branch dropped from
 * `<supported_branches>` is still the newest thing on that branch, so a check that only compares
 * versions calls it current -- while it actually means no future fix, security included, will ever
 * be published for it.
 */

/** shaped like `updates.drupal.org/release-history/drupal/current`, trimmed to what is read */
function feed(options: {
	branches: string;
	releases: Array<{ version: string; type?: string; status?: string; date?: number }>;
}): string {
	const releases = options.releases
		.map(
			(r) =>
				`<release><name>drupal ${r.version}</name><version>${r.version}</version>` +
				`<status>${r.status ?? 'published'}</status>` +
				`<date>${r.date ?? 1786012554}</date>` +
				`<terms><term><name>Release type</name><value>${r.type ?? 'Bug fixes'}</value></term></terms>` +
				`<security covered="1">Covered</security></release>`
		)
		.join('');
	return (
		`<?xml version="1.0" encoding="utf-8"?><project><title>Drupal core</title>` +
		`<supported_branches>${options.branches}</supported_branches>` +
		`<releases>${releases}</releases></project>`
	);
}

const SUPPORTED = '10.6.,11.3.,11.4.';

describe('reading the release feed', () => {
	it('pulls the supported branches as the feed spells them, with the trailing dot', () => {
		expect(parseSupportedBranches(feed({ branches: SUPPORTED, releases: [] }))).toEqual([
			'10.6.',
			'11.3.',
			'11.4.'
		]);
	});

	it('marks a security release from its Release type term', () => {
		const xml = feed({
			branches: SUPPORTED,
			releases: [{ version: '11.4.5' }, { version: '11.4.4', type: 'Security update' }]
		});
		const releases = parseReleases(xml);
		expect(releases.map((r) => r.version)).toEqual(['11.4.5', '11.4.4']);
		expect(releases[0]?.security).toBe(false);
		expect(releases[1]?.security).toBe(true);
	});

	it('skips an unpublished release, which nobody can upgrade to', () => {
		const xml = feed({
			branches: SUPPORTED,
			releases: [{ version: '11.4.5' }, { version: '11.4.6', status: 'unpublished' }]
		});
		expect(parseReleases(xml).map((r) => r.version)).toEqual(['11.4.5']);
	});

	it('derives the branch the way the feed writes it', () => {
		expect(branchOf('11.4.5')).toBe('11.4.');
		expect(branchOf('10.6.12')).toBe('10.6.');
	});
});

describe('comparing versions, which is not semver here', () => {
	it('orders by numeric segment', () => {
		expect(compareVersions('11.4.5', '11.4.4')).toBeGreaterThan(0);
		expect(compareVersions('11.4.5', '11.4.10')).toBeLessThan(0);
		expect(compareVersions('11.4.5', '11.4.5')).toBe(0);
		expect(compareVersions('9.5.11', '10.0.0')).toBeLessThan(0);
	});

	it('sorts a prerelease BELOW the release it precedes', () => {
		// otherwise a beta reads as an upgrade and the check starts crying wolf
		expect(compareVersions('11.5.0-beta1', '11.5.0')).toBeLessThan(0);
		expect(compareVersions('11.5.0', '11.5.0-beta1')).toBeGreaterThan(0);
	});
});

describe('the verdict', () => {
	it('is current when the shipped version is the newest on a supported branch', () => {
		const f = assess(
			'11.4.5',
			feed({ branches: SUPPORTED, releases: [{ version: '11.4.5' }] })
		);
		expect(f.verdict).toBe('current');
		expect(f.branchSupported).toBe(true);
		expect(f.newer).toEqual([]);
	});

	it('is behind, not an incident, for a newer BUGFIX release', () => {
		const f = assess(
			'11.4.5',
			feed({ branches: SUPPORTED, releases: [{ version: '11.4.6' }, { version: '11.4.5' }] })
		);
		expect(f.verdict).toBe('behind');
		expect(f.securityBehind).toBe(false);
		expect(f.newer.map((r) => r.version)).toEqual(['11.4.6']);
	});

	it('is security-behind when any newer release on the branch is a security update', () => {
		const f = assess(
			'11.4.5',
			feed({
				branches: SUPPORTED,
				releases: [
					{ version: '11.4.7' },
					{ version: '11.4.6', type: 'Security update' },
					{ version: '11.4.5' }
				]
			})
		);
		// the security release is not the newest, and it still decides the verdict
		expect(f.verdict).toBe('security-behind');
		expect(f.latestOnBranch).toBe('11.4.7');
	});

	it('is branch-unsupported even when nothing newer exists on that branch', () => {
		// THE CASE A VERSION COMPARISON CANNOT SEE: newest on its branch, and the branch is dead
		const f = assess(
			'11.2.9',
			feed({
				branches: SUPPORTED,
				releases: [{ version: '11.4.5' }, { version: '11.2.9' }]
			})
		);
		expect(f.newer).toEqual([]);
		expect(f.branchSupported).toBe(false);
		expect(f.verdict).toBe('branch-unsupported');
		expect(f.latestOverall).toBe('11.4.5');
	});

	it('ranks a pending security fix above an unsupported branch, because it is exploitable now', () => {
		const f = assess(
			'11.2.9',
			feed({
				branches: SUPPORTED,
				releases: [{ version: '11.2.10', type: 'Security update' }, { version: '11.2.9' }]
			})
		);
		expect(f.branchSupported).toBe(false);
		expect(f.verdict).toBe('security-behind');
	});

	it('ignores newer releases on OTHER branches, which are not an upgrade path', () => {
		const f = assess(
			'10.6.12',
			feed({
				branches: SUPPORTED,
				releases: [{ version: '11.4.5' }, { version: '10.6.12' }]
			})
		);
		expect(f.verdict).toBe('current');
		expect(f.newer).toEqual([]);
	});
});

describe('the report', () => {
	it('names the security release rather than only counting it', () => {
		const f = assess(
			'11.4.5',
			feed({
				branches: SUPPORTED,
				releases: [{ version: '11.4.6', type: 'Security update' }, { version: '11.4.5' }]
			})
		);
		const text = formatFreshness(f);
		expect(text).toContain('11.4.6');
		expect(text).toContain('SECURITY');
		expect(text).toContain('security-behind');
	});

	it('says NOT SUPPORTED in words, so a log skim cannot miss it', () => {
		const f = assess(
			'11.2.9',
			feed({ branches: SUPPORTED, releases: [{ version: '11.2.9' }] })
		);
		expect(formatFreshness(f)).toContain('NOT SUPPORTED');
	});
});

describe('the version this repo actually ships', () => {
	it('has a branch the feed could match, which is what the whole check rests on', () => {
		expect(SHIPPED_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(branchOf(SHIPPED_CORE_VERSION)).toMatch(/^\d+\.\d+\.$/);
	});
});
