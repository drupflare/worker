/** the longest the clock PHP reads may run ahead of the platform's, in milliseconds */
export const MAX_AHEAD_MS = 60_000;

/** the least a read advances the clock by, so a loop that waits for it to move finishes */
export const READ_STEP_MS = 0.001;

/**
 * Milliseconds of PHP time charged for one call across the host boundary.
 *
 * The median of real elapsed time over counted calls for nine warm Drupal renders on a local
 * workerd (range 0.085 to 0.164); a deployed reading owes a recalibration.
 */
export const DEFAULT_KAPPA_MS = 0.13;

/**
 * `virtual` advances PHP's clock with work, `frozen` holds it still for a run the way the platform
 * does, and `simulated` is the virtual clock over a platform clock that is held still.
 */
export type ClockMode = 'off' | 'virtual' | 'frozen' | 'simulated';

/** reads `VIRTUAL_CLOCK`; unset is the virtual clock, and anything unrecognised is off */
export function clockMode(raw: string | undefined): ClockMode {
	const v = (raw ?? '').trim().toLowerCase();
	if (v === '' || v === '1' || v === 'true' || v === 'on' || v === 'virtual') return 'virtual';
	if (v === 'frozen' || v === 'simulated') return v;
	return 'off';
}

/** reads `VIRTUAL_CLOCK_KAPPA_MS`; a missing or non-positive value is the default */
export function clockKappa(raw: string | undefined): number {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_KAPPA_MS;
}

/** what a clock needs to be built */
export type PhpClockOptions = {
	mode: Exclude<ClockMode, 'off'>;
	/** milliseconds charged per host call */
	kappaMs?: number;
	/** the cap on how far ahead of the platform the clock may read */
	maxAheadMs?: number;
	/** the platform's epoch clock, replaceable so a spec can drive it */
	dateNow?: () => number;
	/** the platform's monotonic clock, replaceable so a spec can drive it */
	perfNow?: () => number;
	/** whether a site's vars named the clock, which makes a glue with no time import an error */
	explicit?: boolean;
};

/**
 * The clock PHP reads.
 *
 * The platform advances `Date.now()` and `performance.now()` only at I/O, so inside one synchronous
 * run they hold still and every loop bounded by time never ends. This clock returns
 * `max(real, base + calls * kappa, last + step)`, capped at `real + maxAhead`, and takes a new base
 * from the real clock at every run start. A read never goes back inside a run; across runs the clock
 * returns to the platform's, which steps it back only by the amount the last run overshot.
 */
export class PhpClock {
	/** host calls counted since the run began */
	calls = 0;
	/** host calls counted since the clock was built */
	total = 0;
	/** how the clock behaves */
	readonly mode: Exclude<ClockMode, 'off'>;
	/** whether a site's vars named the clock rather than taking the default */
	readonly explicit: boolean;
	/** milliseconds charged per host call */
	private readonly kappa: number;
	/** the cap on how far ahead of the platform a read may run */
	private readonly maxAhead: number;
	/** the platform's epoch clock */
	private readonly dateNow: () => number;
	/** the platform's monotonic clock */
	private readonly perfNow: () => number;
	/** the epoch clock when the run began */
	private baseDate = 0;
	/** the monotonic clock when the run began */
	private basePerf = 0;
	/** the last epoch value handed out, so a read never goes back */
	private lastDate = 0;
	/** the last monotonic value handed out, so a read never goes back */
	private lastPerf = 0;

	constructor(opts: PhpClockOptions) {
		this.mode = opts.mode;
		this.explicit = opts.explicit ?? true;
		this.kappa = opts.kappaMs ?? DEFAULT_KAPPA_MS;
		this.maxAhead = opts.maxAheadMs ?? MAX_AHEAD_MS;
		this.dateNow = opts.dateNow ?? (() => Date.now());
		this.perfNow = opts.perfNow ?? (() => performance.now());
		this.resync();
	}

	/** the milliseconds of PHP time the host calls of the current or last run stand for */
	runMs(): number {
		return this.calls * this.kappa;
	}

	/** takes the platform's clocks as the new base; called when a run starts */
	resync(): void {
		this.calls = 0;
		this.baseDate = this.dateNow();
		this.basePerf = this.perfNow();
		// not carried over: a lead from the last run would swallow this run's work, and the platform
		// clock has caught up with real time by the time the next run starts
		this.lastDate = this.baseDate;
		this.lastPerf = this.basePerf;
	}

	/** counts one host call */
	count(): void {
		this.calls++;
		this.total++;
	}

	/** how far ahead of the platform's epoch clock the last read ran, in milliseconds */
	get aheadMs(): number {
		return Math.max(0, this.lastDate - this.realDate());
	}

	/** epoch milliseconds, the import behind `time()`, `gettimeofday()` and `microtime()` */
	date(): number {
		if (this.mode === 'frozen') return this.baseDate;
		this.lastDate = this.read(this.realDate(), this.baseDate, this.lastDate);
		return this.lastDate;
	}

	/** monotonic milliseconds, the import behind `hrtime()` and `CLOCK_MONOTONIC` */
	perf(): number {
		if (this.mode === 'frozen') return this.basePerf;
		this.lastPerf = this.read(this.realPerf(), this.basePerf, this.lastPerf);
		return this.lastPerf;
	}

	/** the platform's epoch clock, or its value at run start when the platform is simulated */
	private realDate(): number {
		return this.mode === 'simulated' ? this.baseDate : this.dateNow();
	}

	/** the platform's monotonic clock, or its value at run start when the platform is simulated */
	private realPerf(): number {
		return this.mode === 'simulated' ? this.basePerf : this.perfNow();
	}

	/** the clock's rule for one read */
	private read(real: number, base: number, last: number): number {
		const wanted = Math.max(real, base + this.calls * this.kappa, last + READ_STEP_MS);
		return Math.min(wanted, Math.max(real + this.maxAhead, last));
	}
}

/** the clock a site's vars ask for, or undefined when `VIRTUAL_CLOCK` is off */
export function clockFor(
	env: { VIRTUAL_CLOCK?: string; VIRTUAL_CLOCK_KAPPA_MS?: string } | undefined
): PhpClock | undefined {
	const mode = clockMode(env?.VIRTUAL_CLOCK);
	return mode === 'off'
		? undefined
		: new PhpClock({
				mode,
				kappaMs: clockKappa(env?.VIRTUAL_CLOCK_KAPPA_MS),
				explicit: (env?.VIRTUAL_CLOCK ?? '').trim() !== ''
			});
}

/** the glue's host-call imports; each is counted as work when the clock is on */
const COUNTED = /^(emscripten_asm_const_.*|__asyncjs__.*|__syscall_.*|fd_(read|write|seek))$/;

/**
 * Replaces the glue's time imports with the clock's and wraps the host-call imports to count.
 *
 * Emscripten hands the same object to `env` and `wasi_snapshot_preview1`, so each distinct object
 * is walked once.
 */
export function installClock(imports: WebAssembly.Imports, clock: PhpClock): void {
	const seen = new Set<object>();
	let replaced = false;
	for (const ns of Object.values(imports)) {
		if (seen.has(ns)) continue;
		seen.add(ns);
		const table = ns as Record<string, unknown>;
		if (typeof table.emscripten_date_now === 'function') {
			table.emscripten_date_now = () => clock.date();
			replaced = true;
		}
		if (typeof table.emscripten_get_now === 'function') {
			table.emscripten_get_now = () => clock.perf();
		}
		for (const name of Object.keys(table)) {
			const fn = table[name];
			if (typeof fn !== 'function' || !COUNTED.test(name)) continue;
			table[name] = (...args: unknown[]) => {
				clock.count();
				return (fn as (...a: unknown[]) => unknown)(...args);
			};
		}
	}
	// a glue that renamed the import would otherwise run with the flag on and the clock unchanged;
	// the default clock is not an error on a binary that has no such import
	if (!replaced && clock.explicit)
		throw new Error('VIRTUAL_CLOCK is on but the glue imports no emscripten_date_now');
}
