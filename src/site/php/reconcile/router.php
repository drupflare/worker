<?php
// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
try {
	// __CFW_KERNEL_BOOT__
	$before = (int) Drupal::database()->query('SELECT COUNT(*) FROM {router}')->fetchField();
	$builder = Drupal::service('router.builder');
	$builder->setRebuildNeeded();
	$builder->rebuildIfNeeded();
	$after = (int) Drupal::database()->query('SELECT COUNT(*) FROM {router}')->fetchField();
	// the menu links come from the same discovery and are the other half of what was missing
	Drupal::service('plugin.manager.menu.link')->rebuild();
	// AND THE LOCAL TASKS, which rebuilding the router does NOT reach. A tab declared in a
	// links.task.yml file is a discovery-cached plugin, so a route can exist and resolve while the
	// tab that leads to it is absent from its own page -- which is what the modules page showed
	// after the Code Delivery route landed: the path answered and the page still had two tabs.
	Drupal::service('plugin.manager.menu.local_task')->clearCachedDefinitions();
	$out['tasks'] = count(Drupal::service('plugin.manager.menu.local_task')->getDefinitions());
	$out['before'] = $before;
	$out['after'] = $after;
	$out['ok'] = $after > 0;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}
echo json_encode($out);
