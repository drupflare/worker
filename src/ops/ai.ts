/**
 * Workers AI as a queued tier over the queue the HTTP and TCP tiers use.
 *
 * Queued rather than parked: a generation takes seconds and the neuron meter is a hard 429, so an
 * inline call would fail a page for a quota it did not need. Streaming stays closed (a park
 * delivers one answer). Uses the `AI` binding, never `REST`, so no account token sits in a queue
 * row. Neurons (10,000/day, reset 00:00 UTC) are projected; with no binding every call refuses.
 * @module
 */
import { errorMessage } from '../util/errors';

/** the scheme a queued row carries so the drain routes it here rather than to `fetch()` */
export const AI_SCHEME_PREFIX = 'ai+';

/** what one inference produces, shaped like an HTTP result so the cache table is unchanged */
export interface AiResult {
	status: number;
	headers: Record<string, string>;
	body: string;
}

/** the binding surface this tier uses; narrowed so a spec can supply a plain object */
export type AiBinding = {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

/** the env bindings this tier reads */
export type AiEnv = {
	/** optional: the tier is absent rather than broken when Workers AI is not enabled */
	AI?: AiBinding;
	/** comma-separated allow-list; unset means {@link DEFAULT_AI_MODELS} */
	AI_MODELS?: string;
};

/** models callable without configuration (embeddings: 1,000 nodes at 500 tokens is 538 neurons) */
export const DEFAULT_AI_MODELS: readonly string[] = [
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'@cf/google/gemma-4-26b-it',
	'@cf/baai/bge-m3',
	'@cf/qwen/qwen3-embedding-0.6b'
];

/** published neuron rates per 1M tokens; a model absent here is unpriced, not free */
export const NEURON_RATES: Readonly<
	Record<string, { input: number; output: number; embedding?: boolean }>
> = {
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 26_668, output: 204_805 },
	'@cf/google/gemma-4-26b-it': { input: 9_091, output: 27_273 },
	'@cf/baai/bge-m3': { input: 1_075, output: 0, embedding: true },
	'@cf/qwen/qwen3-embedding-0.6b': { input: 1_075, output: 0, embedding: true }
};

/** the free daily allocation, on Workers Free and Workers Paid alike */
export const NEURONS_PER_DAY = 10_000;

/** models the allow-list accepts, from the env or the default */
export function allowedModels(env?: AiEnv): readonly string[] {
	const raw = String(env?.AI_MODELS ?? '').trim();
	if (!raw) return DEFAULT_AI_MODELS;
	const named = raw
		.split(',')
		.map((m) => m.trim())
		.filter(Boolean);
	return named.length ? named : DEFAULT_AI_MODELS;
}

/** whether the tier can run at all: a binding, and a model the operator allows */
export function aiEnabled(env?: AiEnv): boolean {
	return Boolean(env?.AI);
}

/** neurons one call costs, projected (no count in the reply); undefined for an unpriced model */
export function neuronCost(
	model: string,
	inputTokens: number,
	outputTokens = 0
): { neurons: number; perDay: number } | undefined {
	const rate = NEURON_RATES[model];
	if (!rate) return undefined;
	const neurons =
		(Math.max(0, inputTokens) * rate.input) / 1_000_000 +
		(Math.max(0, outputTokens) * rate.output) / 1_000_000;
	return {
		neurons: Math.round(neurons * 100) / 100,
		perDay: neurons > 0 ? Math.floor(NEURONS_PER_DAY / neurons) : NEURONS_PER_DAY
	};
}

/** the url an inference is queued under; model only (`deferredKey()` keys on the body) */
export function aiQueueUrl(model: string): string {
	return `${AI_SCHEME_PREFIX}workers://${encodeURIComponent(model)}`;
}

/** whether a queued row belongs to this tier */
export function isAiUrl(url: string): boolean {
	return url.startsWith(AI_SCHEME_PREFIX);
}

/** the model a queued row runs, or undefined when the url is not this tier's */
export function aiModelOf(url: string): string | undefined {
	if (!isAiUrl(url)) return undefined;
	const rest = url.slice(`${AI_SCHEME_PREFIX}workers://`.length);
	if (!rest) return undefined;
	try {
		return decodeURIComponent(rest);
	} catch {
		return undefined;
	}
}

/** an inference reply, flattened to something PHP can `json_decode` */
function replyToJson(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Uint8Array) return Array.from(value);
	if (typeof value === 'bigint') return value.toString();
	return value;
}

/** runs one queued inference; a refusal is a stored status, not a throw (retries spend neurons) */
export async function runAiExchange(
	url: string,
	body: string,
	env: AiEnv | undefined
): Promise<AiResult> {
	const headers = { 'content-type': 'application/json' };
	const model = aiModelOf(url);
	if (!model) return { status: 400, headers, body: JSON.stringify({ error: 'unroutable url' }) };
	if (!env?.AI) {
		return { status: 503, headers, body: JSON.stringify({ error: 'no AI binding' }) };
	}
	// checked at drain time too (a row outlives the config that queued it)
	if (!allowedModels(env).includes(model)) {
		return { status: 403, headers, body: JSON.stringify({ error: `model refused: ${model}` }) };
	}

	let input: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(body || '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {
				status: 400,
				headers,
				body: JSON.stringify({ error: 'input is not an object' })
			};
		}
		input = parsed as Record<string, unknown>;
	} catch {
		return { status: 400, headers, body: JSON.stringify({ error: 'input is not json' }) };
	}

	try {
		const reply = await env.AI.run(model, input);
		return {
			status: 200,
			headers,
			body: JSON.stringify({ model, reply: replyToJson(reply) })
		};
	} catch (e: unknown) {
		const message = errorMessage(e).slice(0, 300);
		// 3036 is the daily neuron cap, 5035 a model that needs Workers Paid (no retry today)
		const capped = /3036|neuron|429/i.test(message);
		return {
			status: capped ? 429 : 502,
			headers,
			body: JSON.stringify({ model, error: message, meter: capped ? 'neurons' : undefined })
		};
	}
}
