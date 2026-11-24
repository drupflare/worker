/**
 * Replaces a module's checked-in generated proxy class with a stub that builds the proxy from the
 * service class at load.
 *
 * A proxy generated against an older core declares each method as it was then, and PHP refuses the
 * class once core adds a return type: strawberryfield's `setMapping(array $mapping = NULL)` against
 * core's `: void` stopped the module from enabling. Core's own `ProxyBuilder` reads the current
 * signatures. Its output prints `?mixed` for a method returning `mixed`, which PHP rejects, so that
 * one spelling is corrected.
 *
 * @module
 */

/** a generated proxy lives at `<module>/src/ProxyClass/<Class>.php` and says so in its header */
const PROXY_PATH = /\/src\/ProxyClass\/[^/]+\.php$/;

/** the file a stub is written to, or the source unchanged when it is not a generated module proxy */
export function proxyStub(path: string, source: string): string {
	if (!PROXY_PATH.test(path) || !source.includes('generate-proxy-class.php')) return source;
	const namespace = /namespace\s+([\w\\]+)\\ProxyClass\s*\{/.exec(source)?.[1];
	const name = /class\s+(\w+)\s+extends/.exec(source)?.[1];
	if (namespace === undefined || name === undefined) return source;
	return `<?php

use Drupal\\Core\\ProxyBuilder\\ProxyBuilder;

eval(str_replace('): ?mixed', '): mixed', (new ProxyBuilder())->build('${namespace}\\\\${name}')));
`;
}
