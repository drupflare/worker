import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { translate } from '/Users/gamer/gmitch215/js/folio/scripts/research/elastic-translate.ts';
const PAGE = 65536, MIB = 1048576;
const input = readFileSync('/Users/gamer/gmitch215/drupflare/worker/.interp/php8.5.tuned.wasm');
const top = 12805488, stackEnd = top - 8 * MIB;
const tableBase = Math.ceil(stackEnd / PAGE) * PAGE;
const common = { exempt: true, tableBase, staticLimit: stackEnd, stackFloor: top - MIB };
const wt = tableBase + 4 * PAGE;
const arena = { arenas: [{ lo: 65536, size: top - 65536 + 32 * MIB }] };
const arms = {
	'no-exempt-call': { shape: 'call', exempt: false, tableBase },
	'call': { ...common, shape: 'call' },
	'call-hoist': { ...common, shape: 'call', hoist: true },
	'inline': { ...common, shape: 'inline' },
	'inline-dirty': { ...common, shape: 'inline', dirty: true, writeTableBase: wt },
	'inline-hoist': { ...common, shape: 'inline', hoist: true },
	'inline-arena': { ...common, shape: 'inline', ...arena },
	'inline-arena-hoist': { ...common, shape: 'inline', hoist: true, ...arena },
	'inline-arena-hoist-groups': { ...common, shape: 'inline', hoist: true, groups: true, ...arena },
	'inline-trustalign': { ...common, shape: 'inline', hoist: true, trustAlign: true },
	'floor': { ...common, shape: 'inline', floor: true }
};
mkdirSync('matrix', { recursive: true });
const want = process.argv.slice(2);
const code = (f) => {
	const o = execFileSync('/opt/homebrew/bin/wasm-objdump', ['-h', f]).toString();
	const m = o.match(/Code .*size=0x([0-9a-f]+)/);
	return parseInt(m[1], 16);
};
for (const [name, opts] of Object.entries(arms)) {
	if (want.length && !want.includes(name)) continue;
	const t0 = performance.now();
	try {
		const r = translate(new Uint8Array(input), opts);
		const f = `matrix/${name}.wasm`;
		writeFileSync(f, r.bytes);
		console.log(JSON.stringify({ name, bytes: r.bytes.length, code: code(f), ms: Math.round(performance.now() - t0), sites: r.stats.sites, groupSites: r.stats.groupSites, arenaSites: r.stats.arenaSites, hoistedKeys: r.stats.hoistedKeys }));
	} catch (e) {
		console.log(JSON.stringify({ name, error: String(e.message).slice(0, 200) }));
	}
}
