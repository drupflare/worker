/**
 * PHP probes more than one spec needs, lifted so the copies cannot drift.
 *
 * Same reason `drupal-forms.ts` exists: a fragment pasted into a second spec is a fragment that
 * stops agreeing with the first one, and a probe that has quietly stopped measuring what its caller
 * thinks it measures is the most expensive kind of wrong here.
 *
 * Not a `.spec.ts`, so vitest does not collect it, and `tests/**` is excluded from coverage.
 */

/** the flag DrupflareServiceProvider reads, plus the symbol an Asyncify build would provide */
export const SUSPEND_PROBE = String.raw`<?php
$hasEnv = function_exists('vrzno_env');
echo json_encode([
  'ok' => true,
  'hasVrznoEnv' => $hasEnv,
  'canSuspend' => $hasEnv ? vrzno_env('cfwCanSuspend') : null,
  'hasVrznoAwait' => function_exists('vrzno_await'),
]);
`;
