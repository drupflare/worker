# Workers AI

Inference is a queued tier over the same queue as outbound HTTP and TCP. A model call is declared,
run between PHP invocations, and read on a later one. `src/ops/ai.ts` runs it.

| binding or var | default        | what it does                                          |
| -------------- | -------------- | ----------------------------------------------------- |
| `AI`           | none           | the Workers AI binding; the tier is absent without it |
| `AI_MODELS`    | four model ids | comma-separated allow-list of model ids               |

The tier uses the binding. A REST call to `api.cloudflare.com` needs an `Authorization: Bearer`
header and the account id in its URL, which would put the account token in a queue row; the binding
carries its own authorisation.

Neurons are a fourth meter. 10,000 per day on Workers Free and Workers Paid alike, reset at
00:00 UTC, and exhaustion arrives as HTTP 429 with error 3036, never as a bill. Neither the serving
ceiling nor the regeneration ceiling sees it. `/ai` reports a projected cost per call, derived from
Cloudflare's published per-model rate and an approximate token count; the binding returns no metered
figure, so the projection is arithmetic and is labelled as such.

Measured on a deployed free-plan site: a `llama-3.3-70b` completion projects to 102.62 neurons, which
is **97 completions a day**. A `bge-m3` embedding of a short text projects to 0.01, and indexing 1,000
nodes at 500 tokens each is about 5% of one day. Embedding-backed search fits the free allocation;
chat completion overruns it.

## Two Catalogues

Cloudflare publishes two model lists and the difference matters to a site owner.

| catalogue                         | what it is                                                           |
| --------------------------------- | -------------------------------------------------------------------- |
| Workers AI, `/workers-ai/models/` | every entry Cloudflare-hosted; inference runs on Cloudflare hardware |
| unified AI catalog, `/ai/models/` | the above plus third-party models reached through AI Gateway         |

The extra entries on the unified catalogue are external providers (OpenAI, Anthropic, Google, xAI)
reached over AI Gateway and billed through it. A prompt sent to one leaves Cloudflare.

`Partner` is a separate axis. A Partner model on the Workers AI catalogue has proprietary weights and
still runs on Cloudflare hardware: Deepgram, Leonardo, Black Forest Labs and NVIDIA all appear there.
The privacy line runs between Cloudflare-hosted and external provider, and open-weight against
partner is a different line entirely.

`AI_MODELS` is the control. Its default list is Cloudflare-hosted only.

## What This Tier Does Not Do

**No inline AI in a render.** A block or field formatter calling a provider during a page render
holds the object across the round trip, which makes it ineligible for hibernation and bills as wall
clock. The surfaces this tier fits are the ones that already retry and already show progress:
generation on save, moderation, alt text, summarisation, and embedding on the cron path.

No streaming. The unit this queue carries is a finished response body.
