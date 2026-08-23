import { DurableObject } from 'cloudflare:workers';

/**
 * What the DURATION meter actually charges, measured against a known wall clock.
 *
 * P35 recorded that Cloudflare's GraphQL exposes requests, body size, stored bytes and cpuTime "but
 * not duration", so every GB-s figure in the model was derived from cpuTime and carried a caveat.
 * That was wrong: `durableObjectsInvocationsAdaptiveGroups` has no duration, and
 * `durableObjectsPeriodicGroups` has `duration`, `activeTime`, `rowsRead`, `rowsWritten` and
 * `exceededMemoryErrors`. The instrument was the problem, again.
 *
 * NO PHP HERE, DELIBERATELY. The question is what the platform bills for a known amount of wall
 * clock, so the interpreter would only add variance to a measurement that is not about it.
 *
 * EACH ARM IS ITS OWN NAMED OBJECT, because `objectId` is a dimension on the periodic dataset and
 * that is what lets one deploy answer several questions at once.
 *
 * `Date.now()` IS FROZEN between I/O in a Worker, so a spin loop on it never terminates. Every hold
 * below is a real `setTimeout`, which is also the only way to make wall clock pass at all.
 */
export class DurationProbe extends DurableObject {
	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx as never, env as never);
		// a constructor run means the object was cold: either never resident, or hibernated and
		// re-initialised. It is the only signal that distinguishes the two from outside
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS boots (n INTEGER)');
		ctx.storage.sql.exec('INSERT INTO boots (n) VALUES (1)');
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const ms = Number(url.searchParams.get('ms') ?? 0);

		switch (url.pathname) {
			// the calibration: hold one request open for a known number of milliseconds. Whatever
			// `duration` reads for this object divided by the seconds held IS the unit
			case '/hold':
				await new Promise((r) => setTimeout(r, ms));
				return Response.json({ held: ms });

			// arm an alarm and return. A pending alarm is absent from Cloudflare's
			// hibernation-eligibility list, so this object should accrue NO duration while idle --
			// which is the claim the keep-warm chain rests on and which nothing had measured
			case '/arm':
				await this.ctx.storage.setAlarm(Date.now() + Math.max(ms, 60_000));
				return Response.json({ armed: true });

			// the control: touched once, nothing left open, never woken again
			case '/idle':
				return Response.json({ idle: true });

			case '/boots':
				return Response.json({
					boots: this.ctx.storage.sql.exec('SELECT count(*) AS n FROM boots').one().n
				});
		}
		return new Response('no', { status: 404 });
	}

	async alarm(): Promise<void> {
		// deliberately empty: the arm is what is being priced, not what it does
	}
}

export default {
	async fetch(request: Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
		const url = new URL(request.url);
		const arm = url.searchParams.get('arm') ?? 'idle';
		const stub = env.PROBE.get(env.PROBE.idFromName(arm));
		return stub.fetch(new Request(`https://do.local${url.pathname}${url.search}`));
	}
};
