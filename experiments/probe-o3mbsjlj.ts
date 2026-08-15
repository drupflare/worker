// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import PHPFactory from '../vendor/static-o3mbsjlj/php8.3-worker.mjs';
import wasmModule from '../vendor/static-o3mbsjlj/php8.3-worker.mjs.wasm';
import { jspiRoutes } from '../src/probes/jspi-routes';
import { makeProbeWorker } from '../src/probes/probe-core';

// lives here rather than in src/probes/ because src/probes/** are frozen instruments cited by
// figure; this one only has to answer "does the -O3 binary instantiate and what is in it"
export default makeProbeWorker({
	wasmModule,
	PHPFactory,
	label: 'static-o3mbsjlj',
	routes: jspiRoutes
});
