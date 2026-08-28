/**
 * The 2,466 export trampolines emscripten emits, replaced by one lazy binder inside
 * `receiveInstance` -- the first point the export table exists, since `createWasm()` returns `{}` on
 * the async path. Only wrappers no other glue code reads go; `_main` and five `dynCall_*` stay.
 */

/** `var X=Module["K"]=(args)=>(X=Module["K"]=wasmExports["E"])(args);` */
const WRAPPER =
	/var ([A-Za-z0-9_$]+)=Module\["([^"]+)"\]=\(([a-z0-9,]*)\)=>\(\1=Module\["\2"\]=wasmExports\["([^"]+)"\]\)\(\3\);/g;

/**
 * Where the binder is inserted.
 *
 * `applySignatureConversions` returns `Object.assign({}, wasmExports)`, a plain enumerable object,
 * so `for...in` sees every export. Anchored on the assignment rather than on `createWasm()` because
 * that call returns an empty object on the async instantiation path.
 */
const INSTALL_SITE = 'wasmExports=applySignatureConversions(wasmExports);';

/**
 * Self-rebinding, so a hot export pays the indirection once rather than per call -- the property
 * emscripten's own wrapper has and the reason this is not a plain forwarding closure.
 */
const BINDER =
	'for(var __cfwK in wasmExports){(function(k){var n="_"+k;if(n in Module)return;' +
	'Module[n]=function(){var f=wasmExports[k];Module[n]=f;return f.apply(null,arguments)}})(__cfwK)}';

export type StripResult = {
	source: string;
	/** how many trampolines were removed */
	removed: number;
	/** locals the glue still reads, so their declarations stay */
	kept: string[];
	bytesSaved: number;
};

/** every wrapper in the glue, as (local, moduleKey, exportName) */
export function wrappers(glue: string): { local: string; key: string; exportName: string }[] {
	return [...glue.matchAll(WRAPPER)].map((m) => ({
		local: m[1] as string,
		key: m[2] as string,
		exportName: m[4] as string
	}));
}

/**
 * Removes every trampoline the glue does not read back, and installs the binder.
 *
 * A wrapper is kept when its `Module` key is not `"_" + exportName` -- the `dynCall_*` family --
 * because the binder only ever writes the prefixed name, or when the local identifier appears
 * anywhere else in the glue.
 */
export function stripExportWrappers(glue: string): StripResult {
	if (!glue.includes(INSTALL_SITE)) {
		throw new Error('signature-conversion site not found; emscripten changed its emitted form');
	}
	const all = wrappers(glue);
	if (all.length === 0) throw new Error('no export trampolines found in the glue');

	const prefixed = all.filter((w) => w.key === `_${w.exportName}`);
	// a reference count taken WITHOUT the declarations, or every local counts itself
	const bare = glue.replace(WRAPPER, (m, local) =>
		prefixed.some((w) => w.local === local) ? '' : m
	);
	const kept = prefixed
		.filter((w) => new RegExp(`(?<![A-Za-z0-9_$])${w.local}(?![A-Za-z0-9_$])`).test(bare))
		.map((w) => w.local);
	const keptSet = new Set(kept);

	let removed = 0;
	const out = glue.replace(WRAPPER, (m, local, key, _args, exportName) => {
		if (key !== `_${exportName}` || keptSet.has(local)) return m;
		removed++;
		return '';
	});
	return {
		source: out.replace(INSTALL_SITE, INSTALL_SITE + BINDER),
		removed,
		kept,
		bytesSaved: glue.length - out.length
	};
}
