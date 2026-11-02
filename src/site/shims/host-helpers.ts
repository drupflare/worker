import { phpWhen } from '../../util/php';
import { HOST_HELPERS_PHP } from '../generated/assets';

/**
 * The host-call helper every fragment uses to reach `ctx.storage.sql`.
 *
 * It goes through `vrzno_env('cfwSqlExec')` and the `pw_encode`/`pw_decode` codec, as the driver
 * does, so a working fragment also exercises the driver's transport.
 */
export const HOST_HELPERS = `\n${phpWhen("!function_exists('cfw_host')", HOST_HELPERS_PHP)}\n`;
