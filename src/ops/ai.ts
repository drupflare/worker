/**
 * Workers AI as a QUEUED tier, over the same queue the HTTP and TCP tiers already use.
 *
 * The interpreter cannot await, so an inference call has the same shape every outbound call here
 * has: PHP names the whole operation, the host runs it between invocations, and the answer is read
 * on a later one. `drupal/ai`'s provider interface is synchronous and has no async form, so a
 * provider on this runtime can satisfy it only by having the answer already -- which is this tier's
 * contract exactly.
 *
 * **The `AI` binding, never the REST API.** A REST call to `api.cloudflare.com` needs
 * `Authorization: Bearer` and an account id in the URL, so the account token would have to be
 * readable from the queue row; the binding carries its own authorisation and needs no header.
 *
 * **Neurons are a FOURTH meter.** 10,000/day on free and paid alike, reset at 00:00 UTC, and
 * exhaustion is a hard 429 rather than a bill. Neither of RULE 0b's two ceilings sees it, so it is
 * projected from the model and the workload the way the Images meter is -- see {@link neuronCost}.
 *
 * Degrades to nothing. No binding and every function here refuses with a reason, so the tier can
 * ship before any account has enabled Workers AI.
 */

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

export type AiEnv = {
	/** optional: the tier is absent rather than broken when Workers AI is not enabled */
	AI?: AiBinding | null;
	/** comma-separated allow-list; unset means {@link DEFAULT_AI_MODELS} */
	AI_MODELS?: string | null;
};

/**
 * The models a site may call without configuration.
 *
 * Short and weighted toward embeddings: at 1,075 neurons per 1M input
 * tokens, indexing 1,000 nodes at 500 tokens each is 538 neurons, about 5% of a day. A
 * `llama-3.3-70b` completion is 129 neurons, so the same allocation buys 77 of them. Both are
 * reachable; the docs owe a site owner the difference.
 */
export const DEFAULT_AI_MODELS: readonly string[] = [
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'@cf/google/gemma-4-26b-it',
	'@cf/baai/bge-m3',
	'@cf/qwen/qwen3-embedding-0.6b'
];

/**
 * Published neuron rates, per 1,000,000 tokens, for the models this tier allows.
 *
 * Cloudflare's own figures. A model absent from here is not priced rather than priced at zero, so a
 * projection over an unknown model reports null and a caller cannot mistake silence for free.
 */
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
export function allowedModels(env?: AiEnv | null): readonly string[] {
	const raw = String(env?.AI_MODELS ?? '').trim();
	if (!raw) return DEFAULT_AI_MODELS;
	const named = raw
		.split(',')
		.map((m) => m.trim())
		.filter(Boolean);
	return named.length ? named : DEFAULT_AI_MODELS;
}

/** whether the tier can run at all: a binding, and a model the operator allows */
export function aiEnabled(env?: AiEnv | null): boolean {
	return Boolean(env?.AI);
}

/**
 * Neurons one call costs, projected from the published rate and a token count.
 *
 * PROJECTED, not metered. Cloudflare bills neurons per model per token and does not return the
 * count on the binding's reply, so this is arithmetic over a rate table and an input size. Reported
 * as such by every caller; `null` means the model is not in {@link NEURON_RATES}.
 */
export function neuronCost(
	model: string,
	inputTokens: number,
	outputTokens = 0
): { neurons: number; perDay: number } | null {
	const rate = NEURON_RATES[model];
	if (!rate) return null;
	const neurons =
		(Math.max(0, inputTokens) * rate.input) / 1_000_000 +
		(Math.max(0, outputTokens) * rate.output) / 1_000_000;
	return {
		neurons: Math.round(neurons * 100) / 100,
		perDay: neurons > 0 ? Math.floor(NEURONS_PER_DAY / neurons) : NEURONS_PER_DAY
	};
}

/**
 * The url an inference is queued and keyed under.
 *
 * It names the MODEL and nothing else. The prompt is in the body, which is what `deferredKey()`
 * already keys on, so two prompts to one model are two rows and the same prompt twice is one.
 */
export function aiQueueUrl(model: string): string {
	return `${AI_SCHEME_PREFIX}workers://${encodeURIComponent(model)}`;
}

/** whether a queued row belongs to this tier */
export function isAiUrl(url: string): boolean {
	return url.startsWith(AI_SCHEME_PREFIX);
}

/** the model a queued row runs, or null when the url is not this tier's */
export function aiModelOf(url: string): string | null {
	if (!isAiUrl(url)) return null;
	const rest = url.slice(`${AI_SCHEME_PREFIX}workers://`.length);
	if (!rest) return null;
	try {
		return decodeURIComponent(rest);
	} catch {
		return null;
	}
}

/** an inference reply, flattened to something PHP can `json_decode` */
function replyToJson(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Uint8Array) return Array.from(value);
	if (typeof value === 'bigint') return value.toString();
	return value;
}

/**
 * Runs one queued inference.
 *
 * Never throws for a refusal; a refusal is a status the caller stores like any other, because the
 * drain's attempt budget would otherwise retry a call that can never succeed and spend the neuron
 * meter doing it.
 */
export async function runAiExchange(
	url: string,
	body: string,
	env: AiEnv | null | undefined
): Promise<AiResult> {
	const headers = { 'content-type': 'application/json' };
	const model = aiModelOf(url);
	if (!model) return { status: 400, headers, body: JSON.stringify({ error: 'unroutable url' }) };
	if (!env?.AI) {
		return { status: 503, headers, body: JSON.stringify({ error: 'no AI binding' }) };
	}
	// the allow-list is checked at DRAIN time as well as at queue time: a row outlives the config
	// that queued it, and the meter is spent here rather than there
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
		const message = String((e as { message?: string })?.message ?? e).slice(0, 300);
		// 3036 is the daily neuron cap and 5035 is a model that needs Workers Paid; both are
		// permanent for the rest of the day, so they are reported rather than retried
		const capped = /3036|neuron|429/i.test(message);
		return {
			status: capped ? 429 : 502,
			headers,
			body: JSON.stringify({ model, error: message, meter: capped ? 'neurons' : undefined })
		};
	}
}
