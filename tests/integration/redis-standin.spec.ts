import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `\Redis` with no Redis: the stand-in in the drupflare module, inside a booted Drupal.
 *
 * mantle2 keeps unsubscribe tokens and notification markers in Redis through phpredis, and a
 * Worker has no server to dial and no extension. `drupal/redis` picks its client by
 * `class_exists`, so the autoloader alias in `STANDIN_FIX` is what makes a module's `\Redis` work.
 * The sibling's health suite checks the class; this checks the wiring and that a key outlives the
 * client that wrote it, because it is a row in the database.
 *
 * Needs the pack, so it is in `ARTIFACT_SPECS`.
 */

type Payload = Record<string, unknown>;
const TIMEOUT = 600_000;

const PROBE = String.raw`<?php
$out = ['ok' => false];
try {
  $out['classExists'] = class_exists('Redis');
  $out['extensionLoaded'] = extension_loaded('redis');
  $out['exceptionClass'] = class_exists('RedisException');
  $r = new \Redis();
  $out['connect'] = $r->connect('127.0.0.1', 6379);
  $out['select'] = $r->select(0);
  $r->setOption(\Redis::OPT_SERIALIZER, \Redis::SERIALIZER_NONE);
  $out['setex'] = $r->setex('cloud:points:7', 100, json_encode(['points' => 5]));
  $out['get'] = $r->get('cloud:points:7');
  $out['ttl'] = $r->ttl('cloud:points:7');
  $it = null;
  $out['scan'] = $r->scan($it, 'cloud:*', 1000);
  $out['cursor'] = $it;
  $out['keys'] = $r->keys('cloud:*');
  $r->set('persist', 'yes');
  $second = new \Redis();
  $second->connect('127.0.0.1', 6379);
  $out['second'] = $second->get('persist');
  $rows = \Drupal::database()->query("SELECT collection, name FROM {key_value_expire} WHERE name = 'persist'")->fetchAll();
  $out['row'] = array_map(fn ($row) => [$row->collection, $row->name], $rows);
  $out['del'] = $r->del('cloud:points:7');
  $out['gone'] = $r->get('cloud:points:7');
  try {
    $r->hSet('h', 'f', 'v');
    $out['threw'] = false;
  } catch (\RedisException $e) {
    $out['threw'] = true;
  }
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 300);
}
echo json_encode($out);
`;

async function probe(): Promise<Payload> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const booted = (await site.runJson(BOOT_KERNEL)) as Payload;
		if (booted?.['ok'] === false) throw new Error(`boot failed: ${JSON.stringify(booted)}`);
		return (await site.runJson(PROBE)) as Payload;
	});
}

describe('the Redis stand-in in a booted site', () => {
	it(
		'is a class with no extension behind it, and the exception a module catches',
		async () => {
			const out = await probe();
			expect(out['error']).toBeUndefined();
			expect(out['classExists']).toBe(true);
			expect(out['extensionLoaded']).toBe(false);
			expect(out['exceptionClass']).toBe(true);
		},
		TIMEOUT
	);

	it(
		'answers connect, select, setex, get, ttl, scan, keys and del the way phpredis does',
		async () => {
			const out = await probe();
			expect(out['connect']).toBe(true);
			expect(out['select']).toBe(true);
			expect(out['setex']).toBe(true);
			expect(out['get']).toBe('{"points":5}');
			expect(out['ttl']).toBeGreaterThan(90);
			expect(out['scan']).toEqual(['cloud:points:7']);
			expect(out['cursor']).toBe(0);
			expect(out['keys']).toEqual(['cloud:points:7']);
			expect(out['del']).toBe(1);
			expect(out['gone']).toBe(false);
		},
		TIMEOUT
	);

	it(
		'keeps a key in key_value_expire, so a second client and a dump both see it',
		async () => {
			const out = await probe();
			expect(out['second']).toBe('yes');
			expect(out['row']).toEqual([['cfw_redis.0', 'persist']]);
		},
		TIMEOUT
	);

	it(
		'throws RedisException for a command it cannot answer',
		async () => {
			expect((await probe())['threw']).toBe(true);
		},
		TIMEOUT
	);
});
