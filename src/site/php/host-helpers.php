<?php

/**
 * Reads a capability the host installed on the Module.
 *
 * @param string $name
 *   The capability the host installed on the Module.
 *
 * @return mixed
 *   The host function, or NULL when there is no bridge.
 */
function cfw_host($name)
{
	return function_exists('vrzno_env') ? vrzno_env($name) : null;
}
/**
 * Sends one request across the bridge and decodes the reply.
 *
 * @param callable $fn
 *   The host function from cfw_host().
 * @param array<string, mixed> $payload
 *   The request, run through the pw codec.
 *
 * @return array<string, mixed>
 *   The decoded reply, or an `ok => false` refusal naming what went wrong.
 */
function cfw_call($fn, array $payload)
{
	$invoke = $fn;
	$reply = $invoke(json_encode(pw_encode($payload)));
	if (!is_string($reply)) {
		return [
			'ok' => false,
			'error' =>
				'host returned ' . get_debug_type($reply) . ' where a JSON string was expected',
		];
	}
	$decoded = json_decode($reply, true);
	if (!is_array($decoded)) {
		return ['ok' => false, 'error' => 'unparseable host reply: ' . substr($reply, 0, 200)];
	}
	return pw_decode($decoded);
}
/**
 * Runs one SQL statement on the object's database.
 *
 * @param string $sql
 *   One statement.
 * @param array<int|string, mixed> $params
 *   Positional or named bindings.
 *
 * @return array<string, mixed>
 *   The host reply: `ok`, and `rows` on a read.
 */
function cfw_sql($sql, $params = [])
{
	return cfw_call(cfw_host('cfwSqlExec'), ['sql' => $sql, 'params' => $params]);
}
/**
 * Runs statements in one transaction, optionally reading inside it.
 *
 * @param array<int, array{sql: string, params: array<int|string, mixed>}> $statements
 *   The statements to run in one transaction.
 * @param bool $commit
 *   Whether to commit rather than roll back.
 * @param array{sql: string, params: array<int|string, mixed>}|null $read
 *   A statement to run inside the transaction and report.
 *
 * @return array<string, mixed>
 *   The host reply: `ok`, and `readResult` when a read was asked for.
 */
function cfw_txn(array $statements, $commit = true, $read = null)
{
	return cfw_call(cfw_host('cfwSqlTxn'), [
		'statements' => array_values($statements),
		'commit' => $commit,
		'read' => $read,
	]);
}
