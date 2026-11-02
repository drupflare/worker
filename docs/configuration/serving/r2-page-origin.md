# R2 Page Origin Caching

Mirroring pages to R2 moves them off the Worker, and an R2 public bucket on a custom domain serves
them. How much of that traffic Cloudflare's CDN absorbs in front of the bucket decides whether the
off-Worker lever is worth anything: an absorbed read costs neither a Worker request nor an R2 Class B
operation.

Absorption is 0 without a Cache Rule and about 7/8 with one. Measured with GET against
a cold object each time:

| Condition                   | Result                   |
| --------------------------- | ------------------------ |
| Cache Rule on, cold object  | MISS, then 7 / 7 HIT     |
| Cache Rule off, cold object | MISS, then 7 / 7 DYNAMIC |

A second object under the same rule read 1 MISS, 7 HIT and 2 DYNAMIC across 10 requests, which is the
same picture with two requests landing at a PoP that had not filled yet.

**Measure with GET, never `curl -I`.** HEAD is what `curl -I` sends, Cloudflare does not populate its
cache from a HEAD, and every reading comes back `DYNAMIC`.

## The Cache Rule

One rule, scoped to the CDN hostname and nothing else:

```text
expression:        (http.host eq "drupflare-cdn.example.com")
action:            set_cache_settings
action_parameters: { "cache": true, "edge_ttl": { "mode": "override_origin", "default": 3600 } }
```

In the dashboard it is Caching > Cache Rules > Create rule, with the hostname as the only
condition and "Eligible for cache" plus an edge TTL override. Over the API it is
`PUT /zones/{ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint`.

**A PUT to an entrypoint replaces every rule in it.** Read the entrypoint first and merge; on a zone
that has never had a cache-phase ruleset the entrypoint does not exist yet and creating it destroys
nothing.

One zone-scoped permission creates it: `Zone > Cache Rules > Edit`. Cloudflare's documentation
also lists the account-scoped `Account Rulesets: Edit` and `Account Filter Lists: Edit`. This rule
shape needs neither.

## Smart Tiered Cache

Every PoP fills independently, so a request reaching a cold PoP is a MISS and an R2 Class B read.
Tiering routes a PoP miss through an upper tier instead of to the bucket, which changes absorption
from per-PoP to hierarchical.

Enable it at Caching > Tiered Cache, or with the API:

<details>
<summary>Tiered Cache API command</summary>

```sh
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/tiered_cache_smart_topology_enable" \
  --request PATCH \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{ "value": "on" }'
```

</details>

The token needs `Zone Settings Write` or `Zone Write`. Tiered Cache and Smart Topology are both
available on the Free plan; Generic Global, Regional and Custom topologies are Enterprise only.
Cloudflare selects the upper tier automatically for a zone using R2 as an origin.

## Absorption in the Model

`cdnAbsorption` in `scripts/measure/free-envelope.ts` defaults to 0.

Absorption follows the traffic. It depends on reads per colo per TTL window, so a site with few views
spread over many PoPs absorbs almost nothing, and the same site at high traffic absorbs nearly
everything. Zero is the floor for a low-traffic site and for any site with no rule.

`cdnAbsorption` is a code-level option. The command line takes `--visits`, `--dynamic` and `--warmth`
only; absorption is passed to `envelope()`, `optimalOffWorker()` and `scoreWorkload()` in
`scripts/measure/free-envelope.ts`.

Drupflare does not create the Cache Rule. It changes a zone the operator owns, and the model's default
stays at 0 until an operator applies the rule.
