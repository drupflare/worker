import { HOST_HELPERS } from '../../src/site/shims/host-helpers';
import { freshSite, inObject, type ServeDo } from './serve-do';

/**
 * Runs PHP inside a real WordPress object. Needs the built WordPress pack, so the specs that use
 * it are listed in `ARTIFACT_SPECS`.
 */

/** the host plugin files as they sit in the sibling checkout, which a pack rebuilt later will carry */
const MU = import.meta.glob('../../../drupflare/src/Wp/mu/**/*.php', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/** the site address every WordPress spec serves from */
export const WP_ORIGIN = 'https://wp.example';

/** the object plus the calls these specs need on it */
export type WordpressSite = ServeDo & {
	migrator(): { runAll(): Promise<{ done: boolean; chunks: number }> };
	resetPhp(): void;
	runJsonMaybeParked(code: string): Promise<Record<string, unknown>>;
};

/** PHP that writes the sibling's host plugin over the pack's copy, so a spec reads current code */
function overlay(): string {
	const lines: string[] = [];
	for (const [path, text] of Object.entries(MU)) {
		const rel = path.slice(path.indexOf('/mu/') + 4);
		const target = `/wordpress/wp-content/mu-plugins/${rel}`;
		lines.push(
			`@mkdir(dirname('${target}'), 0777, true); file_put_contents('${target}', base64_decode('${btoa(
				unescape(encodeURIComponent(text))
			)}'));`
		);
	}
	return lines.join('\n');
}

const PRELUDE = `
$_SERVER['HTTP_HOST'] = 'wp.example';
$_SERVER['SERVER_NAME'] = 'wp.example';
$_SERVER['SERVER_PORT'] = '443';
$_SERVER['HTTPS'] = 'on';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/wordpress/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/wordpress';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
chdir('/wordpress');
ob_start();
$GLOBALS['wp_filter']['wp_die_handler'] = [
	0 => [
		[
			'function' => static function () {
				return static function ($message) {
					throw new RuntimeException(
						trim(strip_tags(is_wp_error($message) ? $message->get_error_message() : (string) $message))
					);
				};
			},
			'accepted_args' => 1,
		],
	],
];
`;

/**
 * Runs PHP after WordPress has loaded, on a fresh interpreter, and returns what it put in `$out`.
 * The host plugin comes from the sibling checkout, not from the pack.
 */
export async function inWordpress(
	site: WordpressSite,
	body: string,
	options: { fetcher?: typeof fetch; before?: string } = {}
): Promise<Record<string, unknown>> {
	site.resetPhp();
	if (options.fetcher) site.parkFetchDep = options.fetcher;
	return site.runJsonMaybeParked(
		`<?php ${HOST_HELPERS}\n$out = [];\ntry {\n${overlay()}\n${PRELUDE}\n${options.before ?? ''}\nrequire '/wordpress/wp-load.php';\n${body}\n} catch (Throwable $e) {\n$out['fatal'] = get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine();\n}\nwhile (ob_get_level() > 0) { ob_end_clean(); }\necho json_encode($out, JSON_INVALID_UTF8_SUBSTITUTE);`
	);
}

/**
 * Puts the sibling's host plugin into the interpreter's filesystem and loads nothing else, so the
 * next request fragment on the same interpreter reads current code from the pack's own path.
 */
export async function overlayHostPlugin(site: WordpressSite): Promise<void> {
	site.resetPhp();
	await site.runJsonMaybeParked(`<?php ${overlay()}\necho '{}';`);
}

/** a multipart body holding plain fields and one file, as a browser sends it */
export function multipartBody(
	fields: Record<string, string>,
	file: { field: string; name: string; type: string; bytes: Uint8Array }
): { contentType: string; bodyBase64: string } {
	const boundary = '----cfwtest7d3f1c';
	const text = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			text.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
			)
		);
	}
	parts.push(
		text.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`
		),
		file.bytes,
		text.encode(`\r\n--${boundary}--\r\n`)
	);
	const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		all.set(p, at);
		at += p.length;
	}
	let binary = '';
	for (const byte of all) binary += String.fromCharCode(byte);
	return { contentType: `multipart/form-data; boundary=${boundary}`, bodyBase64: btoa(binary) };
}

/** points the object at the WordPress pack and runs its migration */
export async function configureWordpress(
	site: ServeDo,
	env: Record<string, unknown> = {}
): Promise<WordpressSite> {
	// a copy for this object: the env a spec starts from is shared, so mutating it leaks into the next
	site.env = {
		...site.env,
		CMS: 'wordpress',
		SQL_CHUNK_PREFIX: 'wordpress/sql',
		SITE_ORIGIN: WP_ORIGIN,
		HEAP_SNAPSHOT: '0',
		...env
	};
	const wp = site as WordpressSite;
	await wp.migrator().runAll();
	return wp;
}

export { freshSite, inObject };
