/**
 * What a Cloudflare Container arm has spent, and whether it must stop.
 *
 * Pure arithmetic, deliberately separated from the Worker that enforces it. A guard that decides
 * when to stop spending someone else's money is the kind of thing that has to be falsifiable
 * without deploying anything, and `tests/node/container-budget.spec.ts` is where it is falsified.
 *
 * THREE METERS, AND THEY DO NOT BILL ALIKE. Cloudflare bills memory and disk on the resources
 * PROVISIONED for the instance type, for as long as the instance is awake; CPU bills on ACTIVE
 * usage only. So memory and disk are a function of wall time and are exact here, while the CPU
 * figure below is an UPPER BOUND -- it charges every running millisecond as though the vCPU were
 * saturated. That asymmetry is deliberate: a guard that under-counts is worse than useless.
 */

export type InstanceSpec = {
	vcpu: number;
	memoryMib: number;
	diskMb: number;
};

/** the published predefined instance types */
export const INSTANCE_TYPES: Record<string, InstanceSpec> = {
	lite: { vcpu: 1 / 16, memoryMib: 256, diskMb: 2000 },
	basic: { vcpu: 1 / 4, memoryMib: 1024, diskMb: 4000 },
	'standard-1': { vcpu: 1 / 2, memoryMib: 4096, diskMb: 8000 },
	'standard-2': { vcpu: 1, memoryMib: 6144, diskMb: 12000 },
	'standard-3': { vcpu: 2, memoryMib: 8192, diskMb: 16000 },
	'standard-4': { vcpu: 4, memoryMib: 12288, diskMb: 20000 }
};

export type Allowance = {
	memoryGibHours: number;
	vcpuMinutes: number;
	diskGbHours: number;
};

/**
 * The Workers Paid plan's INCLUDED monthly allowance.
 *
 * Past it a run bills the account rather than failing, which is exactly why this is the default
 * ceiling rather than a suggestion: the meter has no natural stopping point of its own.
 */
export const INCLUDED_ALLOWANCE: Allowance = {
	memoryGibHours: 25,
	vcpuMinutes: 375,
	diskGbHours: 200
};

export type Spend = {
	memoryGibHours: number;
	vcpuMinutes: number;
	diskGbHours: number;
};

export function resolveInstance(name: string): InstanceSpec {
	const spec = INSTANCE_TYPES[name];
	if (!spec) {
		throw new Error(
			`unknown instance type ${name}; expected one of ${Object.keys(INSTANCE_TYPES).join(', ')}`
		);
	}
	return spec;
}

/**
 * What `runningMs` of wall time on `spec` has cost.
 *
 * `vcpuMinutes` is the worst case rather than a reading -- see the note at the top of this file.
 */
export function spend(spec: InstanceSpec, runningMs: number): Spend {
	const hours = Math.max(0, runningMs) / 3_600_000;
	const minutes = Math.max(0, runningMs) / 60_000;
	return {
		memoryGibHours: (spec.memoryMib / 1024) * hours,
		vcpuMinutes: spec.vcpu * minutes,
		diskGbHours: (spec.diskMb / 1000) * hours
	};
}

export type Verdict = {
	/** the arm must stop: at least one meter has reached its share of the allowance */
	over: boolean;
	/** the meter closest to its limit, which is the one worth reporting */
	binding: keyof Spend;
	used: Spend;
	/** used / (allowance * reserve), so 1.0 is the stop line rather than the bill */
	fraction: Record<keyof Spend, number>;
	/** wall time still available on the binding meter, negative once over */
	remainingMs: number;
};

/**
 * Whether an arm that has run for `runningMs` may keep running.
 *
 * `reserve` is the share of the allowance this rig is permitted, defaulting to half. The allowance
 * is MONTHLY AND ACCOUNT-WIDE while this guard can only see its own container, so spending all of
 * it would be correct arithmetic about the wrong quantity -- anything else on the account using
 * Containers is invisible here. Half leaves room for that and is still far more than a measurement
 * needs.
 */
export function budgetVerdict(
	spec: InstanceSpec,
	runningMs: number,
	allowance: Allowance = INCLUDED_ALLOWANCE,
	reserve = 0.5
): Verdict {
	const used = spend(spec, runningMs);
	const ceiling: Spend = {
		memoryGibHours: allowance.memoryGibHours * reserve,
		vcpuMinutes: allowance.vcpuMinutes * reserve,
		diskGbHours: allowance.diskGbHours * reserve
	};
	const fraction: Record<keyof Spend, number> = {
		memoryGibHours:
			ceiling.memoryGibHours > 0 ? used.memoryGibHours / ceiling.memoryGibHours : 0,
		vcpuMinutes: ceiling.vcpuMinutes > 0 ? used.vcpuMinutes / ceiling.vcpuMinutes : 0,
		diskGbHours: ceiling.diskGbHours > 0 ? used.diskGbHours / ceiling.diskGbHours : 0
	};
	const keys = Object.keys(fraction) as (keyof Spend)[];
	const binding = keys.reduce((a, b) => (fraction[b] > fraction[a] ? b : a));

	// wall time to the stop line on whichever meter binds; every meter is linear in running time,
	// so this needs no search
	const perMs = spend(spec, 1);
	const headroom = keys.map((k) =>
		perMs[k] > 0 ? (ceiling[k] - used[k]) / perMs[k] : Number.POSITIVE_INFINITY
	);

	return {
		over: fraction[binding] >= 1,
		binding,
		used,
		fraction,
		remainingMs: Math.min(...headroom)
	};
}

/** the wall time `spec` may run before the first meter reaches its share of the allowance */
export function budgetedRuntimeMs(
	spec: InstanceSpec,
	allowance: Allowance = INCLUDED_ALLOWANCE,
	reserve = 0.5
): number {
	return budgetVerdict(spec, 0, allowance, reserve).remainingMs;
}
