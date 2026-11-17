#!/usr/bin/env bun
/**
 * Feeds every query of a MySQL query corpus through the PHP lexer in `rom` and the TypeScript lexer
 * in `src/db/sql/lexer.ts`, and compares the full token streams: type, byte offset, byte length
 * and text.
 *
 * The PHP side runs once (`rom/tests/lexer-digest.php`), parses the CSV the way the corpus was
 * written, and leaves a 25-byte digest per query beside the query bytes. The TS side recomputes
 * each digest from the same bytes twice. In `latin1` mode every character is one byte, so offsets
 * are bytes outright. In `utf8` mode, for the queries that are valid UTF-8, the text is decoded and
 * the UTF-16 offsets are converted back to bytes with `utf8Length`. The corpus is GPL oracle data
 * and never belongs in a repository; point `--csv` at a copy outside it.
 *
 * usage: bun scripts/measure/sql-lexer-parity.ts --csv=<corpus.csv> [--work=<dir>] [--rom=<dir>]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { tokenize, utf8Length, type Token } from '../../src/db/sql/lexer';

const here = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const csv = flag('csv');
if (csv === undefined) {
	console.error('usage: bun scripts/measure/sql-lexer-parity.ts --csv=<corpus.csv>');
	process.exit(2);
}
const work = resolve(flag('work') ?? `${tmpdir()}/sql-lexer-parity`);
const rom = resolve(flag('rom') ?? process.env.ROM_SRC ?? `${here}../../../rom`);
mkdirSync(work, { recursive: true });

const php = (...rest: string[]) =>
	spawnSync('php', ['-n', `${rom}/tests/lexer-digest.php`, csv, work, ...rest], {
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024
	});

const made = php();
if (made.status !== 0) throw new Error(`lexer-digest.php failed: ${made.stderr}`);
const phpSummary = JSON.parse(made.stdout) as { queries: number; tokens: number; php: string };

const queries = new Uint8Array(readFileSync(`${work}/queries.bin`));
const digests = new Uint8Array(readFileSync(`${work}/digest.bin`));
const queryView = new DataView(queries.buffer);
const digestView = new DataView(digests.buffer);
const DIGEST = 25;
const REPLACEMENT = String.fromCharCode(0xfffd);

/** the bytes as a string of one character per byte, which is not what TextDecoder's latin1 is */
function latin1(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 8192) {
		out += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return out;
}

/** the bytes of query `index`, found by walking the length prefixes */
function queryAt(index: number): Uint8Array {
	let pos = 0;
	for (let i = 0; i < index; i++) pos += 4 + queryView.getUint32(pos, true);
	return queries.subarray(pos + 4, pos + 4 + queryView.getUint32(pos, true));
}

/** the text of a query under one decoding */
const decode = (raw: Uint8Array, mode: 'latin1' | 'utf8') =>
	mode === 'latin1' ? latin1(raw) : new TextDecoder().decode(raw);

/** the canonical stream and token count the PHP side hashes, from this lexer's tokens */
function stream(tokens: Token[], bytes: boolean, sql: string): string {
	let out = '';
	let byteOffset = 0;
	for (const t of tokens) {
		const length = bytes ? utf8Length(t.text) : t.length;
		out += `${t.type}:${bytes ? byteOffset : t.offset}:${length}:${t.text}`;
		byteOffset += length;
	}
	if (bytes && tokens.length > 0) {
		const last = tokens[tokens.length - 1] as Token;
		if (utf8Length(sql, last.offset) !== byteOffset - utf8Length(last.text)) {
			throw new Error('utf8Length disagrees with the running byte offset');
		}
	}
	return out;
}

interface Difference {
	index: number;
	mode: 'latin1' | 'utf8';
	kind: 'count' | 'stream' | 'error-flag';
}

const differences: Difference[] = [];
let compared = 0;
let comparedUtf8 = 0;
let invalidUtf8 = 0;
let tsTokens = 0;
let n = 0;
for (let pos = 0; pos < queries.length; n++) {
	const len = queryView.getUint32(pos, true);
	const raw = queries.subarray(pos + 4, pos + 4 + len);
	pos += 4 + len;
	const at = n * DIGEST;
	const count = digestView.getUint32(at, true);
	const flags = digests[at + 4] as number;
	const want = digests.subarray(at + 5, at + DIGEST);

	const modes: ['latin1' | 'utf8', string][] = [['latin1', decode(raw, 'latin1')]];
	if (flags & 1) modes.push(['utf8', decode(raw, 'utf8')]);
	else invalidUtf8++;
	for (const [mode, sql] of modes) {
		const tokens = tokenize(sql);
		if (mode === 'latin1') tsTokens += tokens.length;
		const bytes = mode === 'utf8';
		const hash = createHash('sha1')
			.update(stream(tokens, bytes, sql), bytes ? 'utf8' : 'latin1')
			.digest();
		compared++;
		if (bytes) comparedUtf8++;
		if (tokens.length !== count) differences.push({ index: n, mode, kind: 'count' });
		else if (!want.every((b, k) => b === hash[k]))
			differences.push({ index: n, mode, kind: 'stream' });
		else if (
			mode === 'latin1' &&
			tokens.some((t) => t.type === 'error') !== ((flags & 2) !== 0)
		) {
			differences.push({ index: n, mode, kind: 'error-flag' });
		}
	}
}

/** the first token where the PHP dump and this lexer disagree, for one query */
function explain(index: number, mode: 'latin1' | 'utf8'): string {
	const dump = php('--dump', String(index));
	const theirs = dump.stdout
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l) as Token);
	const sql = decode(queryAt(index), mode);
	const ours = tokenize(sql);
	let byteOffset = 0;
	for (let i = 0; i < Math.max(ours.length, theirs.length); i++) {
		const a = ours[i];
		const b = theirs[i];
		const aLength = a === undefined ? 0 : mode === 'utf8' ? utf8Length(a.text) : a.length;
		const same =
			a !== undefined &&
			b !== undefined &&
			a.type === b.type &&
			(mode === 'latin1' || a.text === b.text || b.text.includes(REPLACEMENT)) &&
			(mode === 'utf8' ? byteOffset : a.offset) === b.offset &&
			aLength === b.length;
		if (!same) {
			const ts = a && {
				type: a.type,
				offset: mode === 'utf8' ? byteOffset : a.offset,
				length: aLength
			};
			return `query ${index} ${mode}, token ${i}: ts ${JSON.stringify(ts)} php ${JSON.stringify(b)}`;
		}
		byteOffset += aLength;
	}
	return `query ${index} ${mode}: token streams equal under a re-walk`;
}

console.log(
	JSON.stringify(
		{
			php: phpSummary.php,
			queries: n,
			phpQueries: phpSummary.queries,
			phpTokens: phpSummary.tokens,
			tsTokens,
			comparisons: compared,
			comparisonsUtf8: comparedUtf8,
			invalidUtf8Queries: invalidUtf8,
			differences: differences.length,
			differingQueries: new Set(differences.map((d) => d.index)).size
		},
		null,
		2
	)
);
for (const d of differences.slice(0, 10)) console.log(`${d.kind}: ${explain(d.index, d.mode)}`);
process.exit(differences.length === 0 && n === phpSummary.queries ? 0 : 1);
