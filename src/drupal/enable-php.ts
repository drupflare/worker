import { ENABLE_MODULE_PHP, ENABLE_VERIFY_PHP } from '../site/generated/assets';

/**
 * The PHP that enables a Drupal module through Drupal's own installer.
 *
 * `OpsRegistry` prices `en` at 1,344.7 ms plus a 282.9 ms `cr` flush, estimated from native PHP.
 * The probe asserts an outcome (`Drupal::logger()` reaching `CfwLogger`), where a changed config
 * row proves nothing.
 */
export const ENABLE_MODULE = `<?php\n${ENABLE_MODULE_PHP}`;

/**
 * Whether the module's services became reachable, which is the acceptance condition.
 *
 * Run as its own invocation on a dropped interpreter: the install rebuilds the container, and the
 * same PHP run could still be served by the pre-rebuild one held in memory.
 */
export const ENABLE_VERIFY = `<?php\n${ENABLE_VERIFY_PHP}`;
