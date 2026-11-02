# OIDC Login

A login is completed by the Worker. The callback is an ordinary request, so the token exchange and
the `id_token` signature check happen in JavaScript before PHP is entered, and PHP is handed a
decided result. `src/ops/oidc.ts` is the implementation.

This route needs no module. `drupal/openid_connect` also works, through its own client: the
`openssl_*` functions are bridged to the host's crypto and the token POST is parked. An unverified
`id_token` is an unauthenticated login either way, so both paths verify the signature.

| setting              | where   | what it does                                         |
| -------------------- | ------- | ---------------------------------------------------- |
| `oidc_issuer`        | sealed  | the provider's issuer URL; https, or a loopback host |
| `oidc_client_id`     | sealed  | the client registered with that provider             |
| `OIDC_CLIENT_SECRET` | binding | for a provider that issued one; a secret, not a var  |

The issuer and the client id sit in the object's own storage, and the secret is a binding. None of
the three can be set from KV: a writer who could change the issuer would point the consent screen at
a provider they control, and every login on the site would authenticate against it.

Plain http is refused except on a loopback host, which is what lets a provider run on the same machine
during development. A deployed Worker has no loopback to reach, so the exemption grants nothing there.

Register `https://<your-site>/oidc?action=callback` as the redirect URI. `/oidc` starts a login and
accepts an optional `return` path, which must be site-relative. It is a public route because a
provider's redirect carries no header this Worker controls; `state` is what authenticates it.

Completing a login also needs `drupal/externalauth` installed on the site, which is what maps the
verified identity onto an account. No contrib module ships in the packed tree, so install it from the
Extend page at `/_cfw/extend` before the first login.

`/setup/oidc` reads and writes the two `cfw_meta` values, and `/_cfw/access` is the page over it.

| action           | method | what it does                                                                   |
| ---------------- | ------ | ------------------------------------------------------------------------------ |
| `?action=status` | GET    | the issuer, the client id, whether the secret binding is set, the redirect URI |
| `?action=save`   | POST   | validates and stores the pair, then fetches the discovery document             |
| `?action=clear`  | GET    | forgets both, which turns login off                                            |

It is an owner route, so it takes the token minted at first run and refuses the admin page's
weaker gate. Reading which provider is configured is harmless; choosing it is not.

The issuer must be `https` and must carry no query or fragment: the discovery URL is built by
appending a fixed path, so an issuer carrying either produces a URL nobody intended. A trailing slash
is normalised away so that discovery and the later `iss` comparison agree on one spelling. Saving
fetches the discovery document immediately and reports what it advertises, so a wrong issuer surfaces
at configuration time, well before someone's first login. The secret is never read back.

**The claims never travel in a URL.** The browser carries a single-use ticket; the claims stay in the
object's storage and the row is deleted before they are returned, so a second presentation of the
same ticket finds nothing. A redirect lands in browser history, in a referrer and in any proxy log
on the path.

Five conditions refuse a login, each tested against real generated keys: a signature from a key
outside the provider's JWKS, an issuer that is not the configured one, an audience belonging to
another client of the same provider, an expired token, and a nonce from a different login. `none`
and the HMAC algorithms are refused by omission. The signing algorithm is taken from the key and not
from the token header, and an account is keyed by issuer and subject together.
