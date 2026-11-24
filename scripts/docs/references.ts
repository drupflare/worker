import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const MARK = 'docs-guides';

const style = `<style>.${MARK}{position:fixed;left:1rem;bottom:1rem;z-index:1000;padding:0.4rem 0.9rem;border-radius:999px;background:#c2540a;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 12px rgb(0 0 0/.25)}.${MARK}:hover{background:#a64608}@media (prefers-color-scheme:dark){.${MARK}{background:#ff9a3c;color:#1a1510}.${MARK}:hover{background:#ff8a1f}}</style>`;

/** the path from where a page's relative links resolve, its base element or else its folder, to the site root */
function rootFrom(html: string, path: string): string {
	const base = html.match(/<base href="([^"]*)"/)?.[1];
	const dir = base ? posix.normalize(posix.join(posix.dirname(path), base)) : posix.dirname(path);
	return '../'.repeat(dir.split('/').filter((part) => part && part !== '.').length);
}

/** a generated reference page with the favicon links and a Guides link back to the docs root */
export function linkBack(html: string, path: string): string {
	if (html.includes(`class="${MARK}"`)) return html;
	const prefix = rootFrom(html, path);
	const icons = html.includes('rel="icon"')
		? ''
		: `<link rel="icon" href="${prefix}drupflare.ico" sizes="any"/><link rel="icon" type="image/png" sizes="128x128" href="${prefix}drupflare_128.png"/><link rel="apple-touch-icon" href="${prefix}drupflare_128.png"/>`;
	return html
		.replace('</head>', () => `${icons}${style}</head>`)
		.replace(
			'</body>',
			() => `<a class="${MARK}" href="${prefix}index.html">Guides</a></body>`
		);
}

/** applies linkBack to every page under api/ and php/ of a built site and returns how many changed */
export function linkReferences(out: string): number {
	let changed = 0;
	for (const entry of readdirSync(out, { recursive: true }) as string[]) {
		const path = entry.replaceAll('\\', '/');
		if (!/^(api|php)\/.+\.html$/.test(path)) continue;
		const file = join(out, path);
		const html = readFileSync(file, 'utf8');
		const next = linkBack(html, path);
		if (next === html) continue;
		writeFileSync(file, next);
		changed++;
	}
	return changed;
}
