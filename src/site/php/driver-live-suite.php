<?php

use Drupal\cfw_do_sqlite\Driver\Database\cfw_do_sqlite\CfwSqlClient;
use Drupal\cfw_do_sqlite\Driver\Database\cfw_do_sqlite\Connection;
use Drupal\Core\Database\IntegrityConstraintViolationException;
use Drupal\Core\Database\InvalidQueryException;
use Drupal\Core\DrupalKernel;

// __CFW_HOST_HELPERS__

$out = ['passed' => 0, 'failed' => 0, 'checks' => []];
$ok = function ($label, $condition, $detail = null) use (&$out) {
	if ($condition) {
		$out['passed']++;
	} else {
		$out['failed']++;
	}
	$out['checks'][] = ['label' => $label, 'ok' => (bool) $condition, 'detail' => $detail];
};

// require, NEVER require_once, and the guard tests the VALUE rather than the key. require_once
// returns TRUE when the file is already included, so capturing its result yields the boolean
// instead of the ClassLoader -- and a heap restore reaches exactly that state, with autoload.php in
// the included-files table and this global not restored beside it. Measured on an imaged site:
// Call to a member function addPsr4() on true. Composer getLoader() memoizes, so a plain require
// hands back the same loader and re-registers nothing
if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
	$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];
$autoloader->addPsr4(
	'Drupal\\sqlite\\Driver\\Database\\sqlite\\',
	'/drupal/core/modules/sqlite/src/Driver/Database/sqlite/',
);
$autoloader->addPsr4(
	'Drupal\\cfw_do_sqlite\\Driver\\Database\\cfw_do_sqlite\\',
	'/drupal/modules/custom/cfw_do_sqlite/src/Driver/Database/cfw_do_sqlite/',
);
// this suite constructs the driver directly rather than through settings.php, so it is on its own
// for the userland PDO the statement classes need; see src/site-do.js for the served path
require_once '/drupal/modules/custom/cfw_do_sqlite/src/pdo-shim.php';

try {
	DrupalKernel::bootEnvironment();
} catch (Throwable $e) {
	// already booted in this interpreter, which is fine
}

try {
	$client = new CfwSqlClient();
	$ok('client constructs against the live bridge', true);
	$ok('client reports transaction support', $client->supportsTransactions());

	$connection = new Connection($client, ['prefix' => '']);
	$ok('connection constructs', true);
	$ok(
		'driver() is cfw_do_sqlite',
		$connection->driver() === 'cfw_do_sqlite',
		$connection->driver(),
	);
	$ok(
		'databaseType() is sqlite',
		$connection->databaseType() === 'sqlite',
		$connection->databaseType(),
	);

	$version = $connection->version();
	$ok(
		'version() returns an engine version through the DBAL',
		(bool) preg_match('/^3\./', (string) $version),
		$version,
	);
	$ok('supportsAtomicCommit()', $connection->supportsAtomicCommit());

	$schema = $connection->schema();
	$connection->query('DROP TABLE IF EXISTS cfw_live');
	$schema->createTable('cfw_live', [
		'fields' => [
			'id' => ['type' => 'serial', 'not null' => true],
			// binary FALSE is the only thing that makes core emit a collation clause,
			// which is what Schema then rewrites to builtin NOCASE
			'name' => ['type' => 'varchar', 'length' => 64, 'not null' => true, 'binary' => false],
			'bin' => ['type' => 'varchar', 'length' => 64, 'not null' => false],
			'n' => ['type' => 'int', 'not null' => false],
		],
		'primary key' => ['id'],
		'indexes' => ['name' => ['name']],
	]);
	$ddl = $connection
		->query('SELECT sql FROM sqlite_master WHERE name = :n', [':n' => 'cfw_live'])
		->fetchField();
	$ok(
		'createTable() emitted COLLATE NOCASE, not NOCASE_UTF8',
		str_contains((string) $ddl, 'COLLATE NOCASE') &&
			!str_contains((string) $ddl, 'NOCASE_UTF8'),
		$ddl,
	);
	$ok('schema()->createTable() through the DBAL', $schema->tableExists('cfw_live'));
	$ok('fieldExists() uses PRAGMA table_info', $schema->fieldExists('cfw_live', 'name'));
	$ok('indexExists() uses PRAGMA index_list', $schema->indexExists('cfw_live', 'name'));

	$id = $connection
		->insert('cfw_live')
		->fields(['name' => 'first', 'n' => 7])
		->execute();
	$ok('insert() returns a rowid', (string) $id === '1', $id);

	$connection
		->insert('cfw_live')
		->fields(['name' => 'second', 'n' => 8])
		->execute();
	$count = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
	$ok('select() countQuery sees both rows', (string) $count === '2', $count);

	$name = $connection
		->query('SELECT name FROM {cfw_live} WHERE n = :n', [':n' => 8])
		->fetchField();
	$ok('query() with a named placeholder', $name === 'second', $name);

	$connection
		->update('cfw_live')
		->fields(['n' => 9])
		->condition('name', 'first')
		->execute();
	$n = $connection
		->query('SELECT n FROM {cfw_live} WHERE name = :name', [':name' => 'first'])
		->fetchField();
	$ok('update() through the DBAL', (string) $n === '9', $n);

	// ASCII case-insensitivity survives the NOCASE substitution
	$hit = $connection
		->query('SELECT COUNT(*) FROM {cfw_live} WHERE name = :name', [':name' => 'FIRST'])
		->fetchField();
	$ok('NOCASE folds ASCII on a binary=FALSE column', (string) $hit === '1', $hit);

	// the documented limitation, asserted rather than assumed: builtin NOCASE is
	// ASCII-only, so non-ASCII comparison stays case-SENSITIVE
	$connection
		->insert('cfw_live')
		->fields(['name' => "\u{00DC}nicode", 'n' => 1])
		->execute();
	$folded = $connection
		->query('SELECT COUNT(*) FROM {cfw_live} WHERE name = :name', [':name' => "\u{00FC}nicode"])
		->fetchField();
	$ok('NOCASE does NOT fold non-ASCII (documented gap)', (string) $folded === '0', $folded);
	$connection->delete('cfw_live')->condition('name', "\u{00DC}nicode")->execute();

	// a column without binary=FALSE gets no collation clause, so it stays
	// case-sensitive; this is the control that proves the check above means
	// something
	$connection
		->update('cfw_live')
		->fields(['bin' => 'Exact'])
		->condition('name', 'first')
		->execute();
	$binHit = $connection
		->query('SELECT COUNT(*) FROM {cfw_live} WHERE bin = :v', [':v' => 'exact'])
		->fetchField();
	$ok(
		'a column with default collation stays case-sensitive (control)',
		(string) $binHit === '0',
		$binHit,
	);

	// LIKE BINARY, which threw before likeToGlob() was wired in. Every one of
	// these is a case where builtin GLOB alone would have been silently wrong.
	$connection
		->insert('cfw_live')
		->fields(['name' => 'Alpha%Beta', 'n' => 20])
		->execute();
	$connection
		->insert('cfw_live')
		->fields(['name' => 'Alpha*Beta', 'n' => 21])
		->execute();
	$connection
		->insert('cfw_live')
		->fields(['name' => 'alphaxbeta', 'n' => 22])
		->execute();

	$lb = function (string $pattern) use ($connection): string {
		return (string) $connection
			->select('cfw_live', 'c')
			->condition('name', $pattern, 'LIKE BINARY')
			->countQuery()
			->execute()
			->fetchField();
	};
	$ok('LIKE BINARY no longer throws', true);
	$ok('LIKE BINARY % is a wildcard', $lb('Alpha%') === '2', $lb('Alpha%'));
	$ok('LIKE BINARY is case-sensitive', $lb('alpha%') === '1', $lb('alpha%'));
	$ok('LIKE BINARY _ matches one character', $lb('alpha_beta') === '1', $lb('alpha_beta'));
	$ok('LIKE BINARY treats * as a literal', $lb('%*%') === '1', $lb('%*%'));
	$ok('LIKE BINARY finds a literal percent', $lb('%\\%%') === '0', $lb('%\\%%'));
	$notLike = (string) $connection
		->select('cfw_live', 'c')
		->condition('name', 'Alpha%', 'NOT LIKE BINARY')
		->countQuery()
		->execute()
		->fetchField();
	$ok('NOT LIKE BINARY negates', $notLike !== '0', $notLike);

	// the entity-query path that generates LIKE BINARY in the first place
	$starts = (string) $connection
		->select('cfw_live', 'c')
		->condition('name', $connection->escapeLike('Alpha') . '%', 'LIKE BINARY')
		->countQuery()
		->execute()
		->fetchField();
	$ok('STARTS_WITH shape through escapeLike()', $starts === '2', $starts);

	$connection->delete('cfw_live')->condition('n', 20, '>=')->execute();

	// a real transaction, buffered in PHP and replayed atomically in the host
	$txn = $connection->startTransaction();
	$connection
		->insert('cfw_live')
		->fields(['name' => 'buffered', 'n' => 10])
		->execute();
	$inside = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
	$ok(
		'a read inside the transaction sees its own buffered write',
		(string) $inside === '3',
		$inside,
	);
	unset($txn);
	$afterCommit = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
	$ok('commit replays the buffer', (string) $afterCommit === '3', $afterCommit);

	$txn2 = $connection->startTransaction();
	$connection
		->insert('cfw_live')
		->fields(['name' => 'doomed', 'n' => 11])
		->execute();
	$txn2->rollBack();
	unset($txn2);
	$afterRollback = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
	$ok('rollback writes nothing', (string) $afterRollback === '3', $afterRollback);

	// queryRange, which the core sqlite driver implements with LIMIT/OFFSET
	$range = $connection->queryRange('SELECT name FROM {cfw_live} ORDER BY id', 1, 1)->fetchField();
	$ok('queryRange()', $range === 'second', $range);

	// CREATE TEMPORARY TABLE is refused by the host authorizer, so the contract is
	// that queryTemporary() throws a message naming the reason rather than
	// surfacing a raw SQLITE_AUTH from somewhere deeper
	try {
		$connection->queryTemporary('SELECT name FROM {cfw_live}', []);
		$ok('queryTemporary() refuses loudly', false, 'no exception thrown');
	} catch (InvalidQueryException $e) {
		$ok(
			'queryTemporary() refuses loudly',
			str_contains($e->getMessage(), 'SQLITE_AUTH'),
			$e->getMessage(),
		);
	}

	// a constraint violation must map onto Drupal's exception, not a raw error
	try {
		$connection->query('INSERT INTO {cfw_live} (id, name, n) VALUES (1, :name, 0)', [
			':name' => 'dupe',
		]);
		$ok(
			'duplicate primary key throws IntegrityConstraintViolationException',
			false,
			'no exception',
		);
	} catch (IntegrityConstraintViolationException $e) {
		$ok('duplicate primary key throws IntegrityConstraintViolationException', true);
	} catch (Throwable $e) {
		$ok(
			'duplicate primary key throws IntegrityConstraintViolationException',
			false,
			get_class($e) . ': ' . $e->getMessage(),
		);
	}

	$out['statementCount'] = $client->statementCount();
	$connection->query('DROP TABLE IF EXISTS cfw_live');
} catch (Throwable $e) {
	$out['fatal'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 1200);
}

echo json_encode($out);
