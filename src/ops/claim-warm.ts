export type ClaimWarmStep = 'entity' | 'typed' | 'plugins' | 'router';
export type ClaimWarmUnit = { step: ClaimWarmStep; plugins?: string[] };

type WarmState = { version: 1; context: string; next: number; units: ClaimWarmUnit[] };

export type ClaimWarmDeps = {
	context: string;
	read(): string | null;
	write(value: string): void;
	run(step: 'plan' | ClaimWarmStep, plugins: string[]): Promise<Record<string, unknown>>;
};

const STEPS: string[] = ['entity', 'typed', 'plugins', 'router'];
const PLUGINS_PER_UNIT = 4;
const CURSOR_LIMIT = 65_536;

/** one call of the claim's warm phase: plans the cursor on the first call, then runs one unit per call */
export async function claimWarmStep(deps: ClaimWarmDeps): Promise<Record<string, unknown>> {
	const stored = readCursor(deps);
	if (!stored) {
		const plan = await deps.run('plan', []);
		if (plan.ok !== true) return { ...plan, complete: false };
		const plugins = pluginNames(plan.plugins);
		const units: ClaimWarmUnit[] = [{ step: 'entity' }, { step: 'typed' }];
		for (let i = 0; i < plugins.length; i += PLUGINS_PER_UNIT) {
			units.push({ step: 'plugins', plugins: plugins.slice(i, i + PLUGINS_PER_UNIT) });
		}
		units.push({ step: 'router' });
		const encoded = JSON.stringify({ version: 1, context: deps.context, next: 0, units });
		if (encoded.length > CURSOR_LIMIT) throw new Error('claim warm plan exceeds cursor credit');
		deps.write(encoded);
		return { ok: true, complete: false, completed: 1, total: units.length + 1 };
	}
	const total = stored.units.length + 1;
	if (stored.next === stored.units.length) {
		return { ok: true, complete: true, completed: total, total };
	}
	const unit = stored.units[stored.next]!;
	const result = await deps.run(unit.step, unit.plugins ?? []);
	if (result.ok !== true) return { ...result, complete: false };
	stored.next++;
	deps.write(JSON.stringify(stored));
	return {
		ok: true,
		complete: stored.next === stored.units.length,
		completed: stored.next + 1,
		total
	};
}

/** the cursor for this context, or undefined when none is stored or it belongs to another one */
function readCursor(deps: ClaimWarmDeps): WarmState | undefined {
	const text = deps.read();
	if (text === null) return undefined;
	const parsed = JSON.parse(text) as WarmState;
	if (
		parsed.version !== 1 ||
		typeof parsed.context !== 'string' ||
		!Array.isArray(parsed.units) ||
		!Number.isSafeInteger(parsed.next) ||
		parsed.next < 0 ||
		parsed.next > parsed.units.length ||
		parsed.units.some((unit) => !validUnit(unit))
	) {
		throw new Error('invalid claim warm cursor');
	}
	return parsed.context === deps.context ? parsed : undefined;
}

function validUnit(unit: ClaimWarmUnit): boolean {
	if (!unit || !STEPS.includes(unit.step)) return false;
	if (unit.step !== 'plugins') return true;
	return (
		Array.isArray(unit.plugins) &&
		unit.plugins.length <= PLUGINS_PER_UNIT &&
		unit.plugins.every(isPluginName)
	);
}

function pluginNames(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every(isPluginName)) {
		throw new Error('invalid plugin warm plan');
	}
	return [...new Set<string>(value)];
}

function isPluginName(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith('plugin.manager.');
}
