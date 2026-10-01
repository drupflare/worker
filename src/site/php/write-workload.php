<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Drupal\file\Entity\File;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\user\Entity\User;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$opt = json_decode(__CFW_PAYLOAD__, true);
$out = ['ok' => false, 'op' => $opt['op']];

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];
	if (!isset($GLOBALS['__pw_kernel'])) {
		$boot = Request::create('/', 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($boot);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$kernel->boot();
		$GLOBALS['__pw_kernel'] = $kernel;
		$out['bootedKernel'] = 1;
	}

	if (!defined('SAVED_NEW')) {
		require_once '/drupal/core/includes/common.inc';
	}

	if (empty($GLOBALS['__cfw_schema_repaired'])) {
		$GLOBALS['__cfw_schema_repaired'] = true;
		// __CFW_SCHEMA_REPAIR__
	}

	$db = Drupal::database();
	// the driver's own counters, which the host tally cannot see: a speculative replay re-sends
	// buffered statements to resolve an insert id, and that is CPU the rows meter never charges
	$counter = function ($method) use ($db) {
		return method_exists($db, $method) ? (int) $db->$method() : -1;
	};
	$before = [
		'statements' => $counter('statementCount'),
		'transactions' => $counter('transactionCount'),
		'speculative' => $counter('speculativeCount'),
		'replayed' => $counter('replayedStatementCount'),
	];

	$seq = (int) $opt['seq'];
	$nid = (int) $opt['nid'];
	$previousAccount = Drupal::currentUser()->getAccount();
	$admin = User::load(1);
	if ($admin !== null) {
		Drupal::currentUser()->setAccount($admin);
	}

	switch ($opt['op']) {
		case 'node-create':
			$types = array_keys(NodeType::loadMultiple());
			$type = in_array('page', $types, true) ? 'page' : $types[0] ?? null;
			if ($type === null) {
				throw new RuntimeException('no node type exists in this site');
			}
			$node = Node::create([
				'type' => $type,
				'title' => 'Amplification ' . $seq,
				'uid' => 1,
				'status' => 1,
			]);
			$node->save();
			$out['id'] = (int) $node->id();
			$out['vid'] = (int) $node->getRevisionId();
			break;

		case 'node-revision':
			$node = Node::load($nid);
			if ($node === null) {
				throw new RuntimeException('no node ' . $nid . ' to revise');
			}
			// explicit rather than relying on the content type default, which is configuration
			$node->setNewRevision(true);
			$node->setRevisionLogMessage('amplification ' . $seq);
			$node->setRevisionCreationTime((int) Drupal::time()->getRequestTime());
			$node->setRevisionUserId(1);
			$node->setTitle('Amplification revised ' . $seq);
			$node->save();
			$out['id'] = (int) $node->id();
			$out['vid'] = (int) $node->getRevisionId();
			break;

		case 'user-create':
			$account = User::create(['name' => 'amp' . $seq]);
			$account->setEmail('amp' . $seq . '@example.invalid');
			$account->setPassword('cfw-Amp-' . $seq . '-pass');
			$account->activate();
			$account->save();
			$out['id'] = (int) $account->id();
			break;

		case 'file-create':
			// the ROW, not the bytes: a real upload also writes the stream, and that lands in MEMFS and
			// the R2 mirror rather than in Durable Object SQL, so it is a different meter
			$file = File::create([
				'uri' => 'public://amplification-' . $seq . '.txt',
				'filename' => 'amplification-' . $seq . '.txt',
				'filemime' => 'text/plain',
				'filesize' => 11,
				'status' => 1,
				'uid' => 1,
			]);
			$file->save();
			$out['id'] = (int) $file->id();
			break;

		case 'alias-create':
			$alias = Drupal::entityTypeManager()
				->getStorage('path_alias')
				->create([
					'path' => '/node/' . ($nid > 0 ? $nid : 1),
					'alias' => '/amplification-' . $seq,
					'langcode' => 'en',
				]);
			$alias->save();
			$out['id'] = (int) $alias->id();
			break;

		case 'txn-autoinc':
		case 'txn-rowid':
			// THE A/B. Both tables are created by the caller and differ only in the keyword, so what this
			// measures is whether predictBufferedInsertId() could answer -- it refuses AUTOINCREMENT,
			// because that table's next id comes from sqlite_sequence rather than from max(rowid) + 1,
			// and the fallback replays the whole buffer through the host
			$table = $opt['op'] === 'txn-autoinc' ? 'amp_txn_auto' : 'amp_txn_rowid';
			$txn = $db->startTransaction();
			$db->query('INSERT INTO {' . $table . '} (v) VALUES (:v)', [':v' => 'row ' . $seq]);
			$out['id'] = (int) $db->lastInsertId();
			unset($txn);
			$out['table'] = $table;
			break;

		default:
			throw new RuntimeException('unknown workload ' . $opt['op']);
	}

	$out['driver'] = [
		'statements' => $counter('statementCount') - $before['statements'],
		'transactions' => $counter('transactionCount') - $before['transactions'],
		'speculative' => $counter('speculativeCount') - $before['speculative'],
		'replayed' => $counter('replayedStatementCount') - $before['replayed'],
		// WHY each replay happened, not just how many. Two mechanisms were proposed for these on a
		// count alone and neither moved it; a reason cannot be guessed at a third time
		'refusals' => method_exists($db, 'predictionRefusals') ? $db->predictionRefusals() : [],
	];
	$out['ok'] = $out['id'] > 0;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 900);
} finally {
	if (isset($previousAccount)) {
		try {
			Drupal::currentUser()->setAccount($previousAccount);
		} catch (Throwable $e2) {
		}
	}
}

echo json_encode($out);
