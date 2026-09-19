/**
 * The VPS comparison arm, as a Cloudflare Container, with a spend guard that fails closed.
 *
 * `docker/vps.yml` runs the same stack on localhost. That arm has no network term and shares a
 * kernel with its generator, which is the VPS's best case and the standing caveat on every
 * comparison this project has published. This one puts the identical stack in a real region, so
 * both arms are reached the same way and the transport cancels.
 *
 * THE GUARD IS THE REASON THIS FILE IS LONGER THAN ITS JOB. Containers bill memory and disk on the
 * resources PROVISIONED for the instance type, for as long as the instance is awake -- so an arm
 * that is left running spends money while answering nothing, and the natural failure of a
 * measurement rig (the driver dies, the laptop sleeps, the run is abandoned) is exactly the failure
 * that spends the most. Every default here is set so an abandoned run costs the least it can:
 *
 *   - `sleepAfter` is seconds, not the 10m the examples use
 *   - accounting is settled on EVERY request, so a missed `onStop` loses only the tail
 *   - the ceiling is half the included monthly allowance, because the allowance is account-wide and
 *     this object can only see itself
 *   - an unknown instance type REFUSES rather than guessing, since guessing low is how a guard
 *     reports green while spending
 *
 * Enforcement is on unless `VPS_BUDGET_ENFORCE` is explicitly `0`, `false` or `off`.
 */
// this one file under `scripts/` is a Worker rather than a CLI, and the project's tsconfig carries
// node types on purpose. Referenced here rather than added to the project, because workers-types
// shadows the node globals every other script in this directory depends on.
/// <reference types="@cloudflare/workers-types" />
import { Container } from '@cloudflare/containers';
import {
	budgetVerdict,
	INCLUDED_ALLOWANCE,
	resolveInstance,
	type Allowance,
	type InstanceSpec,
	type Verdict
} from './container-budget.js';

type Env = {
	VPS_ARM: DurableObjectNamespace;
	VPS_INSTANCE_TYPE?: string;
	VPS_BUDGET_ENFORCE?: string;
	VPS_BUDGET_RESERVE?: string;
	VPS_SLEEP_AFTER?: string;
	VPS_ALLOWANCE?: string;
};

const OFF = new Set(['0', 'false', 'off', 'no']);

function enforcing(env: Env): boolean {
	return !OFF.has(
		String(env.VPS_BUDGET_ENFORCE ?? '')
			.trim()
			.toLowerCase()
	);
}

function reserveFraction(env: Env): number {
	const raw = Number(String(env.VPS_BUDGET_RESERVE ?? '').trim());
	if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return 0.5;
	return raw;
}

function allowanceFor(env: Env): Allowance {
	const raw = String(env.VPS_ALLOWANCE ?? '').trim();
	if (!raw) return INCLUDED_ALLOWANCE;
	try {
		const parsed = JSON.parse(raw) as Partial<Allowance>;
		return {
			memoryGibHours: Number(parsed.memoryGibHours ?? INCLUDED_ALLOWANCE.memoryGibHours),
			vcpuMinutes: Number(parsed.vcpuMinutes ?? INCLUDED_ALLOWANCE.vcpuMinutes),
			diskGbHours: Number(parsed.diskGbHours ?? INCLUDED_ALLOWANCE.diskGbHours)
		};
	} catch {
		return INCLUDED_ALLOWANCE;
	}
}

export class VpsArm extends Container<Env> {
	override defaultPort = 8080;
	// SECONDS, because memory bills for every one the instance is awake. The examples use 10m and
	// that is the single most expensive default a rig could copy.
	override sleepAfter = '45s';

	private ready = false;

	private store() {
		return (this.ctx.storage as unknown as { sql: SqlStorage }).sql;
	}

	private ensureTable() {
		if (this.ready) return;
		this.store().exec(`CREATE TABLE IF NOT EXISTS budget (k TEXT PRIMARY KEY, v TEXT)`);
		this.ready = true;
	}

	private get(k: string): string | null {
		this.ensureTable();
		const rows = [...this.store().exec<{ v: string }>(`SELECT v FROM budget WHERE k = ?`, k)];
		return rows.length ? rows[0]!.v : null;
	}

	private put(k: string, v: string | null) {
		this.ensureTable();
		if (v === null) this.store().exec(`DELETE FROM budget WHERE k = ?`, k);
		else this.store().exec(`INSERT OR REPLACE INTO budget (k, v) VALUES (?, ?)`, k, v);
	}

	/**
	 * Rolls the open segment into the total and reopens it at now.
	 *
	 * Called on every request rather than only on stop, because `onStop` is not guaranteed to run --
	 * an evicted or crashed instance never fires it, and an accounting scheme that depends on a
	 * clean shutdown under-reports exactly the runs that went wrong.
	 */
	private settle(): number {
		const openedRaw = this.get('segmentStart');
		let accumulated = Number(this.get('accumulatedMs') ?? '0');
		if (!Number.isFinite(accumulated) || accumulated < 0) accumulated = 0;
		if (openedRaw !== null) {
			const opened = Number(openedRaw);
			const now = Date.now();
			if (Number.isFinite(opened) && now > opened) {
				accumulated += now - opened;
				this.put('accumulatedMs', String(accumulated));
			}
			this.put('segmentStart', String(now));
		}
		return accumulated;
	}

	private instance(): InstanceSpec {
		// FAIL CLOSED: an unknown or absent type cannot be costed, and a guard that guesses low is a
		// guard that reports green while spending.
		return resolveInstance(String(this.env.VPS_INSTANCE_TYPE ?? '').trim());
	}

	private verdict(): Verdict {
		return budgetVerdict(
			this.instance(),
			this.settle(),
			allowanceFor(this.env),
			reserveFraction(this.env)
		);
	}

	override onStart() {
		this.put('segmentStart', String(Date.now()));
		this.put('startedAt', this.get('startedAt') ?? String(Date.now()));
	}

	override onStop() {
		this.settle();
		this.put('segmentStart', null);
	}

	override onError(error: unknown) {
		this.settle();
		return error;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/__budget') {
			let v: Verdict | null = null;
			let error: string | null = null;
			try {
				v = this.verdict();
			} catch (e) {
				error = String((e as Error)?.message ?? e);
			}
			return Response.json({
				instanceType: this.env.VPS_INSTANCE_TYPE ?? null,
				enforcing: enforcing(this.env),
				reserve: reserveFraction(this.env),
				allowance: allowanceFor(this.env),
				runningMs: Number(this.get('accumulatedMs') ?? '0'),
				stopped: this.get('stoppedReason'),
				verdict: v,
				error
			});
		}

		if (url.pathname === '/__container') {
			const c = this.ctx.container;
			return Response.json({
				bound: c !== undefined && c !== null,
				running: c?.running ?? null,
				defaultPort: this.defaultPort
			});
		}

		if (url.pathname === '/__release') {
			// an operator un-parking an arm the guard stopped, which needs the reserve raised first
			// or it stops again on the next request
			this.put('stoppedReason', null);
			return Response.json({ released: true });
		}

		let v: Verdict;
		try {
			v = this.verdict();
		} catch (e) {
			return Response.json(
				{
					error: `budget guard cannot cost this arm: ${String((e as Error)?.message ?? e)}`
				},
				{ status: 503 }
			);
		}

		const alreadyStopped = this.get('stoppedReason');
		if (enforcing(this.env) && (v.over || alreadyStopped)) {
			const reason = alreadyStopped ?? `${v.binding} reached its share of the allowance`;
			this.put('stoppedReason', reason);
			try {
				await this.stop();
			} catch {
				// a stop on an already-stopped instance is not an error worth surfacing; the refusal
				// below is what bounds the spend either way
			}
			return Response.json(
				{ error: 'container budget exhausted', reason, used: v.used, fraction: v.fraction },
				{ status: 429, headers: { 'x-vps-budget': 'exhausted' } }
			);
		}

		// START EXPLICITLY. A freshly deployed application reported `healthy: 1, active: 0` and every
		// request answered 500 `container is not running, consider calling start()`; the base class
		// starts on demand only once an instance is active, so the first request has to ask
		// `super.fetch()` starts the container itself. An explicit `start()` in front of it only
		// replaced the platform's own message ("the container just exited") with a less useful one
		const res = await super.fetch(request);
		const headers = new Headers(res.headers);
		headers.set('x-vps-budget-fraction', v.fraction[v.binding].toFixed(4));
		headers.set('x-vps-budget-binding', v.binding);
		headers.set('x-vps-instance', String(this.env.VPS_INSTANCE_TYPE ?? 'unknown'));
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__health') {
			return Response.json({ ok: true, instanceType: env.VPS_INSTANCE_TYPE ?? null });
		}
		// ONE instance, deliberately. The comparison is against a VPS, and a VPS is one box; fanning
		// this out across instances would measure a different architecture and call it the baseline.
		const id = env.VPS_ARM.idFromName('vps-arm-1');
		return env.VPS_ARM.get(id).fetch(request);
	}
};
