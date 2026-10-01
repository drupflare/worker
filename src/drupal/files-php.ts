import { FILES_PROBE_PHP } from '../site/generated/assets';

/**
 * The instrument for durable files. `op=read` opens a fresh interpreter's view of storage, driven
 * as a separate invocation after dropping the interpreter; a write-then-read inside one PHP run
 * would pass from a buffer.
 */
export const FILES_PROBE = `<?php\n${FILES_PROBE_PHP}`;
