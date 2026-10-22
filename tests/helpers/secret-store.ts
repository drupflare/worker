import type { SecretStore } from '../../src/ops/site-secrets';

/** an in-memory {@link SecretStore}: `rows` stands for `cfw_meta`, `sealed` for key-value storage */
export type MemorySecretStore = SecretStore & {
	rows: Map<string, string>;
	sealedRows: Map<string, string>;
};

export function memorySecretStore(seed: Record<string, string> = {}): MemorySecretStore {
	const rows = new Map(Object.entries(seed));
	const sealedRows = new Map<string, string>();
	return {
		rows,
		sealedRows,
		get: (key) => rows.get(key) ?? null,
		set: (key, value) => void rows.set(key, value),
		delete: (key) => void rows.delete(key),
		sealed: {
			get: (key) => sealedRows.get(key),
			put: (key, value) => void sealedRows.set(key, value),
			delete: (key) => void sealedRows.delete(key),
			list: (prefix) => [...sealedRows].filter(([key]) => key.startsWith(prefix))
		}
	};
}
