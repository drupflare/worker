/**
 * Times `translate()` over every statement of a captured WordPress log.
 *
 * Usage: bun scripts/measure/sql-translate-timing.ts --capture=<raw-statements.jsonl> [--rounds=7]
 * Prints one JSON object. Each statement is translated once per round, the per-statement figure is
 * the median over rounds, and the percentiles are nearest-rank over those medians. Run it under bun
 * and under node (`bun build --target=node`) in alternation to compare engines.
 */
import { readFileSync } from 'node:fs';

import { parseCreateTable } from '../../src/db/sql/ddl';
import {
	createDatabaseState,
	createState,
	translate,
	type MysqlState
} from '../../src/db/sql/translate';

interface Captured {
	scenario: string;
	thread: string;
	sql: string;
}

const arg = (name: string, fallback?: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const path = arg('capture');
if (path === undefined) throw new Error('--capture=<raw-statements.jsonl> is required');
const rounds = Number(arg('rounds', '7'));

const statements = readFileSync(path, 'utf8')
	.split('\n')
	.filter((l) => l !== '')
	.map((l) => JSON.parse(l) as Captured);

function freshState(): MysqlState {
	const state = createState({ db: createDatabaseState(), database: 'wp' });
	for (const s of statements) {
		if (s.sql.startsWith('CREATE TABLE')) {
			const { schema } = parseCreateTable(s.sql);
			state.db.catalog.set(schema.name.toLowerCase(), schema);
		}
	}
	state.db.loaded = true;
	state.sqlMode = 'NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
	return state;
}

const state = freshState();
const now = () => performance.now() * 1000;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

function pct(sorted: number[], p: number): number {
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

// warm the engine so the first rounds are not compile time
for (let w = 0; w < 2; w++) for (const s of statements) translate(s.sql, state);

const samples: number[][] = statements.map(() => []);
for (let r = 0; r < rounds; r++) {
	statements.forEach((s, i) => {
		const t0 = now();
		translate(s.sql, state);
		(samples[i] as number[]).push(now() - t0);
	});
}
const per = samples.map(median);
const sorted = [...per].sort((a, b) => a - b);
const total = per.reduce((a, b) => a + b, 0);

const page = (name: string) => {
	const idx = statements.map((s, i) => (s.scenario === name ? i : -1)).filter((i) => i >= 0);
	const us = idx.map((i) => per[i] as number);
	return {
		statements: idx.length,
		totalUs: us.reduce((a, b) => a + b, 0),
		maxUs: Math.max(...us)
	};
};

// cache hit rate by exact statement text: one request cold, then the same request again
function hitRate(names: string[]): { hits: number; misses: number } {
	const s = freshState();
	const before = { hits: s.db.stats.hits, misses: s.db.stats.misses };
	for (const name of names) {
		for (const st of statements) {
			if (st.scenario !== name) continue;
			// translate through the cache without running anything
			const hit = s.db.cache.get(st.sql);
			if (hit !== undefined && hit.epoch === s.db.epoch && hit.mode === s.sqlMode) {
				s.db.stats.hits++;
			} else {
				s.db.stats.misses++;
				const t = translate(st.sql, s);
				if (st.sql.length <= 512 && t.plan.kind !== 'local') {
					s.db.cache.set(st.sql, { epoch: s.db.epoch, mode: s.sqlMode, translation: t });
				}
			}
		}
	}
	return { hits: s.db.stats.hits - before.hits, misses: s.db.stats.misses - before.misses };
}

const distinctText = new Set(statements.map((s) => s.sql)).size;
const whole = hitRate([...new Set(statements.map((s) => s.scenario))]);
const cold = hitRate(['front-page-cold']);
const twice = hitRate(['front-page-cold', 'front-page-warm']);

console.log(
	JSON.stringify({
		runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`,
		statements: statements.length,
		distinctText,
		rounds,
		perStatementUs: {
			mean: total / per.length,
			p50: pct(sorted, 50),
			p95: pct(sorted, 95),
			p99: pct(sorted, 99),
			max: sorted[sorted.length - 1]
		},
		totalMs: total / 1000,
		frontPageCold: page('front-page-cold'),
		frontPageWarm: page('front-page-warm'),
		cache: { wholeCapture: whole, frontPageOnce: cold, frontPageTwice: twice }
	})
);
