import PHPFactory from '../../.interp/php8.5-worker.elastic.mjs';
import wasmModule from '../../.interp/php8.5.elastic-dirty.wasm';
import layout from '../../.interp/php8.5.elastic-dirty.json';

/** the layout `scripts/build-elastic.ts` wrote beside the module, with the open frame run as null */
export type ElasticLayoutFile = {
	tableBase: number;
	writeTableBase?: number;
	identity: [number, number][];
	heapStart: number;
	frameRuns: [number, number | null][];
	moduleBytes: number;
};

/** the translated interpreter, its glue, and where its pieces sit in memory */
export { PHPFactory, wasmModule };
export const elasticLayout = layout as unknown as ElasticLayoutFile;
