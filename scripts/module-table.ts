import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderModuleTable, TABLE_BEGIN, TABLE_END } from '../src/ops/module-table.js';

/**
 * Prints the generated module table, and with `--write` puts it into README.md.
 *
 *   bun scripts/module-table.ts            print the block
 *   bun scripts/module-table.ts --write    replace the region between the markers
 *
 * `tests/node/module-table.spec.ts` fails when README.md and the classifier disagree and prints the
 * regenerated block in the failure message, which made the fix a 44-row paste. This is the same
 * block through a command, so the fix cannot introduce a typo the test then reports as drift.
 */

const README = resolve(import.meta.dirname, '..', 'README.md');
const block = renderModuleTable();

if (!process.argv.includes('--write')) {
	console.log(block);
	process.exit(0);
}

const readme = readFileSync(README, 'utf8');
const from = readme.indexOf(TABLE_BEGIN);
const to = readme.indexOf(TABLE_END);
if (from === -1 || to === -1) {
	console.error(`README.md has no ${TABLE_BEGIN} / ${TABLE_END} pair; nothing to replace`);
	process.exit(1);
}

const next = readme.slice(0, from) + block + readme.slice(to + TABLE_END.length);
if (next === readme) {
	console.log('README.md already matches the classifier');
	process.exit(0);
}
writeFileSync(README, next);
console.log(`README.md module table rewritten, ${block.split('\n').length} lines`);
