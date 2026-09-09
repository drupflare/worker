/**
 * The packed driver's identity. GENERATED -- run `bun run assets:driver` after any change in a
 * sibling; `tests/node/driver-pack.spec.ts` fails on drift.
 */
export const DRIVER_DIGEST = 'ec8562c9a68b4092';

/**
 * The route names the packed modules declare, so a site can be asked whether its router has them.
 *
 * The shipped pack listed drupflare in core.extension and carried NONE of its routes, because the
 * module was enabled into the database before those routes existed and router is a table rather
 * than a cache. The router step in RECONCILE_STEPS compares this list against a site's own rows.
 */
export const DRIVER_ROUTES: readonly string[] = [
	'drupflare.admin',
	'drupflare.oidc_complete',
	'drupflare.ops_terminal',
	'drupflare.status'
];
