/**
 * Minimal browser-global shims for emscripten's HTML5/DOM event library.
 *
 * The php-wasm glue is built with ENVIRONMENT_IS_WEB=true and evaluates
 * `specialHTMLTargets = [0, document, window]` at module scope, so these must
 * exist before the glue is imported. PHP never drives these paths; they only
 * need to be present, not functional.
 *
 * A production build would drop emscripten's html5 library instead of shimming.
 * Import this FIRST so it evaluates ahead of the glue.
 */

/** the four browser globals the glue reads at module scope; workerd's `globalThis` declares none */
type BrowserGlobals = typeof globalThis & {
	document?: unknown;
	window?: unknown;
	screen?: unknown;
	indexedDB?: unknown;
};

const noop = () => {};

const stubElement = {
	addEventListener: noop,
	removeEventListener: noop,
	getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
	style: {}
};

if (typeof (globalThis as BrowserGlobals).document === 'undefined') {
	(globalThis as BrowserGlobals).document = {
		querySelector: () => null,
		querySelectorAll: () => [],
		getElementById: () => null,
		createElement: () => ({ ...stubElement }),
		addEventListener: noop,
		removeEventListener: noop,
		body: stubElement,
		documentElement: stubElement,
		fullscreenEnabled: false,
		webkitFullscreenEnabled: false,
		currentScript: null,
		URL: 'https://drupal-cfw-test.invalid/'
	};
}

if (typeof (globalThis as BrowserGlobals).window === 'undefined') {
	(globalThis as BrowserGlobals).window = globalThis;
}

if (typeof (globalThis as BrowserGlobals).screen === 'undefined') {
	(globalThis as BrowserGlobals).screen = { width: 0, height: 0 };
}

if (typeof (globalThis as BrowserGlobals).indexedDB === 'undefined') {
	(globalThis as BrowserGlobals).indexedDB = undefined;
}

export {};
