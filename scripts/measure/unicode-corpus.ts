#!/usr/bin/env bun
/**
 * The mbstring parity corpus: every Unicode scalar value, measured against the real extension, kept as
 * a checked-in artifact instead of a sweep somebody ran once.
 *
 * Three arms, and the third is the one that is easy to get wrong:
 *
 * 1. `unicode-corpus.php` sweeps all 1,112,064 scalars through the REAL extension. That is the
 *    oracle, and its PHP and mbstring versions are pinned INTO the artifact -- an oracle with
 *    unrecorded provenance is a guess.
 * 2. `unicode-subject.php` sweeps the same scalars through the shipping polyfill stack, both bare
 *    and wrapped, so the divergence has a number rather than an adjective.
 * 3. The tables come from arm 1 and from NO JavaScript engine, which is the part that is easy to
 *    get wrong. A generator written against `toLowerCase` bakes in whichever ICU the runtime
 *    carries and looks fine either way. `--js-vintage` prints this runtime's divergence from the
 *    extension, and `tests/unit/drupal/unicode-workerd.spec.ts` prints workerd's from inside
 *    workerd -- measured 0 there, so the two engines do not agree by assumption.
 *
 * usage:
 *   bun scripts/measure/unicode-corpus.ts              report only
 *   bun scripts/measure/unicode-corpus.ts --detail     list the scalars still divergent
 *   bun scripts/measure/unicode-corpus.ts --write      rewrite the artifact and the shipping tables
 *   bun scripts/measure/unicode-corpus.ts --js-vintage add this runtime's casing arm
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TABLES, writeStackFile } from './unicode-stack.js';

const here = new URL('.', import.meta.url).pathname;
const repo = resolve(here, '../..');
const args: string[] = process.argv.slice(2);
const root = resolve(args.find((a) => a.startsWith('--root='))?.slice(7) ?? `${repo}/drupal-src`);

export const ARTIFACT = `${repo}/tests/fixtures/unicode-corpus.json`;
export { TABLES };

// #region types

export interface Packed {
	ranges: [number, number, number][];
	map: Record<string, number[]>;
}

export interface Corpus {
	provenance: {
		php: string;
		mbstring: string | null;
		oniguruma: string | null;
		icuUnicode: number[] | null;
		scalars: number;
	};
	case: { lower: Packed; upper: Packed; title: Packed; fold: Packed };
	width: [number, number, number][];
	titleExtra: [number, number, number][];
	bytes: [string, string, number, number][];
	offsets: { subject: string; cases: { start: number; len: number | null; out: string }[] };
}

// #endregion

// #region packing

/** the inverse of the PHP side's $pack: back to one entry per codepoint that is not identity */
export function expand(p: Packed): Map<number, number[]> {
	const out = new Map<number, number[]>();
	for (const [lo, hi, delta] of p.ranges) {
		for (let cp = lo; cp <= hi; cp++) out.set(cp, [cp + delta]);
	}
	for (const [cp, res] of Object.entries(p.map)) out.set(Number(cp), res);
	return out;
}

/** the inverse of $packInt, for the width table */
export function expandInt(ranges: [number, number, number][]): Map<number, number> {
	const out = new Map<number, number>();
	for (const [lo, hi, v] of ranges) {
		for (let cp = lo; cp <= hi; cp++) out.set(cp, v);
	}
	return out;
}

/** every scalar where the two arms disagree, identity counting as "absent from the map" */
export function diffCase(a: Map<number, number[]>, b: Map<number, number[]>): number[] {
	const out: number[] = [];
	for (const cp of new Set([...a.keys(), ...b.keys()])) {
		const x = (a.get(cp) ?? [cp]).join(',');
		const y = (b.get(cp) ?? [cp]).join(',');
		if (x !== y) out.push(cp);
	}
	return out.sort((m, n) => m - n);
}

export function diffInt(a: Map<number, number>, b: Map<number, number>): number[] {
	const out: number[] = [];
	for (const cp of new Set([...a.keys(), ...b.keys()])) {
		if ((a.get(cp) ?? 1) !== (b.get(cp) ?? 1)) out.push(cp);
	}
	return out.sort((m, n) => m - n);
}

// #endregion

// #region sweeps

function php(script: string, extra: string[] = []): string {
	const r = spawnSync(
		'php',
		['-d', 'opcache.enable_cli=0', '-d', 'xdebug.mode=off', `${here}${script}`, ...extra],
		{ encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
	);
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`${script} exited ${r.status}`);
	return r.stdout;
}

/** the oracle: the real extension, swept over every scalar */
export function nativeCorpus(): Corpus {
	return JSON.parse(php('unicode-corpus.php')) as Corpus;
}

/** the subject: the shipping stack, bare and wrapped, over the same scalars */
export function subjectSweep(
	opts: { tables?: string } = {}
): Record<'bare' | 'ship', { case: Record<string, Packed>; width: [number, number, number][] }> {
	const stack = writeStackFile(opts);
	return JSON.parse(php('unicode-subject.php', [`--root=${root}`, `--stack=${stack.path}`]));
}

/**
 * `toLowerCase`/`toUpperCase` for every scalar, in whatever runtime is calling.
 *
 * Exported rather than inlined because the interesting reading is the SAME sweep in two engines:
 * `tests/unit/drupal/unicode-workerd.spec.ts` runs it inside workerd and
 * `tests/node/unicode-corpus.spec.ts` runs it here, and the two disagree because they carry
 * different ICU vintages. Neither is the oracle -- mbstring is -- but a generator written against
 * the wrong one would bake its answers in and look fine.
 */
export function jsCasing(): { lower: Map<number, number[]>; upper: Map<number, number[]> } {
	const lower = new Map<number, number[]>();
	const upper = new Map<number, number[]>();
	for (let cp = 0; cp <= 0x10ffff; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue;
		const ch = String.fromCodePoint(cp);
		const lo = ch.toLowerCase();
		if (lo !== ch)
			lower.set(
				cp,
				[...lo].map((c) => c.codePointAt(0) as number)
			);
		const up = ch.toUpperCase();
		if (up !== ch)
			upper.set(
				cp,
				[...up].map((c) => c.codePointAt(0) as number)
			);
	}
	return { lower, upper };
}

// #endregion

// #region table emission

const utf8 = (cps: number[]) =>
	[...Buffer.from(String.fromCodePoint(...cps), 'utf8')]
		.map((b) => '\\x' + b.toString(16).padStart(2, '0'))
		.join('');

/** the distinct first bytes of a map's keys, so a strpbrk can refuse a string no key can be in */
const leadBytes = (keys: number[]) => {
	const set = new Set<number>();
	for (const cp of keys) set.add(Buffer.from(String.fromCodePoint(cp), 'utf8')[0] as number);
	return [...set]
		.sort((a, b) => a - b)
		.map((b) => '\\x' + b.toString(16).padStart(2, '0'))
		.join('');
};

/** ranges as a PCRE character class body, which is the shape both generated patterns want */
const charClass = (ranges: [number, number, number][]) =>
	ranges
		.map(([lo, hi]) =>
			lo === hi
				? `\\x{${lo.toString(16).toUpperCase()}}`
				: `\\x{${lo.toString(16).toUpperCase()}}-\\x{${hi.toString(16).toUpperCase()}}`
		)
		.join('');

export function emitTables(t: {
	lower: [number, number[]][];
	upper: [number, number[]][];
	title: [number, number[]][];
	fold: [number, number[]][];
	width: [number, number, number][];
	titleExtra: [number, number, number][];
}): string {
	const map = (entries: [number, number[]][]) =>
		entries.length === 0
			? '[]'
			: '[\n' +
				entries.map(([cp, res]) => `\t\t"${utf8([cp])}" => "${utf8(res)}",`).join('\n') +
				'\n\t]';
	const leads = (entries: [number, number[]][]) => leadBytes(entries.map(([cp]) => cp));
	const ranges = (r: [number, number, number][]) =>
		r.length === 0
			? '[]'
			: '[\n' + r.map((x) => `\t\t'${charClass([x])}',`).join('\n') + '\n\t]';
	return `<?php

/**
 * @file
 * GENERATED by \`bun run measure:unicode --write\` in drupflare/worker. Do not hand-edit.
 *
 * The Unicode data symfony/polyfill-mbstring gets wrong, as a delta from what the polyfill
 * already answers rather than as a second full table. \`MB_FIX\` requires this file before the
 * polyfill's bootstrap runs and reads it through \`cfw_mb_unicode_data()\`.
 *
 * Every entry was produced by sweeping all 1,112,064 Unicode scalar values through the shipping
 * stack with the real mbstring extension as the oracle, keeping only the codepoints where the two
 * disagree. \`scripts/measure/unicode-corpus.php\` in the worker repo is the oracle,
 * \`unicode-subject.php\` is the subject, and \`tests/node/unicode-corpus.spec.ts\` fails when
 * either drifts.
 *
 * DATA, not a class. It lives here rather than in the worker bundle because the bundle is
 * measured after gzip against a 3 MiB ceiling and this tree is not: the same table costs 4,690
 * gzipped bytes of bundle and nothing on the asset layer.
 */

return [
	'lower' => ${map(t.lower)},
	'upper' => ${map(t.upper)},
	'title' => ${map(t.title)},
	'fold' => ${map(t.fold)},
	// the distinct first bytes of each map's keys, so a strpbrk can refuse a string that
	// cannot contain any of them without paying for the strtr
	'leads' => [
		'lower' => "${leads(t.lower)}",
		'upper' => "${leads(t.upper)}",
		'title' => "${leads(t.title)}",
		'fold' => "${leads(t.fold)}",
	],
	// east asian width, as class fragments rather than one 2 KB literal; the polyfill's own
	// ranges are frozen several Unicode versions back and miss every emoji
	'wide' => ${ranges(t.width.filter(([, , w]) => w === 2))},
	// the characters mbstring titlecases that PCRE does not call a letter -- small roman
	// numerals, circled letters -- so the polyfill's word pattern never offers them at all
	'titleExtra' => ${ranges(t.titleExtra)},
];
`;
}

// #endregion

// #region report

if (import.meta.main) {
	const native = nativeCorpus();
	const subject = subjectSweep();

	const nat = {
		lower: expand(native.case.lower),
		upper: expand(native.case.upper),
		title: expand(native.case.title),
		width: expandInt(native.width)
	};

	const arm = (which: 'bare' | 'ship') => ({
		lower: expand(subject[which].case.lower as Packed),
		upper: expand(subject[which].case.upper as Packed),
		title: expand(subject[which].case.title as Packed),
		width: expandInt(subject[which].width)
	});

	console.log(
		`oracle: php ${native.provenance.php} with mbstring ${native.provenance.mbstring}, ` +
			`${native.provenance.scalars.toLocaleString('en-US')} scalar values`
	);
	console.log('subject: symfony/polyfill-mbstring over symfony/polyfill-iconv + MB_FIX\n');
	console.log('| operation | bare polyfill | shipping stack |');
	console.log('| --- | --- | --- |');
	const bare = arm('bare');
	const ship = arm('ship');
	const rows: Record<string, [number, number]> = {
		mb_strtolower: [
			diffCase(nat.lower, bare.lower).length,
			diffCase(nat.lower, ship.lower).length
		],
		mb_strtoupper: [
			diffCase(nat.upper, bare.upper).length,
			diffCase(nat.upper, ship.upper).length
		],
		'mb_convert_case/title': [
			diffCase(nat.title, bare.title).length,
			diffCase(nat.title, ship.title).length
		],
		mb_strwidth: [diffInt(nat.width, bare.width).length, diffInt(nat.width, ship.width).length]
	};
	for (const [k, [b, s]] of Object.entries(rows)) console.log(`| ${k} | ${b} | ${s} |`);
	const total = Object.values(rows).reduce((a, [, s]) => a + s, 0);
	console.log(`\nshipping stack: ${total} divergent codepoints of ${native.provenance.scalars}`);

	if (args.includes('--detail')) {
		const hex = (cps: number[]) =>
			cps.map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ');
		for (const [name, key] of [
			['mb_strtolower', 'lower'],
			['mb_strtoupper', 'upper'],
			['mb_convert_case/title', 'title']
		] as const) {
			const cps = diffCase(nat[key], ship[key]);
			if (cps.length === 0) continue;
			console.log(`\n${name}: ${cps.length} still divergent`);
			for (const cp of cps.slice(0, 40)) {
				console.log(
					`  U+${cp.toString(16).toUpperCase().padStart(4, '0')}  native ${hex(nat[key].get(cp) ?? [cp])}` +
						`  shipping ${hex(ship[key].get(cp) ?? [cp])}`
				);
			}
		}
		const w = diffInt(nat.width, ship.width);
		if (w.length > 0) console.log(`\nmb_strwidth: ${w.length} still divergent`);
	}

	if (args.includes('--js-vintage')) {
		const local = jsCasing();
		const engine = process.versions.bun
			? `bun ${process.versions.bun}`
			: `node ${process.versions.node}`;
		console.log('\n| runtime | mb_strtolower | mb_strtoupper |');
		console.log('| --- | --- | --- |');
		console.log(
			`| ${engine} | ${diffCase(nat.lower, local.lower).length} | ` +
				`${diffCase(nat.upper, local.upper).length} |`
		);
		console.log('workerd runs the same sweep in tests/unit/drupal/unicode-workerd.spec.ts');
	}

	if (args.includes('--write')) {
		// the tables are the DIFF, so they are generated from the arm that is still wrong
		const entry = (cps: number[], m: Map<number, number[]>) =>
			cps.map((cp) => [cp, m.get(cp) ?? [cp]] as [number, number[]]);
		const foldable = [...nat.lower.entries()]
			.filter(([, res]) => res.length > 1)
			.map(([cp, res]) => [cp, [res[0]]] as [number, number[]]);
		writeFileSync(
			TABLES,
			emitTables({
				lower: entry(diffCase(nat.lower, bare.lower), nat.lower),
				upper: entry(diffCase(nat.upper, bare.upper), nat.upper),
				title: entry(diffCase(nat.title, bare.title), nat.title),
				fold: foldable,
				width: native.width,
				titleExtra: native.titleExtra
			})
		);
		writeFileSync(ARTIFACT, JSON.stringify(native) + '\n');
		console.log(`\nwrote ${ARTIFACT}\nwrote ${TABLES}`);
		console.log('re-run without --write; both numbers above must be 0 for the shipping arm');
	}
}

// #endregion

export function readArtifact(): Corpus {
	return JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Corpus;
}
