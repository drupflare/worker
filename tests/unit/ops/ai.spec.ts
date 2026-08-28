import { describe, expect, it } from 'vitest';
import {
	AI_SCHEME_PREFIX,
	DEFAULT_AI_MODELS,
	NEURONS_PER_DAY,
	NEURON_RATES,
	aiEnabled,
	aiModelOf,
	aiQueueUrl,
	allowedModels,
	isAiUrl,
	neuronCost,
	runAiExchange,
	type AiEnv
} from '../../../src/ops/ai';

const model = DEFAULT_AI_MODELS[0] as string;
const embedModel = '@cf/baai/bge-m3';

function envWith(
	run: (m: string, i: Record<string, unknown>) => Promise<unknown>,
	extra: Partial<AiEnv> = {}
): AiEnv {
	return { AI: { run }, ...extra };
}

describe('the queued Workers AI tier', () => {
	describe('routing', () => {
		it('round-trips a model through the queue url, including one with a slash', () => {
			const url = aiQueueUrl(model);
			expect(url.startsWith(AI_SCHEME_PREFIX)).toBe(true);
			expect(isAiUrl(url)).toBe(true);
			expect(aiModelOf(url)).toBe(model);
		});

		it('claims nothing that belongs to another tier', () => {
			for (const other of ['https://example.com/', 'tcp+redis://host:6379/', '']) {
				expect(isAiUrl(other), other).toBe(false);
				expect(aiModelOf(other), other).toBeNull();
			}
		});

		it('reports the tier absent when no binding is bound', () => {
			expect(aiEnabled(null)).toBe(false);
			expect(aiEnabled({})).toBe(false);
			expect(aiEnabled({ AI: { run: async () => null } })).toBe(true);
		});
	});

	describe('the model allow-list', () => {
		it('falls back to the default for an unset, empty or all-blank value', () => {
			for (const raw of [undefined, '', '   ', ',,,']) {
				expect(allowedModels({ AI_MODELS: raw as string }), String(raw)).toEqual(
					DEFAULT_AI_MODELS
				);
			}
		});

		it('takes the operator list when there is one', () => {
			expect(allowedModels({ AI_MODELS: ' @cf/a , @cf/b ' })).toEqual(['@cf/a', '@cf/b']);
		});

		it('refuses a model at DRAIN time, because a row outlives the config that queued it', async () => {
			let called = false;
			const env = envWith(
				async () => {
					called = true;
					return {};
				},
				{ AI_MODELS: '@cf/only-this' }
			);
			const res = await runAiExchange(aiQueueUrl(model), '{}', env);
			expect(res.status).toBe(403);
			// the meter is spent HERE, so a refused model must not reach the binding at all
			expect(called).toBe(false);
		});
	});

	describe('the neuron projection', () => {
		it('prices a completion and an embedding from the published rates', () => {
			const chat = neuronCost(model, 1_000, 500);
			expect(chat).not.toBeNull();
			// 1,000 in at 26,668/1M plus 500 out at 204,805/1M
			expect(chat?.neurons).toBeCloseTo(26.668 + 102.4025, 2);
			expect(chat?.perDay).toBe(Math.floor(NEURONS_PER_DAY / (chat?.neurons as number)));

			const embed = neuronCost(embedModel, 500_000, 0);
			expect(embed?.neurons).toBeCloseTo(537.5, 1);
			// 1,000 nodes at 500 tokens is about 5% of a day, which is what makes this half affordable
			expect((embed?.neurons as number) / NEURONS_PER_DAY).toBeLessThan(0.06);
		});

		it('returns null for a model it has no rate for, so silence is never read as free', () => {
			expect(neuronCost('@cf/unpriced/model', 1_000, 500)).toBeNull();
		});

		it('has a rate for every model on the default allow-list', () => {
			for (const m of DEFAULT_AI_MODELS) expect(NEURON_RATES[m], m).toBeDefined();
		});

		it('never charges for negative tokens', () => {
			expect(neuronCost(model, -100, -100)?.neurons).toBe(0);
		});
	});

	describe('running one exchange', () => {
		it('passes the parsed input straight to the binding and wraps the reply', async () => {
			let seen: [string, Record<string, unknown>] | null = null;
			const env = envWith(async (m, i) => {
				seen = [m, i];
				return { response: 'hello' };
			});
			const res = await runAiExchange(aiQueueUrl(model), '{"prompt":"hi"}', env);
			expect(res.status).toBe(200);
			expect(seen).toEqual([model, { prompt: 'hi' }]);
			expect(JSON.parse(res.body)).toEqual({ model, reply: { response: 'hello' } });
		});

		it('refuses with a status rather than throwing, so the drain does not retry it', async () => {
			const cases: Array<[string, string, AiEnv]> = [
				['no binding', '{}', {}],
				['not json', 'not json', envWith(async () => ({}))],
				['not an object', '[1,2]', envWith(async () => ({}))]
			];
			for (const [name, body, env] of cases) {
				const res = await runAiExchange(aiQueueUrl(model), body, env);
				expect(res.status, name).toBeGreaterThanOrEqual(400);
				expect(() => JSON.parse(res.body), name).not.toThrow();
				expect(JSON.parse(res.body).error, name).toBeTruthy();
			}
		});

		it('refuses an unroutable url', async () => {
			const res = await runAiExchange(
				'https://example.com/',
				'{}',
				envWith(async () => ({}))
			);
			expect(res.status).toBe(400);
		});

		it('separates the neuron cap from an ordinary upstream failure', async () => {
			const capped = await runAiExchange(
				aiQueueUrl(model),
				'{}',
				envWith(async () => {
					throw new Error('code 3036: daily neuron limit exceeded');
				})
			);
			expect(capped.status).toBe(429);
			expect(JSON.parse(capped.body).meter).toBe('neurons');

			const other = await runAiExchange(
				aiQueueUrl(model),
				'{}',
				envWith(async () => {
					throw new Error('upstream exploded');
				})
			);
			expect(other.status).toBe(502);
			expect(JSON.parse(other.body).meter).toBeUndefined();
		});

		it('flattens a byte-array reply so PHP can json_decode it', async () => {
			const res = await runAiExchange(
				aiQueueUrl(embedModel),
				'{"text":["a"]}',
				envWith(async () => new Uint8Array([1, 2, 3]))
			);
			expect(JSON.parse(res.body).reply).toEqual([1, 2, 3]);
		});
	});
});
