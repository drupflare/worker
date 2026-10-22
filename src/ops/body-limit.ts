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

/**
 * The largest `multipart/form-data` body that may reach the object, in bytes.
 * The site set no ceiling here before; the platform's own 100 MB request limit was the only one, so
 * this default sits at that limit and lowers nothing that arrived. An upload is read whole by the
 * object, so `MAX_UPLOAD_BYTES` is what an operator lowers to protect the isolate.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
