# The Outbox

How mail, outbound HTTP, Redis and the cron firing survive an object reset. The code is
`src/ops/outbox.ts` over folio 1.2.0's `Outbox`; the table and the reasoning are in the Technical
Report section "Outside Effects on the Outbox, 2026-11-23".

## Cloudflare Refuses a Message-ID

Read 2026-11-23 from the Email Service header reference: `Message-ID` is platform-controlled, and
sending it in `headers` fails the whole request with `E_HEADER_NOT_ALLOWED`. Any header outside the
allowlist that does not start with `X-` is refused the same way. So the outbox key is the
`Message-ID` over SMTP only, and `X-Cfw-Outbox-Key` over the API and the `send_email` binding.
Cloudflare does not deduplicate on the X- header, so a reset between the relay accepting a message
and the completion flush can deliver it twice on those two transports.

## What a Reported Row Means

A `report` kind that was running when its lease ended is failed with "policy report" and never run
again. It stays in its table, newest 50 per lane, and `/serve-stats` lists it under
`outboxReported`. Check the far end first (Redis for a counter, nothing for a cron hook), then
`reenqueueReported()` puts the same kind and args under a new id. No owner route calls it yet.

## Not Measured

No deployed object has been reset mid-send. The reset behaviour is read from a crash-model SQL
double (`tests/helpers/crash-sql.ts`, writes since the last flush are dropped) and from successor
states seeded with folio's own `claim()`. The rows cost of the extra writes per outbound fetch (an
outbox insert, a claim, a completion and a delete) is not read on a deployed site.
