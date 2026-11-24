import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PAGE = 65_536;
const MIB = 1_048_576;

/** the shipped interpreter this translates; the layout below is read from its own globals */
const SOURCE = '.interp/php8.5.tuned.wasm';

/** the `env.memory` import entry: module name, field name, kind, then limits with a maximum */
const MEMORY_IMPORT = [3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 1];

/** how the module sits in memory, written beside it for the runtime to read */
export interface ElasticLayout {
	arm: string;
	tableBase: number;
	writeTableBase?: number;
	identity: [number, number][];
	heapStart: number;
	frameRuns: [number, number][];
	declaredPages: number;
	sourceSha256: string;
	moduleSha256: string;
	sourceBytes: number;
	moduleBytes: number;
}

const argValue = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];

function patchInitialPages(out: Uint8Array, pages: number): number {
	const buffer = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
	const at = buffer.indexOf(Buffer.from(MEMORY_IMPORT));
	if (at < 0 || buffer.indexOf(Buffer.from(MEMORY_IMPORT), at + 1) >= 0)
		throw new Error('the memory import is not unique');
	const start = at + MEMORY_IMPORT.length;
	let end = start;
	while (out[end]! & 0x80) end++;
	const declared = readUleb(out, start);
	// the declared minimum is a two-byte LEB in this build; keep the width so no offsets move
	if (end - start !== 1 || pages >= 1 << 14) throw new Error('unexpected memory limits');
	out[start] = (pages & 127) | 128;
	out[start + 1] = pages >> 7;
	return declared;
}

function readUleb(bytes: Uint8Array, at: number): number {
	let value = 0;
	let shift = 0;
	for (let i = at; ; i++) {
		value |= (bytes[i]! & 0x7f) << shift;
		shift += 7;
		if (!(bytes[i]! & 0x80)) return value;
	}
}

if (import.meta.main) {
	const arm = argValue('arm') ?? 'dirty';
	const outDir = argValue('out') ?? '.interp';
	const folio = resolve(argValue('folio') ?? process.env.FOLIO_SRC ?? '../../js/folio');
	const { translate } = (await import(
		join(folio, 'scripts/research/elastic-translate.ts')
	)) as typeof import('/Users/gamer/gmitch215/js/folio/scripts/research/elastic-translate.ts');
	const input = readFileSync(SOURCE);
	const { binaryen } = await import(join(folio, 'scripts/research/elastic-walk.ts'));
	const probe = binaryen.readBinary(new Uint8Array(input));
	const top = binaryen.Const.getValueI32(
		binaryen.getGlobalInfo(probe.getGlobalByIndex(0)).init
	) as number;
	probe.dispose();
	const stackBytes = 8 * MIB;
	const stackEnd = top - stackBytes;
	const tableBase = Math.ceil(stackEnd / PAGE) * PAGE;
	const tablePages = (65_536 * 4) / PAGE;
	const common = {
		exempt: true,
		tableBase,
		staticLimit: stackEnd,
		stackFloor: top - MIB
	};
	const options =
		arm === 'call'
			? { ...common, shape: 'call' as const }
			: {
					...common,
					shape: 'inline' as const,
					dirty: true,
					writeTableBase: tableBase + tablePages * PAGE
				};
	const began = performance.now();
	const result = translate(new Uint8Array(input), options);
	const ms = performance.now() - began;
	const out = Uint8Array.from(result.bytes);
	const tablesEnd =
		(options as { writeTableBase?: number }).writeTableBase !== undefined
			? tableBase + 2 * tablePages * PAGE
			: tableBase + tablePages * PAGE;
	// the stack's pinned window is the last MiB below the top; pages between are free for frames
	const tablesPage = tablesEnd / PAGE;
	const windowPage = Math.floor((top - MIB) / PAGE);
	const heapStart = Math.ceil(top / PAGE);
	const declaredPages = patchInitialPages(out, tablesPage + 1);
	if (!WebAssembly.validate(out)) throw new Error('the translated module is not valid');
	mkdirSync(outDir, { recursive: true });
	const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
	const layout: ElasticLayout = {
		arm,
		tableBase,
		...((options as { writeTableBase?: number }).writeTableBase !== undefined
			? { writeTableBase: (options as { writeTableBase: number }).writeTableBase }
			: {}),
		identity: [
			[0, tablesPage],
			[windowPage, heapStart]
		],
		heapStart,
		frameRuns: [
			[tablesPage, windowPage],
			[heapStart, Infinity]
		],
		declaredPages,
		sourceSha256: sha(input),
		moduleSha256: sha(out),
		sourceBytes: input.length,
		moduleBytes: out.length
	};
	writeFileSync(join(outDir, `php8.5.elastic-${arm}.wasm`), out);
	writeFileSync(
		join(outDir, `php8.5.elastic-${arm}.json`),
		JSON.stringify({ ...layout, frameRuns: layout.frameRuns.map(([a, b]) => [a, b === Infinity ? null : b]), stats: result.stats, buildMs: Math.round(ms) }, null, '\t')
	);
	const { patchGlue } = await import(join(folio, 'scripts/research/elastic-pager-glue.ts'));
	const glue = readFileSync('.interp/php8.5-worker.tuned.mjs', 'utf8');
	const patched = (patchGlue(glue) as string)
		.replaceAll('globalThis.__folioHeapHook', 'Module.__folioHeapHook')
		.replaceAll('globalThis.__folioHeap', 'Module.__folioHeap')
		.replaceAll('self.location.href', '"https://invalid.local/php"');
	writeFileSync(join(outDir, 'php8.5-worker.elastic.mjs'), patched);
	console.log(
		JSON.stringify({ arm, bytes: out.length, buildMs: Math.round(ms), top, tableBase, heapStart })
	);
}
