import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRUSH_ALIASES } from '../../src/ui/admin.js';

/**
 * The alias map exists twice and this is what keeps the copies equal.
 *
 * `CommandLine::DRUSH_ALIASES` in the sibling module is the source of truth; the Worker's front end
 * cannot call into PHP to canonicalise a typed command, so it holds the same table. Two copies of a
 * table is how this project's drift bugs start, and the guard is cheaper than a round trip.
 */

const SIBLING = process.env.DRUPFLARE_SRC ?? '../drupflare';
const SOURCE = resolve(import.meta.dirname, '../..', SIBLING, 'src/Ops/CommandLine.php');

function phpAliases(): Record<string, string> | null {
	if (!existsSync(SOURCE)) return null;
	const php = readFileSync(SOURCE, 'utf8');
	const block = /const DRUSH_ALIASES = \[([\s\S]*?)\];/.exec(php)?.[1];
	if (block === undefined) throw new Error('DRUSH_ALIASES not found in CommandLine.php');
	const out: Record<string, string> = {};
	for (const m of block.matchAll(/'([^']+)'\s*=>\s*'([^']+)'/g)) {
		out[m[1] as string] = m[2] as string;
	}
	return out;
}

const php = phpAliases();

describe('the Drush alias table', () => {
	it.skipIf(php === null)('is the same in both copies', () => {
		expect(DRUSH_ALIASES).toEqual(php);
	});

	it.skipIf(php === null)('found aliases to compare, or it asserted nothing', () => {
		expect(Object.keys(php ?? {}).length).toBeGreaterThan(20);
	});

	it('maps every alias onto a canonical name that is itself an alias', () => {
		// `cr` must map to `cr`, or a canonical name typed directly would not resolve
		for (const target of Object.values(DRUSH_ALIASES)) {
			expect(DRUSH_ALIASES[target], `${target} is a target but not a key`).toBe(target);
		}
	});

	it('names the eight operations the registry actually has', () => {
		expect(new Set(Object.values(DRUSH_ALIASES))).toEqual(
			new Set(['cr', 'updb', 'cex', 'cim', 'en', 'pmu', 'status', 'sql-dump'])
		);
	});
});
