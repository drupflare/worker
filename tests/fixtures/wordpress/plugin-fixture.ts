import type { Registry } from '../../../src/wordpress/registry';
import { buildZip, type BuiltEntry } from './zip-builder';

/** the folder and slug of the fixture plugin */
export const FIXTURE_SLUG = 'fixture-plugin';

/** the main file's path inside the plugin folder, as WordPress names an active plugin */
export const FIXTURE_FILE = `${FIXTURE_SLUG}/${FIXTURE_SLUG}.php`;

/** a plugin that uses an activation hook, an uninstall hook, a front-end hook and a settings page */
export function fixturePhp(version: string): string {
	return `<?php
/**
 * Plugin Name: Fixture Plugin
 * Version: ${version}
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 */

register_activation_hook( __FILE__, 'fixture_plugin_activate' );
register_uninstall_hook( __FILE__, 'fixture_plugin_uninstall' );

function fixture_plugin_activate() {
	update_option( 'fixture_plugin_activated', '${version}' );
}

function fixture_plugin_uninstall() {
	delete_option( 'fixture_plugin_activated' );
}

add_action( 'wp_head', function () {
	echo '<meta name="fixture-plugin" content="${version}">';
} );

add_action( 'admin_menu', function () {
	add_options_page( 'Fixture Plugin', 'Fixture Plugin', 'manage_options', 'fixture-plugin', function () {
		echo '<div class="wrap"><h1>Fixture Plugin ${version}</h1></div>';
	} );
} );
`;
}

/** the archive of one fixture version, with extra entries when a case needs them */
export function fixtureZip(version: string, extra: BuiltEntry[] = []): Uint8Array {
	return buildZip([
		{ name: `${FIXTURE_SLUG}/` },
		{ name: FIXTURE_FILE, data: fixturePhp(version) },
		{ name: `${FIXTURE_SLUG}/assets/app.js`, data: `window.fixturePlugin = '${version}';` },
		...extra
	]);
}

/** `sha256:` and the hex digest of the bytes */
export async function digestOf(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** a registry pinning each archive under its own digest, and a fetcher that serves them by address */
export async function pinArchives(
	archives: Record<string, Uint8Array>,
	slug = FIXTURE_SLUG,
	kind: 'plugin' | 'theme' = 'plugin'
): Promise<{ registry: Registry; fetcher: typeof fetch; requests: string[] }> {
	const versions: Record<string, { digest: string; php: string }> = {};
	const served = new Map<string, Uint8Array>();
	for (const [version, bytes] of Object.entries(archives)) {
		versions[version] = { digest: await digestOf(bytes), php: '7.4' };
		served.set(`https://downloads.wordpress.org/${kind}/${slug}.${version}.zip`, bytes);
	}
	const requests: string[] = [];
	const fetcher = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		requests.push(url);
		const body = served.get(url);
		return body === undefined
			? new Response('not found', { status: 404 })
			: new Response(body as Uint8Array<ArrayBuffer>, { status: 200 });
	}) as typeof fetch;
	return {
		registry: { [slug]: { kind, licence: 'GPL-2.0-or-later', versions } },
		fetcher,
		requests
	};
}
