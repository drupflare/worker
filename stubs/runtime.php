<?php

/**
 * @file
 * Declaration-only stubs for the runtime's own symbols, for STATIC ANALYSIS ONLY.
 *
 * Three families: `vrzno_*`, registered by the vrzno extension; `pw_*`, the bridge codec the
 * php-wasm build registers; and the `__CFW_*__` constants, which `renderTemplate()` replaces with
 * a value before a script runs. Nothing else declares them, so phpstan reports each as unknown.
 *
 * NEVER LOAD THIS FILE AT RUNTIME. The extension registers the functions at start, so including
 * this in the wasm build is a `Cannot redeclare` fatal before a byte is served. It is referenced
 * only by `phpstan.neon` (`scanFiles`), and `src/site/php/**` is what ships, through
 * `src/site/generated/assets.ts`.
 *
 * The return types are `mixed` on purpose: the real values are vrzno-wrapped JS objects, which
 * `is_callable()` may not recognise even when they are invocable.
 */

if (!function_exists('vrzno_env')) {
	/**
	 * Resolves a name on the emscripten Module object, as surfaced by vrzno.
	 *
	 * @param string $name
	 *   The Module property to read.
	 *
	 * @return mixed
	 *   The wrapped JS value, or NULL when the name is not present.
	 */
	function vrzno_env(string $name): mixed
	{
		throw new LogicException('vrzno stub called; the extension is not loaded');
	}
}

if (!function_exists('vrzno_await')) {
	/**
	 * Suspends until a JS thenable settles, and returns what it settled with.
	 *
	 * @param mixed $thenable
	 *   A vrzno-wrapped JS promise.
	 *
	 * @return mixed
	 *   The resolved value, wrapped the same way.
	 */
	function vrzno_await(mixed $thenable): mixed
	{
		throw new LogicException('vrzno stub called; the extension is not loaded');
	}
}

if (!function_exists('pw_encode')) {
	/**
	 * Wraps values the JSON bridge cannot carry (wide integers) in an envelope.
	 *
	 * @param mixed $value
	 *   The value to encode, usually the request array.
	 *
	 * @return mixed
	 *   The same shape with wide values enveloped.
	 */
	function pw_encode(mixed $value): mixed
	{
		throw new LogicException('pw_encode stub called; the runtime is not loaded');
	}
}

if (!function_exists('pw_decode')) {
	/**
	 * Reverses pw_encode() on a reply from the host.
	 *
	 * @param mixed $value
	 *   The decoded JSON reply.
	 *
	 * @return mixed
	 *   The same shape with enveloped values restored.
	 */
	function pw_decode(mixed $value): mixed
	{
		throw new LogicException('pw_decode stub called; the runtime is not loaded');
	}
}

// #region template tokens
// A token is a JSON string literal, a number or a boolean once rendered. The initialisers come
// from PHP constants rather than literals so phpstan does not fold a comparison against a value
// the real run replaces (a literal 0 would make every `< __CFW_LEVELS__` always false).
const __CFW_PAYLOAD__ = PHP_VERSION;
const __CFW_PATH__ = PHP_VERSION;
const __CFW_ORIGIN__ = PHP_VERSION;
const __CFW_COOKIE__ = PHP_VERSION;
const __CFW_BINS__ = PHP_VERSION;
const __CFW_TAGS__ = PHP_VERSION;
const __CFW_ROOT__ = PHP_VERSION;
const __CFW_REQUEST__ = PHP_VERSION;
const __CFW_RENAMED__ = PHP_VERSION;
const __CFW_RECIPES__ = PHP_VERSION;
const __CFW_PHASE__ = PHP_VERSION;
const __CFW_OPTIONS__ = PHP_VERSION;
const __CFW_OBSERVATION__ = PHP_VERSION;
const __CFW_NAME__ = PHP_VERSION;
const __CFW_MODULE__ = PHP_VERSION;
const __CFW_MODULES__ = PHP_VERSION;
const __CFW_MODE__ = PHP_VERSION;
const __CFW_AT__ = PHP_INT_SIZE;
const __CFW_MAX__ = PHP_INT_SIZE;
const __CFW_LEVELS__ = PHP_INT_SIZE;
const __CFW_REPEAT__ = PHP_INT_SIZE;
const __CFW_CAP__ = PHP_INT_SIZE - 4;
const __CFW_AGE__ = PHP_INT_SIZE;
const __CFW_RESET_CID__ = PHP_ZTS === 1;
const __CFW_CHECK_REQUIREMENTS__ = PHP_ZTS === 1;
const __CFW_SERVE_ARGS__ = PHP_ZTS === 1;
const __CFW_TARGET__ = PHP_VERSION;
const __CFW_SITE_ORIGIN__ = PHP_VERSION;
const __CFW_LANE__ = PHP_INT_SIZE;
const __CFW_LANES__ = PHP_INT_SIZE;
const __CFW_MEMORY_ITEMS__ = PHP_INT_SIZE;
const __CFW_ARGON2__ = PHP_ZTS === 1;
const __CFW_MEMORY_BINS__ = [PHP_VERSION];
// #endregion
