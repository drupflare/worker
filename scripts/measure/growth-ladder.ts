import { spawnSync } from 'node:child_process';
import { emitVariant, growthLadder } from './growth-glue.js';

/**
 * Run the heap profile at several growth steps and report what the step actually buys.
 *
 * `bun scripts/measure/growth-ladder.ts 0.2 0.1 0.05 0.01 0`
 *
 * ONE BINARY, N GLUE VARIANTS. The growth policy is emitted into `_emscripten_resize_heap` as
 * JavaScript, so an arm is a file rewrite rather than a phasm rebuild -- which is why this is a
 * script and not a backlog item waiting on a toolchain session.
 *
 * READ THE STEP-0 ARM FIRST. There the heap stops being a geometric series and becomes live demand
 * rounded to a 64 KiB page, so `peak(0)` is the measurement and every other arm's peak minus that is
 * over-reservation. The step is a CPU/peak trade and this script scores only the peak; growth
 * overhead is a duration cost and RULE 0 forbids reading it off a local clock.
 */

const MIB = 1_048_576;
const SPEC = 'tests/integration/heap-growth.spec.ts';

type Arm = { step: number; bootedIdle: number; peak: number; installPeak: number };

function readMarker(haystack: string[], marker: string, step: number): Record<string, number> {
	const line = haystack.find((l) => l.includes(marker));
	if (!line) {
		throw new Error(
			`step ${step}: no ${marker} line in ${haystack.length} captured lines; ` +
				`the arm did not run.\nlast 20:\n${haystack.slice(-20).join('\n')}`
		);
	}
	return JSON.parse(line.slice(line.indexOf('{')));
}

function runArm(step: number): Arm {
	emitVariant(step);
	// pool-workers buffers console output from inside the isolate, so the profile line never
	// reaches stdout without this; a run with it missing throws rather than reporting no arms
	const args = ['vitest', 'run', '--project=workers', SPEC, '--disable-console-intercept'];
	const proc = spawnSync('bunx', args, {
		encoding: 'utf8',
		env: { ...process.env, DRUPFLARE_GROWTH_STEP: String(step) },
		maxBuffer: 64 * 1024 * 1024
	});

	const lines = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.split('\n');
	const render = readMarker(lines, '[heap-profile]', step);
	const install = readMarker(lines, '[heap-profile-install]', step);
	return {
		step,
		bootedIdle: render.bootedIdle!,
		peak: render.afterFirstRender!,
		installPeak: install.peak!
	};
}

const mib = (bytes: number) => (bytes / MIB).toFixed(2);

const steps = process.argv.slice(2).map(Number);
if (!steps.length || steps.some((s) => !Number.isFinite(s) || s < 0)) {
	console.error('usage: bun scripts/measure/growth-ladder.ts <step> [step ...]');
	process.exit(1);
}

const arms: Arm[] = [];
for (const step of steps) {
	const arm = runArm(step);
	arms.push(arm);
	console.log(
		`  step ${arm.step}: idle ${arm.bootedIdle}, render peak ${arm.peak} ` +
			`(${mib(arm.peak)} MiB), install peak ${arm.installPeak} (${mib(arm.installPeak)} MiB)`
	);
}

// the step-0 arm is demand; without it there is nothing to difference against and the table would
// be a list of peaks rather than a measurement of over-reservation
const demand = arms.find((a) => a.step === 0)?.peak ?? null;

console.log(
	'\n| step | render peak | render MiB | over-reservation | install peak MiB | headroom to 128 MiB |'
);
console.log(
	'| ---- | ----------- | ---------- | ---------------- | ---------------- | ------------------- |'
);
for (const arm of arms) {
	const over = demand === null ? 'n/a' : `${arm.peak - demand} (${mib(arm.peak - demand)} MiB)`;
	// headroom is scored against the INSTALL peak, the higher of the two; scoring it against a
	// render would report room an install has already spent
	const worst = Math.max(arm.peak, arm.installPeak);
	console.log(
		`| ${arm.step} | ${arm.peak} | ${mib(arm.peak)} | ${over} | ` +
			`${mib(arm.installPeak)} | ${mib(128 * MIB - worst)} MiB |`
	);
}

// On the RENDER arm a smaller step must never produce a larger peak, because every arm grows from
// the same `INITIAL_MEMORY` to the same demand in one step. A violation there means the variant did
// not take effect and the whole table is the control measured N times.
const sorted = [...arms].sort((a, b) => a.step - b.step);
for (let i = 1; i < sorted.length; i++) {
	const [lo, hi] = [sorted[i - 1]!, sorted[i]!];
	if (lo.peak > hi.peak) {
		console.error(`\nMONOTONICITY BROKEN on render: step ${lo.step} peaked ABOVE ${hi.step}.`);
		process.exit(1);
	}
}

// The INSTALL arm is a different matter and is REPORTED rather than enforced. Growth compounds from
// the previous size, so a finer step can take more steps and land on a worse rung for the same
// demand -- measured, 0.1 peaks HIGHER than the shipping 0.2. That is a property of the workload,
// not a broken arm, and it is the reason a step must never be chosen on a render alone.
const installAnomalies = sorted
	.slice(1)
	.filter((hi, i) => sorted[i]!.installPeak > hi.installPeak)
	.map((hi, i) => `${sorted[i]!.step} > ${hi.step}`);
if (installAnomalies.length) {
	console.log(
		`\nnon-monotonic on INSTALL (expected, path-dependent): ${installAnomalies.join(', ')}`
	);
}

const best = [...arms].sort(
	(a, b) => Math.max(a.peak, a.installPeak) - Math.max(b.peak, b.installPeak)
)[0]!;
console.log(
	`lowest worst-case peak: step ${best.step} at ${Math.max(best.peak, best.installPeak)} bytes`
);

if (demand !== null) {
	const shipping = arms.find((a) => a.step === 0.2);
	console.log(`\nlive demand at the peak: <= ${demand} bytes (${mib(demand)} MiB)`);
	if (shipping) {
		console.log(
			`shipping over-reservation: ${shipping.peak - demand} bytes ` +
				`(${mib(shipping.peak - demand)} MiB), ` +
				`${((100 * (shipping.peak - demand)) / shipping.peak).toFixed(1)}% of the peak`
		);
		console.log(
			`emscripten would try, at the next growth from the shipping peak: ` +
				growthLadder(shipping.peak, shipping.peak + 1, 0.2).join(', ')
		);
	}
}
