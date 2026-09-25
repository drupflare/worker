/**
 * The packed driver's identity. GENERATED -- run `bun run assets:driver` after any change in a
 * sibling; `tests/node/driver-pack.spec.ts` fails on drift.
 */
export const DRIVER_DIGEST = '6562a53aefa2c005';

/**
 * The route names the packed modules declare, so a site can be asked whether its router has them.
 *
 * The shipped pack listed drupflare in core.extension and carried NONE of its routes, because the
 * module was enabled into the database before those routes existed and router is a table rather
 * than a cache. The router step in RECONCILE_STEPS compares this list against a site's own rows.
 */
export const DRIVER_ROUTES: readonly string[] = [
	'drupflare.admin',
	'drupflare.modules',
	'drupflare.oidc_complete',
	'drupflare.ops_terminal',
	'drupflare.settings',
	'drupflare.status'
];

/**
 * The permission each packed route requires. A router row keeps the requirement it was built with,
 * so a renamed permission reaches an existing site only when the router step sees the difference.
 */
export const DRIVER_ROUTE_PERMISSIONS: Readonly<Record<string, string>> = {
	'drupflare.admin': 'view drupflare status+administer site configuration',
	'drupflare.modules': 'administer drupflare owner',
	'drupflare.ops_terminal': 'administer drupflare site',
	'drupflare.settings': 'administer drupflare site',
	'drupflare.status': 'view drupflare status+administer site configuration'
};
