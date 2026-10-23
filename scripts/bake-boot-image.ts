/**
 * Captures the shared boot images into `assets/bootimage/`.
 *
 *   bun scripts/bake-boot-image.ts [--only=pack|claimed] [--paths=/,/user/login]
 *
 * Boots the worker locally with `BOOT_IMAGE_BAKE=1`, migrates a throwaway site, renders the paths and
 * reads back every 64 KiB page that differs from the heap at the point a restore writes into. The
 * `pack` image is taken from a site the pack made; the `claimed` image from the same site after its
 * first-run claim, and it is keyed without the config rows because every claimed site has its own.
 * The heap is published with the site, so the bake site holds no real secret: it is a fresh local
 * object with its own random salt and key, and a restore replaces both. A site boots from an image
 * only when its context equals the bake's, so a stale image costs a plain boot and never a wrong
 * page.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	BOOT_IMAGE_VARIANTS,
	bootImageDir,
	type BootImageIndex,
	type BootImageVariant
} from '../src/ops/boot-image.ts';
import { withWrangler } from './bake-container';
import {
	checkCapture,
	INTERPRETER_WASM,
	interpreterDigest,
	PACK_SQLITE,
	packConfigDigest
} from './boot-image-pack';

const ASSETS = resolve(import.meta.dirname, '..', 'assets');

const arg = (name: string): string | undefined =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

type Capture = { index: BootImageIndex; files: Map<string, Uint8Array> };

/** the name a claimed bake site carries; an image holds none of it after the restore resets config */
const CLAIMED_NAME = 'Baked Site';

async function capture(variant: BootImageVariant, paths: string): Promise<Capture> {
	const site = `bootimage-bake-${Date.now().toString(36)}`;
	const host = { Host: `${site}.localhost` };
	const vars = ['RECONCILE:0', 'BOOT_IMAGE_BAKE:1'];
	// its own state, or every object an earlier bake left wakes beside this one
	const state = await mkdtemp(join(tmpdir(), 'bootimage-bake-'));
	try {
		await withWrangler(
			state,
			async (base) => {
				const migrated = await fetch(`${base}/migrate?all=1&prefill=0`, { headers: host });
				if (!migrated.ok) throw new Error(`migrate answered ${migrated.status}`);
			},
			vars
		);
		if (variant === 'claimed') {
			// its own process: workerd died after the claim while it held the migration's interpreter
			await withWrangler(
				state,
				async (base) => {
					const claimed = await fetch(`${base}/firstrun`, {
						method: 'POST',
						headers: { ...host, 'content-type': 'application/json' },
						body: JSON.stringify({ siteName: CLAIMED_NAME })
					});
					if (!claimed.ok) throw new Error(`firstrun answered ${claimed.status}`);
				},
				vars
			);
		}
		return await withWrangler(
			state,
			async (base) => {
				const scope = variant === 'claimed' ? '&scope=reset' : '';
				const res = await fetch(
					`${base}/heap?op=bootimage&paths=${encodeURIComponent(paths)}${scope}`,
					{ headers: host }
				);
				const text = await res.text();
				if (!res.ok)
					throw new Error(`capture answered ${res.status}: ${text.slice(0, 300)}`);
				const body = JSON.parse(text) as {
					index: BootImageIndex;
					rendered: { path: string; filled?: string }[];
				};
				for (const page of body.rendered)
					console.log(
						`${variant}: rendered ${page.path}: ${page.filled ?? 'no page stored'}`
					);
				const files = new Map<string, Uint8Array>();
				for (const chunk of body.index.chunks) {
					const part = await fetch(`${base}/heap?op=bootimage&file=${chunk.file}`, {
						headers: host
					});
					if (!part.ok) throw new Error(`${chunk.file} answered ${part.status}`);
					files.set(chunk.file, new Uint8Array(await part.arrayBuffer()));
				}
				return { index: body.index, files };
			},
			vars
		);
	} finally {
		await rm(state, { recursive: true, force: true });
	}
}

async function publish(variant: BootImageVariant, { index, files }: Capture): Promise<void> {
	const dir = join(ASSETS, bootImageDir(variant));
	await mkdir(dir, { recursive: true });
	// only this directory's own files, by name: a stale chunk would sit beside the new index
	for (const name of await readdir(dir))
		if (/^c\d{3,}\.bin$/.test(name) || name === 'index.json') await rm(join(dir, name));
	for (const [name, bytes] of files) await writeFile(join(dir, name), bytes);
	await writeFile(
		join(dir, 'index.json'),
		JSON.stringify({ ...index, interpreter: interpreterDigest() })
	);
	const pages = index.chunks.reduce((n, c) => n + c.pages.length, 0);
	console.log(
		`${variant}: ${files.size} files, ${pages} pages (${((pages * 65_536) / 1e6).toFixed(1)} MB), ` +
			`memory ${index.byteLength / 65_536} pages, context ${index.context}`
	);
}

async function main(): Promise<void> {
	for (const path of [PACK_SQLITE, INTERPRETER_WASM])
		if (!existsSync(path)) throw new Error(`${path} is not on disk`);
	const only = arg('only');
	if (only && !(BOOT_IMAGE_VARIANTS as readonly string[]).includes(only))
		throw new Error(`--only is one of ${BOOT_IMAGE_VARIANTS.join(', ')}`);
	const packDigest = packConfigDigest();
	for (const variant of BOOT_IMAGE_VARIANTS) {
		if (only && only !== variant) continue;
		const captured = await capture(variant, arg('paths') ?? '/,/user/login');
		checkCapture(variant, captured.index, packDigest);
		await publish(variant, captured);
	}
}

if (import.meta.main) await main();
