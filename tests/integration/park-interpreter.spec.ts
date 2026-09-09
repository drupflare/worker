import { describe, expect, it } from 'vitest';
import { PARK_PROBE, parkTrapInstall } from '../../src/ops/park';
import { drivePark, ParkSockets } from '../../src/ops/park-drive';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The park against the interpreter the gate loads, and against a REAL socket.
 *
 * `vitest.config.ts` aliases the interpreter seam to `.interp/php8.5.wasm`, so this drives whatever
 * binary is on disk. Three build states are told apart rather than collapsed, and the middle one is
 * why: `absent` cannot park at all, a build without the `cfw_park_resume` re-arm parks ONCE and then
 * falls through silently, and a current build multi-trips. A silent fall-through is the refusal path,
 * so it looks deliberate -- which is exactly the shape that has to be named rather than skipped past.
 *
 * The socket half needs the rig: `docker compose -f docker/compose.yml up -d redis`.
 */

const REDIS = { REDIS_URL: 'redis://:testpass@127.0.0.1:6379' };

type Interp = ServeDo & { run: (code: string) => Promise<string> };

const canPark = async (site: ServeDo) => (await site.runJson(PARK_PROBE))['park'] === true;

/**
 * Whether a chain parked in ONE invocation can be resumed in a LATER one.
 *
 * **THE INVOCATION BOUNDARY IS THE WHOLE MEASUREMENT**, and a probe that misses it reports a
 * capability the product cannot use. `socket.park.inline` in the capability contract runs the same
 * two-park sequence and answers TRUE -- because a contract probe is one PHP expression, so its run
 * and both its resumes happen inside a single `_run`. A host able to answer inside one `_run` would
 * not need a park at all: the point of parking is for JavaScript to await in between.
 *
 * So the run happens here and the resume happens in a separate `run()`, which is what `drivePark`
 * does on every trip.
 */
async function canMultiTrip(site: ServeDo): Promise<boolean> {
	const code =
		"function two() { $a = @stream_socket_client('tcp://a.invalid:6379', $e1, $m1, 1); " +
		"$b = @stream_socket_client('tcp://b.invalid:6379', $e2, $m2, 1); " +
		"return (is_string($a) ? 'A' : 'a') . (is_string($b) ? 'B' : 'b'); } " +
		"$GLOBALS['TWO'] = two();";
	const one = site as Interp;
	await site.runJson(parkTrapInstall(['socket']));
	const ran = await site.runJson(
		`<?php echo json_encode(['s' => cfw_park_run(base64_decode('${btoa(code)}'))]);`
	);
	if (ran['s'] !== 'PARKED') return false;
	// resume the first with a string, then ask whether a SECOND park is waiting
	await one.run("<?php cfw_park_resume('A');");
	const held = await site.runJson(
		'<?php echo json_encode(["held" => cfw_park_pending() !== null]);'
	);
	if (held['held'] === true) {
		await one.run("<?php cfw_park_resume('B');");
		return true;
	}
	return false;
}

describe('the park, against the interpreter on disk', () => {
	it('reports which of the three build states this artifact is in', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const park = await canPark(site);
			const version = await site.runJson('<?php echo json_encode(["v" => PHP_VERSION]);');
			const multi = park ? await canMultiTrip(site) : false;
			return { park, multi, version: String(version['v'] ?? '') };
		});
		// not an assertion about WHICH build is on disk; each is a valid state and the point is
		// that they are reported rather than inferred
		expect(seen.version).toMatch(/^8\.5\./);
		expect(typeof seen.park).toBe('boolean');
		expect(typeof seen.multi).toBe('boolean');
		// a build cannot multi-trip without the extension, which is the one combination that would
		// mean the probe is reading something other than the park
		if (seen.multi) expect(seen.park).toBe(true);
		console.log(
			`[park] interpreter ${seen.version} cfwpark=${seen.park} multiTrip=${seen.multi}`
		);
	});

	/**
	 * THE WHOLE MECHANISM, end to end, against a server that is really there.
	 *
	 * PHP speaks RESP over what it believes is a socket; every read and write leaves the interpreter,
	 * is performed in JS, and comes back. `+PONG` can only be produced by the real Redis, so this
	 * cannot pass against a stub.
	 */
	it('carries a real RESP conversation, five parks deep, and PHP gets the answer', async (ctx) => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			if (!(await canPark(site))) return { build: 'absent' as const };
			if (!(await canMultiTrip(site))) return { build: 'no-rearm' as const };

			// a RESP client in PHP: AUTH then PING, which is open + 2 writes + 2 reads
			const code = [
				'function resp(array $args) {',
				'  $out = "*" . count($args) . "\\r\\n";',
				'  foreach ($args as $a) { $out .= "$" . strlen($a) . "\\r\\n" . $a . "\\r\\n"; }',
				'  return $out;',
				'}',
				'function talk() {',
				'  $s = @stream_socket_client("tcp://127.0.0.1:6379", $e, $m, 5);',
				'  if (!is_resource($s)) { return "no-socket"; }',
				'  fwrite($s, resp(["AUTH", "testpass"]));',
				'  $auth = fgets($s);',
				'  fwrite($s, resp(["PING"]));',
				'  $pong = fgets($s);',
				'  return trim((string) $auth) . "|" . trim((string) $pong);',
				'}',
				'echo json_encode(["said" => talk()]);'
			].join('\n');

			const sockets = new ParkSockets();
			const driven = await drivePark(
				{ runText: (c: string) => (site as Interp).run(c) },
				sockets,
				REDIS,
				`<?php ${code}`
			);
			await sockets.closeAll();
			return { build: 'current' as const, driven };
		});

		if (seen.build === 'absent') {
			ctx.skip('this build has no ext/cfwpark; the park is absent rather than broken');
			return;
		}
		if (seen.build === 'no-rearm') {
			ctx.skip(
				'this build parks once and then falls through: ext/cfwpark predates the ' +
					'cfw_park_resume re-arm, so no multi-trip operation can complete on it'
			);
			return;
		}

		const driven = seen.driven;
		console.log(
			`[park] ${driven.state} in ${driven.trips.length} trips: ` +
				`${driven.trips.map((t) => `${t.fn}/${t.op}`).join(' ')} :: ${driven.output.slice(0, 120)}`
		);
		expect(driven.state, driven.why ?? '').toBe('done');
		// the shape of the conversation, not just its result: one open, two writes, two lines
		expect(driven.trips.map((t) => t.op)).toEqual(['open', 'write', 'line', 'write', 'line']);
		// THE PROOF: `+PONG` comes from the real server, so no stub could have produced it
		const said = JSON.parse(driven.output.slice(driven.output.indexOf('{'))) as {
			said?: string;
		};
		expect(said.said).toBe('+OK|+PONG');
	});

	/**
	 * THE CASE THAT MAKES ARMING SURVIVABLE, on the real interpreter.
	 *
	 * The traps are global for the duration of a parked run, so a render that writes to any stream
	 * arrives at the loop on a handle the host never minted. It has to be performed rather than
	 * refused, or arming would break every file write on the site -- and the fall-through path is
	 * PHP, since `fwrite` is trapped and only its alias `fputs` still points at the original.
	 */
	it('performs a write on a handle it never minted, rather than refusing it', async (ctx) => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			if (!(await canPark(site))) return { build: 'absent' as const };
			if (!(await canMultiTrip(site))) return { build: 'no-rearm' as const };

			const code = [
				'function scratch() {',
				'  $f = fopen("php://temp", "r+");',
				'  $n = fwrite($f, "written-through\\n");',
				'  rewind($f);',
				'  $back = fgets($f);',
				'  return $n . ":" . trim((string) $back);',
				'}',
				'echo json_encode(["scratch" => scratch()]);'
			].join('\n');

			const sockets = new ParkSockets();
			const driven = await drivePark(
				{ runText: (c: string) => (site as Interp).run(c) },
				sockets,
				REDIS,
				`<?php ${code}`
			);
			await sockets.closeAll();
			return { build: 'current' as const, driven };
		});

		if (seen.build !== 'current') {
			ctx.skip(`park build state: ${seen.build}`);
			return;
		}
		const driven = seen.driven;
		console.log(
			`[park] passthrough ${driven.state}: ` +
				`${driven.trips.map((t) => `${t.fn}/${t.op}`).join(' ')} :: ${driven.output.slice(0, 80)}`
		);
		expect(driven.state, driven.why ?? '').toBe('done');
		// every trip took the passthrough branch, and the stream still round-tripped its bytes
		expect(new Set(driven.trips.map((t) => t.op))).toEqual(new Set(['passthrough']));
		const out = JSON.parse(driven.output.slice(driven.output.indexOf('{'))) as {
			scratch?: string;
		};
		expect(out.scratch).toBe('16:written-through');
	});

	/**
	 * A REAL RENDER WITH THE TRAPS ARMED, which is what flipping the capability actually turns on.
	 *
	 * `runJsonMaybeParked` sends the render through `cfw_park_run`, and that is `zend_eval_string`
	 * rather than a script: a body opening with `declare(strict_types=1)` would be a fatal, and a
	 * trapped `fwrite` inside the render arrives at the loop on a handle the host never minted. So
	 * the page has to come out intact and the run has to report `done`, on a site that renders
	 * nothing Redis-shaped at all -- zero trips is the expected shape here, and it still exercises
	 * the eval, the loop and the unwind.
	 */
	it('renders a page with the socket traps armed, and the park reports done', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			// RESTORED BEFORE RETURNING: `site.env` is the worker's env object and every object in
			// this lane shares it, so leaving the endpoint set arms the park for later specs. It
			// did, and the `/__serve-stats` case below read `installed` where it wants `ready`
			const before = site.env['REDIS_URL'];
			site.env['REDIS_URL'] = 'redis://:testpass@127.0.0.1:6379';
			try {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				// the serve answers 503 `warming` and queues; the RENDER is the fill, which is the
				// call that goes through `runJsonMaybeParked`
				await site.fetch(new Request('https://real.example/__serve?path=%2F'));
				const res = await site.fetch(new Request('https://do.local/__fill'));
				const html = await res.text();
				const stats = (await (
					await site.fetch(new Request('https://do.local/__serve-stats'))
				).json()) as {
					park?: { state?: string; armed?: string[] };
					lastPark?: { state?: string; trips?: number; why?: string } | null;
				};
				return { status: res.status, bytes: html.length, ...stats };
			} finally {
				if (before === undefined) delete site.env['REDIS_URL'];
				else site.env['REDIS_URL'] = before;
			}
		});
		console.log(`[park] render ${seen.status} ${seen.bytes}b ${JSON.stringify(seen.lastPark)}`);
		expect(seen.park?.state).toBe('installed');
		expect(seen.park?.armed).toContain('stream_socket_client');
		// the render went THROUGH the loop and finished; a refusal here would mean every render on a
		// site with an endpoint configured had been diverted into something that cannot answer
		expect(seen.lastPark?.state, seen.lastPark?.why ?? '').toBe('done');
		expect(seen.status).toBe(200);
	});

	/**
	 * THE HTTP HALF, which is what `drupal/openid_connect` blocks on.
	 *
	 * A trapped `stream_socket_client` carrying a `cfwpark+fetch://` target is a yield rather than a
	 * socket open, and the host answers it with a whole HTTP response. This drives the exact shape
	 * `ParkFetchHandler` produces, against a stub, and asserts the reply reaches PHP decoded -- so a
	 * Guzzle transport built on it returns a real PSR-7 response inside the request that asked.
	 */
	it('answers a parked HTTP request with a whole response', async (ctx) => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			if (!(await canPark(site))) return { build: 'absent' as const };
			if (!(await canMultiTrip(site))) return { build: 'no-rearm' as const };

			const descriptor = btoa(
				JSON.stringify({
					method: 'POST',
					url: 'https://idp.example/token',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: btoa('grant_type=authorization_code&code=abc')
				})
			);
			const code = [
				'function exchange() {',
				`  $raw = @stream_socket_client("cfwpark+fetch://${descriptor}");`,
				'  if (!is_string($raw)) { return "not-a-string"; }',
				'  $r = json_decode($raw, true);',
				'  return $r["status"] . "|" . base64_decode($r["body"]);',
				'}',
				'echo json_encode(["got" => exchange()]);'
			].join('\n');

			const sockets = new ParkSockets();
			const driven = await drivePark(
				{ runText: (c: string) => (site as Interp).run(c) },
				sockets,
				REDIS,
				`<?php ${code}`,
				// a stub, because the assertion is the PARK carrying an HTTP exchange rather than the
				// internet being reachable from the gate
				(async (input: RequestInfo | URL, init?: RequestInit) =>
					new Response(`{"access_token":"t","seen":"${init?.method}:${String(input)}"}`, {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})) as unknown as typeof fetch
			);
			await sockets.closeAll();
			return { build: 'current' as const, driven };
		});

		if (seen.build !== 'current') {
			ctx.skip(`park build state: ${seen.build}`);
			return;
		}
		const driven = seen.driven;
		console.log(`[park] fetch ${driven.state}: ${driven.output.slice(0, 140)}`);
		expect(driven.state, driven.why ?? '').toBe('done');
		expect(driven.trips.map((t) => t.op)).toEqual(['fetch']);
		const out = JSON.parse(driven.output.slice(driven.output.indexOf('{'))) as { got?: string };
		// the status and the body both crossed back into PHP, decoded
		expect(out.got).toBe('200|{"access_token":"t","seen":"POST:https://idp.example/token"}');
	});

	it('reports the park state on /__serve-stats, so absent and idle are told apart', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			// PHP FIRST: `parkState()` probes by running PHP, so reading the stats before any PHP
			// has run reports the default rather than the probe's answer
			const available = await canPark(site);
			const res = await site.fetch(new Request('https://do.local/__serve-stats'));
			const stats = (await res.json()) as {
				park?: { state?: string; armed?: string[] };
				parkSockets?: number;
			};
			return { available, park: stats.park, sockets: stats.parkSockets };
		});
		// three states told apart, and the middle one is the reason this exists: `absent` cannot park,
		// `ready` can park and is diverting nothing, `installed` has traps live.
		//
		// `installed` is the answer on this build, and it was `ready` until `blockingOutbound`
		// became true on 2026-09-08. The `fetch` class needs no endpoint -- the destination is
		// whatever a module asks for and the SSRF guard bounds it -- so it arms on every site that
		// can park. The `socket` class still waits for `REDIS_URL`, which is what makes the armed
		// list assertable rather than a tautology
		expect(seen.park?.state).toBe(seen.available ? 'installed' : 'absent');
		expect(seen.park?.armed).toEqual(seen.available ? ['stream_socket_client'] : []);
		// no socket is opened by arming; the table fills on the first parked open
		expect(seen.sockets).toBe(0);
	});
});
