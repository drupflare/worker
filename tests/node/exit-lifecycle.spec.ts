import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PhpBase } from 'php-wasm/PhpBase';
import { beforeAll, describe, expect, it } from 'vitest';
import { INTERPRETER_MEMORY } from '../../src/do/isolate';
import { EXIT_ERROR, endedInExit, parseJsonReply } from '../../src/ops/json-reply';
import { artifactGate } from './helpers/artifact-gate';

/**
 * What `exit()` does to the shipping interpreter, and the fallback that follows from it.
 *
 * The subject is the pair `src/runtime/php-binary-raw.ts` imports, driven through php-wasm's own
 * `_run()` the way `SitePhpDurableObject.run()` drives it. An exit returns 0 and leaves an instance
 * that executes nothing and prints nothing, so the object has to drop it. The model below is the
 * object's decision (`endedInExit`) plus its drop, with a fresh instance standing in for a boot.
 */

const GLUE = process.env.PIB_GLUE ?? '.interp/php8.5-worker.tuned.mjs';
const WASM = process.env.PIB_WASM ?? '.interp/php8.5.tuned.wasm';
const skip = artifactGate([GLUE, WASM]);

type Interpreter = {
	run(code: string): Promise<{ ret: number; out: string }>;
};

let factory: unknown;
let module: WebAssembly.Module;

beforeAll(async () => {
	if (skip) return;
	// emscripten's worker glue reads self.location, which node has no reason to define
	const g = globalThis as Record<string, unknown>;
	g.location ??= new URL(pathToFileURL(process.cwd() + '/').href);
	g.self ??= globalThis;
	factory = ((await import(pathToFileURL(resolve(GLUE)).href)) as { default: unknown }).default;
	module = await WebAssembly.compile(readFileSync(WASM));
});

function boot(): Interpreter {
	const out: string[] = [];
	const php = new PhpBase(
		Promise.resolve({ default: factory }) as never,
		{
			ini: 'opcache.enable=0\nmemory_limit=256M',
			printErr: () => {},
			instantiateWasm(
				imports: WebAssembly.Imports,
				receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void
			) {
				(imports.env as Record<string, unknown>).memory = new WebAssembly.Memory({
					...INTERPRETER_MEMORY
				});
				WebAssembly.instantiate(module, imports).then((i) => receive(i, module));
				return {};
			}
		} as never
	) as PhpBase & { _run(code: string): Promise<unknown> };
	php.addEventListener('output', (e) => {
		out.push(String((e as CustomEvent).detail));
	});
	return {
		async run(code) {
			out.length = 0;
			const ret = await php._run(code);
			return { ret: Number(ret), out: out.join('') };
		}
	};
}

const ECHO_OK = '<?php echo json_encode(["ok" => true]);';

/** the cases that end the program: no JSON, return code 0 */
const EXITS: Record<string, string> = {
	'exit(0)': '<?php echo "partial"; exit(0);',
	'die with a message': '<?php echo "p"; die("msg");',
	'exit inside call_user_func inside eval':
		'<?php eval(\'call_user_func(function () { echo "in"; exit(0); });\'); echo "after";'
};

/** the cases that fail loudly and leave a working instance */
const FATALS: Record<string, { code: string; ret: number }> = {
	'trigger_error(E_USER_ERROR)': { code: '<?php trigger_error("boom", E_USER_ERROR);', ret: 1 },
	'an uncaught exception': { code: '<?php throw new Exception("boom");', ret: 2 }
};

describe.skipIf(skip)('exit() on the shipping interpreter', () => {
	it.each(Object.entries(EXITS))(
		'%s returns 0 and leaves an instance that prints nothing',
		async (_name, code) => {
			const php = boot();
			expect((await php.run(code)).ret).toBe(0);
			const later = await php.run(ECHO_OK);
			expect(later.out).toBe('');
		}
	);

	it.each(Object.entries(FATALS))(
		'%s returns its fatal code and the instance survives',
		async (_name, { code, ret }) => {
			const php = boot();
			expect((await php.run(code)).ret).toBe(ret);
			expect((await php.run(ECHO_OK)).out).toBe('{"ok":true}');
		}
	);

	it('answers normally when nothing exits', async () => {
		const php = boot();
		const first = await php.run(ECHO_OK);
		expect(first).toEqual({ ret: 0, out: '{"ok":true}' });
		expect((await php.run(ECHO_OK)).out).toBe('{"ok":true}');
	});

	// what a userland wrapper could recover; none of it runs on exit, so none of it can be built on
	it.each([
		[
			'a shutdown function',
			'<?php register_shutdown_function(function () { echo "S"; }); exit(0);',
			''
		],
		[
			'an output buffer callback',
			'<?php ob_start(fn ($b) => "OB[" . $b . "]"); echo "x"; exit(0);',
			'x'
		],
		['a finally block', '<?php try { exit(0); } finally { echo "F"; }', ''],
		[
			'a destructor',
			'<?php class D { function __destruct() { echo "D"; } } $d = new D; exit(0);',
			''
		],
		['a catch of Throwable', '<?php try { exit(0); } catch (Throwable $e) { echo "C"; }', '']
	])('%s does not run on exit', async (_name, code, printed) => {
		expect((await boot().run(code)).out).toBe(printed);
	});

	it('header_register_callback fires at the first byte of output, not at exit', async () => {
		const quiet = await boot().run(
			'<?php header_register_callback(function () { echo "H"; }); exit(0);'
		);
		expect(quiet.out).toBe('');
		const loud = await boot().run(
			'<?php header_register_callback(function () { echo "H"; }); echo "x"; exit(0);'
		);
		expect(loud.out.startsWith('Hx')).toBe(true);
	});
});

/**
 * The object's side: parse the reply, ask `endedInExit`, drop and boot when it says so. One
 * "request" is one run on whichever instance is resident.
 */
class Site {
	php = boot();
	drops = 0;

	async serve(code: string): Promise<Record<string, unknown>> {
		const { ret, out } = await this.php.run(code);
		const reply = parseJsonReply(out);
		const exited = await endedInExit(
			ret,
			reply,
			async (probe) => (await this.php.run(probe)).out
		);
		if (!exited) return reply;
		this.php = boot();
		this.drops += 1;
		return { error: EXIT_ERROR, exited: true };
	}
}

describe.skipIf(skip)('the fallback against the real interpreter', () => {
	it.each(Object.entries(EXITS))(
		'%s: the request fails with the exit error and the next one answers',
		async (_name, code) => {
			const site = new Site();
			const failed = await site.serve(code);
			expect(failed).toEqual({ error: EXIT_ERROR, exited: true });
			expect(site.drops).toBe(1);
			expect(await site.serve(ECHO_OK)).toEqual({ ok: true });
			expect(site.drops).toBe(1);
		}
	);

	it('without the drop the next request reads as an empty reply, which is the defect', async () => {
		const php = boot();
		await php.run(EXITS['exit(0)']!);
		const next = parseJsonReply((await php.run(ECHO_OK)).out);
		expect(next).toEqual({ error: 'no JSON in output', raw: '' });
	});

	it.each(Object.entries(FATALS))('%s: the instance is kept', async (_name, { code }) => {
		const site = new Site();
		const first = site.php;
		await site.serve(code);
		expect(site.php).toBe(first);
		expect(site.drops).toBe(0);
		expect(await site.serve(ECHO_OK)).toEqual({ ok: true });
	});

	it('keeps the instance when the harness finished but printed nothing parseable', async () => {
		const site = new Site();
		const first = site.php;
		const reply = await site.serve('<?php echo "no json here";');
		expect(reply['error']).toBe('no JSON in output');
		expect(site.php).toBe(first);
		expect(await site.serve(ECHO_OK)).toEqual({ ok: true });
	});

	it('survives a run of exits, one fresh instance each', async () => {
		const site = new Site();
		for (const code of Object.values(EXITS)) {
			expect((await site.serve(code))['exited']).toBe(true);
			expect(await site.serve(ECHO_OK)).toEqual({ ok: true });
		}
		expect(site.drops).toBe(Object.keys(EXITS).length);
	});
});
