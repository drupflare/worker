import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PhpBase } from 'php-wasm/PhpBase';
import { beforeAll, describe, expect, it } from 'vitest';
import { INTERPRETER_MEMORY } from '../../src/do/isolate';
import { EXIT_ERROR, endedInExit, parseJsonReply } from '../../src/ops/json-reply';
import { EXIT_REPLY_PHP } from '../../src/site/generated/assets';
import { phpWhen } from '../../src/util/php';
import { artifactGate } from './helpers/artifact-gate';

/**
 * What `exit()` does to the pinned interpreter, and how the harness answers from it.
 *
 * The subject is the pair `src/runtime/php-binary-raw.ts` imports, driven through php-wasm's own
 * `_run()` the way `SitePhpDurableObject.run()` drives it. The pin is built with `PIB_RUN_EXIT`, so
 * an exit ends the script, runs the shutdown functions and leaves an instance that answers the next
 * run. The harness reply comes from `cfw_reply_arm()` (`src/site/php/exit-reply.php`), which the
 * render fragment calls; the cases below run the same function around small scripts.
 */

const GLUE = process.env.PIB_GLUE ?? '.interp/php8.5-worker.tuned.mjs';
const WASM = process.env.PIB_WASM ?? '.interp/php8.5.tuned.wasm';
const skip = artifactGate([GLUE, WASM]);
const HELPERS = phpWhen("!function_exists('cfw_reply_arm')", EXIT_REPLY_PHP);

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

describe.skipIf(skip)('exit() on the pinned interpreter', () => {
	it.each(Object.entries(EXITS))(
		'%s returns 0 and leaves an instance that answers the next run',
		async (_name, code) => {
			const php = boot();
			expect((await php.run(code)).ret).toBe(0);
			expect(await php.run(ECHO_OK)).toEqual({ ret: 0, out: '{"ok":true}' });
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

	it('answers each run of a series of exits', async () => {
		const php = boot();
		for (let i = 0; i < 5; i++) {
			for (const code of Object.values(EXITS)) {
				expect((await php.run(code)).ret).toBe(0);
				expect((await php.run(ECHO_OK)).out).toBe('{"ok":true}');
			}
		}
	});

	it('runs shutdown functions in registration order, and one registered during shutdown last', async () => {
		const php = boot();
		const got = await php.run(
			'<?php register_shutdown_function(function () { echo "A;"; register_shutdown_function(function () { echo "A2;"; }); }); register_shutdown_function(function () { echo "B;"; }); echo "main;"; exit(0);'
		);
		expect(got.out).toBe('main;A;B;A2;');
	});

	it('runs a shutdown function once, on the first exit after it was registered', async () => {
		const php = boot();
		await php.run('<?php register_shutdown_function(function () { echo "S;"; }); echo "one";');
		expect((await php.run('<?php echo "two"; exit(0);')).out).toBe('twoS;');
		expect((await php.run('<?php echo "three"; exit(0);')).out).toBe('three');
	});

	// the wanted behaviour, which the build cannot give until pib_run frees the user shutdown
	// functions at the start of a run that is not a parked resume; it passes when that lands
	it.fails('does not run a shutdown function an earlier run registered', async () => {
		const php = boot();
		await php.run('<?php register_shutdown_function(function () { echo "S;"; }); echo "one";');
		expect((await php.run('<?php echo "two"; exit(0);')).out).toBe('two');
	});

	it('does not run a shutdown function after a fatal', async () => {
		const php = boot();
		const got = await php.run(
			'<?php register_shutdown_function(function () { echo "S;"; }); throw new Exception("x");'
		);
		expect(got.ret).toBe(2);
		expect(got.out).not.toContain('S;');
	});

	it('stops the shutdown list when a shutdown function exits', async () => {
		const php = boot();
		const got = await php.run(
			'<?php register_shutdown_function(function () { echo "1;"; exit(0); }); register_shutdown_function(function () { echo "2;"; }); exit(0);'
		);
		expect(got.out).toBe('1;');
		expect((await php.run(ECHO_OK)).out).toBe('{"ok":true}');
	});

	it.each([
		[
			'an output buffer callback',
			'<?php ob_start(fn ($b) => "OB[" . $b . "]"); echo "x"; exit(0);',
			'OB[x]'
		],
		[
			'a shutdown function and the buffer it prints into',
			'<?php register_shutdown_function(function () { echo "S"; }); ob_start(fn ($b) => "CB(" . $b . ")"); echo "x"; exit(0);',
			'CB(xS)'
		]
	])('fires %s', async (_name, code, printed) => {
		expect((await boot().run(code)).out).toBe(printed);
	});

	it.each([
		['a finally block', '<?php try { exit(0); } finally { echo "F"; }'],
		[
			'a destructor',
			'<?php class D { function __destruct() { echo "D"; } } $d = new D; exit(0);'
		],
		['a catch of Throwable', '<?php try { exit(0); } catch (Throwable $e) { echo "C"; }']
	])('does not run %s on exit', async (_name, code) => {
		expect((await boot().run(code)).out).toBe('');
	});

	it('fires header_register_callback at exit, with or without output', async () => {
		const quiet = await boot().run(
			'<?php header_register_callback(function () { echo "H"; }); exit(0);'
		);
		expect(quiet.out).toBe('H');
		const loud = await boot().run(
			'<?php header_register_callback(function () { echo "H"; }); echo "x"; exit(0);'
		);
		expect(loud.out).toBe('Hx');
	});

	it('keeps headers and the response code across runs, so a harness has to clear them', async () => {
		const php = boot();
		await php.run('<?php ob_start(); header("X-Left: 1"); http_response_code(418); exit(0);');
		const next = await php.run(
			'<?php echo json_encode([http_response_code(), headers_list()]);'
		);
		expect(next.out).toContain('418');
		expect(next.out).toContain('X-Left: 1');
	});
});

/** a script wrapped the way the render fragment is: armed first, answered last */
function harness(
	body: string,
	tail = '$out["html"] = "done"; $reply(false);',
	before = ''
): string {
	return (
		'<?php\n' +
		before +
		HELPERS +
		'\n$out = ["ok" => true];\n' +
		'$reply = cfw_reply_arm(function (bool $exited) use (&$out) {\n' +
		'\tif ($exited) { $out += cfw_exit_fields(); }\n' +
		'\treturn $out;\n' +
		'});\n' +
		body +
		'\n' +
		tail
	);
}

/** the fragment's one request on one resident instance, parsed the way the host parses it */
async function serve(php: Interpreter, body: string, tail?: string, before?: string) {
	const { ret, out } = await php.run(harness(body, tail, before));
	return { ret, out, reply: parseJsonReply(out) };
}

describe.skipIf(skip)('the harness reply', () => {
	it('prints a plain reply with no mark when the script returns', async () => {
		const got = await serve(boot(), 'echo "noise";');
		expect(got.reply).toMatchObject({ ok: true, html: 'done' });
		expect(got.reply['phpExit']).toBeUndefined();
		expect(got.out).not.toContain('\x1e');
	});

	it.each(Object.entries(EXITS))(
		'%s answers what PHP printed as the body',
		async (_name, code) => {
			const php = boot();
			const printed = code.replace('<?php ', '');
			const got = await serve(php, printed);
			expect(got.ret).toBe(0);
			expect(got.reply).toMatchObject({ ok: true, phpExit: true, status: 200 });
			expect(got.reply['html']).toBe(
				{ 'exit(0)': 'partial', 'die with a message': 'pmsg' }[_name] ?? 'in'
			);
			expect(got.reply['bytes']).toBe(String(got.reply['html']).length);
			expect(await serve(php, '')).toMatchObject({ reply: { html: 'done' } });
		}
	);

	it('answers the status, headers and cookies PHP had set', async () => {
		const got = await serve(
			boot(),
			'header("HTTP/1.1 302 Found"); header("Location: /next"); header("Cache-Control: no-store"); ' +
				'header("X-Drupal-Test: yes"); setcookie("sid", "abc"); exit(0);'
		);
		expect(got.reply).toMatchObject({
			status: 302,
			html: '',
			location: '/next',
			cacheControl: 'no-store',
			cacheTags: [],
			setCookie: [expect.stringContaining('sid=abc')],
			passHeaders: { 'x-drupal-test': 'yes', location: '/next' }
		});
	});

	it("does not carry the previous run's status or headers into this one", async () => {
		const php = boot();
		await serve(php, 'header("X-Old: 1"); http_response_code(418); exit(0);');
		const got = await serve(php, 'exit(0);');
		expect(got.reply['status']).toBe(200);
		// an empty PHP array is `[]` in JSON, as in the render fragment
		expect(got.reply['passHeaders']).toEqual([]);
	});

	it('runs shutdown functions first and the reply last', async () => {
		const got = await serve(
			boot(),
			'register_shutdown_function(function () { echo "S;"; }); echo "body;"; exit(0);'
		);
		expect(got.out.startsWith('body;S;\x1ecfw-reply\x1e{')).toBe(true);
		expect(got.reply['html']).toBe('body;S;');
	});

	it('answers the body an output buffer callback produced, and the reply stays outside it', async () => {
		const got = await serve(
			boot(),
			'ob_start(fn ($b) => "CB(" . $b . ")"); echo "x"; ob_start(); echo "y"; exit(0);'
		);
		expect(got.reply['html']).toBe('CB(xy)');
	});

	it('reads headers a header_register_callback sets at exit', async () => {
		const got = await serve(
			boot(),
			'header_register_callback(function () { header("X-Late: 1"); }); ob_start(); echo "x"; exit(0);'
		);
		expect(got.reply).toMatchObject({ html: 'x', passHeaders: { 'x-late': '1' } });
	});

	it('reads past a body that carries more braces than the reply scan tries', async () => {
		const body = '{"a":1} '.repeat(60);
		const got = await serve(boot(), `echo '${body}'; exit(0);`);
		expect(got.reply['html']).toBe(body);
		expect(got.reply['phpExit']).toBe(true);
	});

	it('keeps what the script already filled in', async () => {
		const got = await serve(
			boot(),
			'$out["status"] = 201; $out["html"] = "built"; http_response_code(500); exit(0);'
		);
		expect(got.reply).toMatchObject({ status: 201, html: 'built', phpExit: true });
	});

	it('prints once when the exit hook and the script both reach the reply', async () => {
		const got = await serve(
			boot(),
			'register_shutdown_function(function () { global $reply; $reply(false); });',
			'exit(0);'
		);
		expect(got.out.match(/\{"ok"/g)).toHaveLength(1);
	});

	it('answers an error instead of nothing when building the reply throws', async () => {
		const php = boot();
		const code =
			'<?php\n' +
			HELPERS +
			'\n$r = cfw_reply_arm(function (bool $exited) { throw new RuntimeException("no"); });\nexit(0);';
		const got = parseJsonReply((await php.run(code)).out);
		expect(got).toMatchObject({ error: 'RuntimeException: no', phpExit: true });
	});

	it('leaves nothing armed after a normal return, so another script that exits answers nothing', async () => {
		const php = boot();
		await serve(php, '');
		const got = await php.run('<?php echo "p"; exit(0);');
		expect(got.out).toBe('p');
	});

	it('answers again after a fatal that skipped the reply', async () => {
		const php = boot();
		const fatal = await serve(php, 'throw new Exception("boom");');
		expect(fatal.ret).toBe(2);
		expect(fatal.reply['error']).toBe('no JSON in output');
		expect((await serve(php, 'echo "x"; exit(0);')).reply).toMatchObject({
			phpExit: true,
			html: 'x'
		});
	});

	it('answers every exit in a series, each followed by a normal run', async () => {
		const php = boot();
		for (let i = 0; i < 20; i++) {
			const got = await serve(php, `echo "n${i}"; exit(0);`);
			expect(got.reply).toMatchObject({ phpExit: true, html: `n${i}` });
			expect((await serve(php, '')).reply['html']).toBe('done');
		}
	});

	it('finds the hook again after a shutdown function that exits skipped it', async () => {
		const php = boot();
		const lost = await serve(
			php,
			'exit(0);',
			undefined,
			'register_shutdown_function(function () { exit(0); });\n'
		);
		expect(lost.reply['error']).toBe('no JSON in output');
		let tries = 0;
		let answered = false;
		while (tries < 40 && !answered) {
			tries += 1;
			answered = (await serve(php, 'echo "x"; exit(0);')).reply['phpExit'] === true;
		}
		expect(answered).toBe(true);
		expect(tries).toBeLessThanOrEqual(16);
	});
});

describe('the fallback for an interpreter that is dead after exit()', () => {
	const none = parseJsonReply('partial');
	const dead = async () => '';

	it('reads a dead instance as an exit and names it', async () => {
		expect(await endedInExit(0, none, dead)).toBe(true);
		expect(EXIT_ERROR).toContain('exit()');
	});

	it('leaves a live instance alone when the harness printed nothing parseable', async () => {
		expect(await endedInExit(0, none, async () => 'cfw-alive')).toBe(false);
	});

	it('does not probe a reply that carries the exit mark', async () => {
		let probes = 0;
		const reply = parseJsonReply('body\x1ecfw-reply\x1e{"phpExit":true,"html":""}');
		expect(
			await endedInExit(0, reply, async () => {
				probes += 1;
				return '';
			})
		).toBe(false);
		expect(probes).toBe(0);
	});
});
