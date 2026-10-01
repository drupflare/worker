import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { setupHtml } from '../../src/ops/setup-page';
import {
	renderAccess,
	renderDeploy,
	renderExtend,
	renderGit,
	renderOperate
} from '../../src/ui/admin';

/**
 * The inline scripts the served pages carry, parsed.
 *
 * Every one is a JavaScript file under `src/site/js` that a template drops into a `<script>` tag, so
 * a syntax error never reaches an editor or the type checker: the page renders, the buttons do
 * nothing and the console is the only place it shows. The Operate page shipped that way, with an
 * unescaped apostrophe in a single-quoted string. Parsing needs `new Script`, which the workers
 * pool refuses, so this lives in the node project.
 */

const PAGES: Array<[string, string]> = [
	['setup', setupHtml('https://site.example')],
	[
		'access',
		renderAccess({
			issuer: 'https://issuer.example',
			clientId: 'client',
			secretPresent: true,
			redirectUri: 'https://site.example/cb'
		})
	],
	['deploy connected', renderDeploy({ connected: true, accountId: 'acc-1' })],
	['extend', renderExtend(undefined, [], undefined)],
	['git', renderGit([], 0)],
	['operate', renderOperate()]
];

const scriptsIn = (html: string) =>
	[...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1] ?? '');

describe('inline page scripts', () => {
	it.each(PAGES)('%s carries a script that parses', (name, html) => {
		const scripts = scriptsIn(html);
		expect(scripts.length, name).toBeGreaterThan(0);
		for (const source of scripts) expect(() => new Script(source), name).not.toThrow();
	});

	it('leaves no template token in any page', () => {
		for (const [name, html] of PAGES) expect(html, name).not.toMatch(/__CFW_[A-Z0-9_]+__/);
	});

	it('catches a script that does not parse, so the check is not vacuous', () => {
		expect(() => new Script("const s = 'object's start';")).toThrow();
	});
});
