<?php

use Drupal\Core\Queue\DelayableQueueInterface;
use Drupal\Core\Queue\DelayedRequeueException;
use Drupal\Core\Queue\RequeueException;
use Drupal\Core\Queue\SuspendQueueException;
use Drupal\Core\Session\AnonymousUserSession;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$name = json_decode(__CFW_NAME__);
$max = __CFW_MAX__;
$out = [
	'queue' => $name,
	'processed' => 0,
	'failed' => 0,
	'requeued' => 0,
	'delayed' => 0,
	'suspended' => false,
];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

try {
	// __CFW_KERNEL_BOOT__

	$manager = Drupal::service('plugin.manager.queue_worker');
	$definitions = $manager->getDefinitions();
	if (!isset($definitions[$name])) {
		$out['reason'] = 'no queue worker plugin';
	} else {
		$lease = (int) ($definitions[$name]['cron']['time'] ?? 60);
		$queue = Drupal::queue($name);
		try {
			$queue->createQueue();
		} catch (Throwable $e) {
		}
		$worker = $manager->createInstance($name);
		$switcher = null;
		try {
			$switcher = Drupal::service('account_switcher');
			$switcher->switchTo(new AnonymousUserSession());
		} catch (Throwable $e) {
			$switcher = null;
		}

		for ($i = 0; $i < $max; $i++) {
			$item = $queue->claimItem($lease);
			if (!is_object($item)) {
				break;
			}
			try {
				$worker->processItem($item->data);
				$queue->deleteItem($item);
				$out['processed']++;
			} catch (DelayedRequeueException $e) {
				// leave the lease alone unless the queue can extend it itself
				if ($queue instanceof DelayableQueueInterface) {
					$queue->delayItem($item, $e->getDelay());
				}
				$out['delayed']++;
			} catch (RequeueException $e) {
				$queue->releaseItem($item);
				$out['requeued']++;
			} catch (SuspendQueueException $e) {
				$queue->releaseItem($item);
				$out['suspended'] = true;
				break;
			} catch (Throwable $e) {
				// left leased, exactly as core does, so it retries after the lease
				$out['failed']++;
				$out['lastError'] = get_class($e) . ': ' . $e->getMessage();
				break;
			}
		}

		if ($switcher !== null) {
			try {
				$switcher->switchBack();
			} catch (Throwable $e) {
			}
		}
		try {
			$out['remaining'] = (int) $queue->numberOfItems();
		} catch (Throwable $e) {
		}
		$out['ran'] = true;
	}
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
