/**
 * The inbound body ceiling.
 *
 * This lives here rather than in `src/site.ts` for a runtime reason, not a tidiness one. workerd
 * inspects every named export of the ENTRYPOINT module and rejects anything that is not a function
 * or an `ExportedHandler`:
 *
 *   Uncaught TypeError: Incorrect type for map entry 'DEFAULT_MAX_BODY_BYTES':
 *   the provided value is not of type 'function or ExportedHandler'.
 *
 * A `const` exported from the entrypoint takes the whole worker down at startup. Exported
 * FUNCTIONS are fine, which is why `bodyTooLarge()` and `isNeverDrupal()` sit there without
 * complaint and only the number failed, which is what makes the distinction easy to miss twice.
 * `tests/unit/runtime/route-gate.spec.ts` pins the rule so the next constant fails a test rather
 * than a dev server.
 */

/** 2 MiB, which is well above any form this site renders and well below the DO record ceiling */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
