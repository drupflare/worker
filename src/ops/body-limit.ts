/**
 * The inbound body ceiling.
 *
 * It lives outside `src/site.ts` because workerd rejects any non-function named export of the
 * entrypoint module ("Incorrect type for map entry ...") and a `const` there takes the whole worker
 * down at startup; exported functions are fine. `tests/unit/runtime/route-gate.spec.ts` pins it.
 * @module
 */

/**
 * The largest non-file request body that may reach the interpreter, in bytes.
 * A heap guard, not a bandwidth one: `parse_str()` allocates inside a 128 MB isolate and a
 * nested-array body (`foo[][][]=bar`) expands far past its wire size. Tighter than Drupal's 8 MB
 * `post_max_size` because there is no separate process to lose.
 */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
