# Outbound TCP

Drupal reaches TCP through `Drupal\drupflare\Network\CfwTcp`, which declares a whole exchange and
reads the answer on a later invocation. `src/ops/tcp.ts` runs it between PHP invocations, over
[edgeport](https://github.com/gmitch215/edgeport). It shares the deferred HTTP tier's queue, cache
and retry budget.

| var               | default  | what it does                                            |
| ----------------- | -------- | ------------------------------------------------------- |
| `REDIS_URL`       | none     | `redis://user:pass@host:6379/0`, or `rediss://` for TLS |
| `SYSLOG_URL`      | none     | `syslog://collector:514`, or `syslogs://` for RFC 5425  |
| `SYSLOG_APP_NAME` | `drupal` | APP-NAME on every record this site ships                |

Both carry credentials, so both are secrets and neither is a `vars` entry, and neither can be set
from KV. A KV writer who could set `REDIS_URL` would receive whatever the site writes to it.

The endpoint belongs to the deployment, and never to the caller. Module code names a protocol and
an operation; the host supplies the host, port and credentials. Arbitrary `host:port` TCP behind any
code that can call a host function would be a port scanner and a protocol-smuggling surface.
Administrative Redis commands (`FLUSHALL`, `CONFIG`, `EVAL`, `SCRIPT`, `SHUTDOWN` and the rest of the
list in `src/ops/tcp.ts`) are refused before anything is dialled.

**A Redis cache backend cannot be built on this tier**, and it is served by a second one. A cache get
has to answer inside the request that asked, and a deferred exchange always misses the first time.
What this tier reaches is the deferrable half: a publish, a counter, a write nobody blocks on, or a
read a later request can use.

`syslog` is the shape this tier serves without compromise, because syslog over TCP never replies.

## The Parked Tier

`drupal/redis` works unmodified, over a second mechanism. A trapped socket call freezes PHP where it
stands, the Worker performs the exchange, and the call returns with the answer inside the same
request. Predis speaks RESP over `stream_socket_client`, and that is the shape the park suspends
under.

It arms only when `REDIS_URL` is set, and it dials that endpoint and no other: the host and port the
module asks for are checked for shape and then discarded, so a module that can build a string cannot
choose a destination. A request naming a port other than the configured one is refused. Any stream
the Worker did not open is handed back to PHP untouched, so arming does not disturb file writes in a
render.

The Durable Object's own SQLite is still the faster cache backend and the recommended one. A
parked get is a network round trip; a SQLite read is local. Measured from a Durable Object, a round
trip is 1 ms to a same-region server and 53 ms to a distant one, and every cache operation pays one.
Redis is here for a deployment that already has a server and wants Drupal pointed at it, not because
it is quicker. The status report says so on any site that enables the module.

A blocking outbound call over HTTP is served by replacing the transport rather than trapping it.
PHP reaches HTTPS through a stream wrapper the runtime invokes from inside a C frame, and a park under
one cannot resume, so Guzzle and Symfony's HTTP client are given a handler that yields from userland
instead. `drupal/openid_connect` completes a login through its own client that way. A call made from
inside an internal function such as `array_map` cannot park; it falls back to the deferred transport
rather than failing.

| var               | default | what it does                                                               |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| `PARK`            | on      | whether the park may arm at all; anything but `1` routes renders around it |
| `SLEEP_BUDGET_MS` | 2,000   | total ms PHP may wait through the park per request; an alarm gets 15x      |

`sleep()`, `usleep()` and a Guzzle `delay` park for real, up to the budget. Past it, a sleep returns at
once and records how much it was short, so a retry loop never holds a visitor longer than a slow render.
