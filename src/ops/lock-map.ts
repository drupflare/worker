/** name -> version, from a composer.lock's `packages` array */
export function lockVersions(lock: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const packages = (lock as { packages?: unknown })?.packages;
	if (!Array.isArray(packages)) return out;
	for (const entry of packages) {
		const name = (entry as { name?: unknown })?.name;
		const version = (entry as { version?: unknown })?.version;
		if (typeof name === 'string' && typeof version === 'string') out[name] = version;
	}
	return out;
}

/**
 * Virtual package name -> the version a locked package provides it at, from `provide` and
 * `replace` (`psr/log-implementation` is met by `symfony/console`, so nothing is fetched). `ext-*`
 * and `lib-*` stay out; `self.version` resolves to the replacing package's own version.
 */
export function lockProvides(lock: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const packages = (lock as { packages?: unknown })?.packages;
	if (!Array.isArray(packages)) return out;
	for (const entry of packages) {
		const { name, version } = entry as { name?: unknown; version?: unknown };
		if (typeof name !== 'string' || typeof version !== 'string') continue;
		for (const key of ['provide', 'replace'] as const) {
			const declared = (entry as Record<string, unknown>)[key];
			if (declared === null || typeof declared !== 'object') continue;
			for (const [virtual, at] of Object.entries(declared as Record<string, unknown>)) {
				if (!virtual.includes('/') || typeof at !== 'string') continue;
				const value = at === 'self.version' ? version : at;
				out[virtual] = out[virtual] === undefined ? value : `${out[virtual]}|${value}`;
			}
		}
	}
	return out;
}
