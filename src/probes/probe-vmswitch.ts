// must evaluate before the glue; see the file for why
import '@drupflare/cartridge/shim';

import PHPFactory from '../../vendor/static-vmswitch/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-vmswitch/php8.3-worker.mjs.wasm';
import { makeProbeWorker } from './probe-core';

export default makeProbeWorker({
	wasmModule,
	PHPFactory,
	label: 'static-vmswitch'
});
