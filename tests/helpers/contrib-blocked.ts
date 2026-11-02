/** modules the generated case names that no census install can satisfy, so absence is expected */
export const BLOCKED_MODULES: readonly string[] = [
	// needs libraries/dropzone, a third-party file composer does not fetch
	'dropzonejs'
];
