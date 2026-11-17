import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PHP_CODEC } from '@drupflare/durabledb/codec';

/** the worker checkout */
export const ROOT = resolve(import.meta.dirname, '../..');

/** where the drop-in and the bridge class live; DRUPFLARE_SRC relocates the checkout */
const DRUPFLARE = process.env.DRUPFLARE_SRC ?? resolve(ROOT, '../drupflare');

/** the WordPress tree every run copies, never edits */
export const WORDPRESS_SRC = process.env.WORDPRESS_SRC ?? join(ROOT, 'wordpress-src');

const PHP = process.env.PHP ?? 'php';
const HERE = import.meta.dirname;

/** one prepared copy of WordPress, ready to install or serve */
export interface Site {
	dir: string;
	www: string;
	log: string;
	socket: string;
	db: string;
	codec: string;
	port: number;
	url: string;
	title: string;
	user: string;
	pass: string;
	email: string;
	/** the eight salts written into this site's wp-config.php */
	salts: string[];
}

/** a finished PHP process */
export interface PhpRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** a free local TCP port */
export function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address !== null ? address.port : 0;
			probe.close(() => resolvePort(port));
		});
	});
}

/** the version of the PHP the harness runs */
export async function phpVersion(): Promise<string> {
	const run = await runPhp(undefined, ['-r', 'echo PHP_VERSION;'], {}, false);
	return run.stdout.trim();
}

/** the two files of the drop-in exist beside this checkout */
export function dropInMissing(): string | undefined {
	for (const name of ['db.php', 'Bridge.php']) {
		try {
			readFileSync(join(DRUPFLARE, 'src/Wp', name));
		} catch {
			return `${join(DRUPFLARE, 'src/Wp', name)} is missing; set DRUPFLARE_SRC`;
		}
	}
	return undefined;
}

/** random bytes as hex; the workers types hide the encoding overload of toString */
const hex = (bytes: number): string =>
	Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** a unix socket path under the 104-byte limit macOS puts on one */
function shortSocketPath(): string {
	const name = `cfw-${hex(4)}.sock`;
	const path = join(tmpdir(), name);
	return path.length < 100 ? path : join('/tmp', name);
}

const salt = () => hex(32);

/**
 * Copies the tree under `dir`, installs the drop-in beside nothing else, and writes a
 * wp-config.php of constants only. `withDropIn: false` leaves wp-content/db.php out, which is how
 * the control proves the spec reads the bridge and not a stray database.
 */
export async function prepareSite(
	dir: string,
	options: {
		withDropIn?: boolean;
		title?: string;
		port?: number;
		origin?: string;
		/** a different mu-plugins directory to install, such as a copy with one hook removed */
		muPlugins?: string;
	} = {}
): Promise<Site> {
	const port = options.port ?? (await freePort());
	const www = join(dir, 'www');
	mkdirSync(dir, { recursive: true });
	cpSync(WORDPRESS_SRC, www, { recursive: true, mode: constants.COPYFILE_FICLONE });
	if (options.withDropIn !== false) {
		for (const name of ['db.php', 'Bridge.php']) {
			copyFileSync(join(DRUPFLARE, 'src/Wp', name), join(www, 'wp-content', name));
		}
	}
	if (options.muPlugins !== undefined) {
		cpSync(options.muPlugins, join(www, 'wp-content/mu-plugins'), { recursive: true });
	}
	const site: Site = {
		dir,
		www,
		log: join(dir, 'debug.log'),
		socket: shortSocketPath(),
		db: join(dir, 'site.sqlite'),
		codec: join(dir, 'codec.php'),
		port,
		url: options.origin ?? `http://127.0.0.1:${port}`,
		title: options.title ?? 'Bridge Front Page Test',
		user: 'admin',
		pass: hex(12),
		email: 'admin@example.test',
		salts: []
	};
	writeFileSync(site.codec, `<?php\n${PHP_CODEC}`);
	const names = [
		'AUTH_KEY',
		'SECURE_AUTH_KEY',
		'LOGGED_IN_KEY',
		'NONCE_KEY',
		'AUTH_SALT',
		'SECURE_AUTH_SALT',
		'LOGGED_IN_SALT',
		'NONCE_SALT'
	];
	site.salts = names.map(() => salt());
	const config = [
		'<?php',
		"define( 'DB_NAME', 'wordpress' );",
		"define( 'DB_USER', 'bridge' );",
		"define( 'DB_PASSWORD', '' );",
		"define( 'DB_HOST', 'bridge' );",
		"define( 'DB_CHARSET', 'utf8mb4' );",
		"define( 'DB_COLLATE', '' );",
		...names.map((n, i) => `define( '${n}', '${site.salts[i]}' );`),
		"$table_prefix = 'wp_';",
		`define( 'WP_HOME', '${site.url}' );`,
		`define( 'WP_SITEURL', '${site.url}' );`,
		"define( 'DISALLOW_FILE_MODS', true );",
		"define( 'DISABLE_WP_CRON', true );",
		"define( 'WP_HTTP_BLOCK_EXTERNAL', true );",
		"define( 'WP_ACCESSIBLE_HOSTS', '127.0.0.1' );",
		"define( 'WP_DEBUG', true );",
		"define( 'WP_DEBUG_DISPLAY', false );",
		`define( 'WP_DEBUG_LOG', '${site.log}' );`,
		"define( 'SAVEQUERIES', true );",
		"if ( ! defined( 'ABSPATH' ) ) {",
		"\tdefine( 'ABSPATH', __DIR__ . '/' );",
		'}',
		"require_once ABSPATH . 'wp-settings.php';",
		''
	].join('\n');
	writeFileSync(join(www, 'wp-config.php'), config);
	return site;
}

/** the environment every PHP process of a site gets */
function siteEnv(site: Site, label: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		WP_ROOT: site.www,
		CFW_SOCKET: site.socket,
		CFW_CODEC: site.codec,
		CFW_LABEL: label,
		WP_TITLE: site.title,
		WP_USER: site.user,
		WP_PASS: site.pass,
		WP_EMAIL: site.email
	};
}

const iniFlags = (site: Site | undefined): string[] => [
	'-d',
	'display_errors=0',
	'-d',
	'memory_limit=512M',
	'-d',
	'sendmail_path=/usr/bin/true',
	'-d',
	'max_execution_time=0',
	...(site === undefined
		? []
		: ['-d', `auto_prepend_file=${join(HERE, 'stub.php')}`, '-d', `error_log=${site.log}`])
];

/** runs one PHP process to the end, with the stub prepended when there is a site */
export function runPhp(
	site: Site | undefined,
	args: string[],
	env: NodeJS.ProcessEnv = {},
	stub = true
): Promise<PhpRun> {
	return new Promise((done, fail) => {
		const child = spawn(PHP, [...iniFlags(stub ? site : undefined), ...args], {
			env: { ...(site === undefined ? process.env : siteEnv(site, 'cli')), ...env }
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
		child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
		child.once('error', fail);
		child.once('close', (code) => done({ code, stdout, stderr }));
	});
}

/** runs WordPress's own installer through the CLI bootstrap */
export function installWordpress(site: Site): Promise<PhpRun> {
	return runPhp(site, [join(HERE, 'install.php')], { CFW_LABEL: 'install' });
}

/** a reply to one HTTP request */
export interface Fetched {
	status: number;
	bytes: number;
	body: string;
	location: string | null;
	contentType: string | null;
}

/** one GET, redirects not followed */
export async function httpGet(site: Site, path: string): Promise<Fetched> {
	const res = await fetch(site.url + path, { redirect: 'manual' });
	const body = await res.text();
	return {
		status: res.status,
		bytes: Buffer.byteLength(body),
		body,
		location: res.headers.get('location'),
		contentType: res.headers.get('content-type')
	};
}

/** a running `php -S` */
export interface PhpServer {
	child: ChildProcess;
	stop(): Promise<void>;
}

/** starts `php -S` over the tree with the router and the stub, and waits until it answers */
export async function startPhpServer(site: Site): Promise<PhpServer> {
	const child = spawn(
		PHP,
		[
			...iniFlags(site),
			'-S',
			`127.0.0.1:${site.port}`,
			'-t',
			site.www,
			join(HERE, 'router.php')
		],
		{ env: siteEnv(site, 'server'), stdio: ['ignore', 'ignore', 'pipe'] }
	);
	let stderr = '';
	child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			const res = await fetch(`${site.url}/__ping`);
			if (res.ok) break;
		} catch {
			/* not listening yet */
		}
		if (Date.now() > deadline || child.exitCode !== null) {
			child.kill();
			throw new Error(`php -S did not start: ${stderr.slice(0, 400)}`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return {
		child,
		stop: () =>
			new Promise<void>((done) => {
				if (child.exitCode !== null) return done();
				child.once('close', () => done());
				child.kill('SIGTERM');
			})
	};
}

/** the PHP error log of a site, or an empty string when nothing was logged */
export function readLog(site: Site): string {
	try {
		return readFileSync(site.log, 'utf8');
	} catch {
		return '';
	}
}
