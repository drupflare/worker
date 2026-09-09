import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { SHIPPED_CAPABILITIES } from '../../src/ops/catalog';
import { PARK_PROBE } from '../../src/ops/park';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Whether a park survives the dispatch Drupal reaches its own code through.
 *
 * Every earlier reading of this was taken through a HARNESS: a closure called from a plain function,
 * a chain built by hand, a `call_user_func_array` written into an `eval`. All of them read safe and a
 * render refused, and the difference is the NAMESPACE. `zend_try_compile_special_func` rewrites
 * `call_user_func_array($fn, $args)` to `ZEND_INIT_USER_CALL` and no internal frame exists -- but
 * only where the compiler resolved the name, and an unqualified call inside a namespace compiles to
 * `ZEND_INIT_NS_FCALL_BY_NAME` and resolves at runtime. All of Drupal is namespaced; every harness
 * was global.
 *
 * So the reading has to come from a PACK file. `FormBuilder::retrieveForm()` dispatches the form
 * callback through `call_user_func_array` and is one, and a form object declared here reaches it
 * without any module code. Two controls sit beside it: the identical dispatch written into the eval,
 * which is global scope, and `array_map`, which is a frame no park may ever splice.
 */

type Interp = ServeDo & { run: (code: string) => Promise<string> };

/** classifies every frame above the caller, so a refusal names what it refused under */
const FRAME_HELPER = `
if (!function_exists('cfw_probe_frames')) {
  function cfw_probe_frames() {
    $out = [];
    foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS) as $f) {
      $name = ($f['class'] ?? '') . ($f['type'] ?? '') . ($f['function'] ?? '?');
      $kind = '?';
      try {
        $r = isset($f['class'])
          ? new ReflectionMethod($f['class'], $f['function'])
          : new ReflectionFunction($f['function']);
        $kind = $r->isInternal() ? 'I' : 'U';
      } catch (Throwable $e) {}
      $out[] = $kind . ':' . $name;
    }
    return $out;
  }
}
`;

/**
 * The form whose build reports what it was dispatched through.
 *
 * Declared conditionally because the executor is persistent: a class declared in one `_run()` is
 * still there in the next, and an unconditional declaration is a fatal on the second call.
 */
const PROBE_FORM = `
if (!class_exists('CfwProbeForm', false)) {
  class CfwProbeForm implements \\Drupal\\Core\\Form\\FormInterface {
    public function getFormId() { return 'cfw_probe_form'; }
    public function buildForm(array $form, \\Drupal\\Core\\Form\\FormStateInterface $form_state) {
      $GLOBALS['CFW_DISPATCH']['form'] = ['unsafe' => cfw_park_safe(), 'frames' => cfw_probe_frames()];
      return $form;
    }
    public function validateForm(array &$form, \\Drupal\\Core\\Form\\FormStateInterface $form_state) {}
    public function submitForm(array &$form, \\Drupal\\Core\\Form\\FormStateInterface $form_state) {}
  }
}
`;

/** the same dispatch, compiled by `zend_eval_string` rather than read out of the pack */
const EVAL_CONTROL = `
if (!function_exists('cfw_probe_leaf')) {
  function cfw_probe_leaf() { return cfw_park_safe(); }
}
$GLOBALS['CFW_DISPATCH']['evalDirect'] = cfw_probe_leaf();
$GLOBALS['CFW_DISPATCH']['evalCufa'] = call_user_func_array('cfw_probe_leaf', []);
$GLOBALS['CFW_DISPATCH']['evalCuf'] = call_user_func('cfw_probe_leaf');
$m = array_map(function () { return cfw_park_safe(); }, [1]);
$GLOBALS['CFW_DISPATCH']['evalArrayMap'] = $m[0];
$GLOBALS['CFW_DISPATCH']['opcache'] = [
  'loaded' => extension_loaded('Zend OPcache'),
  'enable' => ini_get('opcache.enable'),
  'fileCache' => ini_get('opcache.file_cache'),
  'fileCacheOnly' => ini_get('opcache.file_cache_only'),
  'optimization' => ini_get('opcache.optimization_level'),
];
if (!function_exists('cfw_dyn_cufa')) {
  $p = '/tmp/cfw-probe-dyn.php';
  file_put_contents($p, '<?php function cfw_dyn_leaf() { return cfw_park_safe(); } '
    . 'function cfw_dyn_cufa() { return call_user_func_array("cfw_dyn_leaf", []); }');
  require $p;
}
$GLOBALS['CFW_DISPATCH']['fileCufa'] = cfw_dyn_cufa();
`;

const MEASURE = [
	FRAME_HELPER,
	EVAL_CONTROL,
	PROBE_FORM,
	"$GLOBALS['CFW_DISPATCH']['form'] = null;",
	// the form builder reads the current request for its action and its token, so a build with an
	// empty stack dies in `RequestContext::fromRequest()` before any dispatch happens
	"$req = \\Symfony\\Component\\HttpFoundation\\Request::create('https://probe.local/');",
	'$req->setSession(new \\Symfony\\Component\\HttpFoundation\\Session\\Session(new \\Symfony\\Component\\HttpFoundation\\Session\\Storage\\MockArraySessionStorage()));',
	"\\Drupal::service('request_stack')->push($req);",
	'$fs = new \\Drupal\\Core\\Form\\FormState();',
	'try { \\Drupal::formBuilder()->buildForm(new CfwProbeForm(), $fs); }',
	"catch (Throwable $e) { $GLOBALS['CFW_DISPATCH']['formError'] = get_class($e) . ': ' . $e->getMessage(); }"
].join('\n');

describe('the park under Drupal own dispatch', () => {
	it('reports which internal frames a real form build puts between the park and the floor', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const one = site as Interp;
			if ((await site.runJson(PARK_PROBE))['park'] !== true)
				return { build: 'absent' as const };

			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			const booted = await site.runJson(BOOT_KERNEL);
			if (booted['ok'] !== true) return { build: 'no-kernel' as const, booted };

			const ran = await site.runJson(
				`<?php echo json_encode(['s' => cfw_park_run(base64_decode('${btoa(MEASURE)}'))]);`
			);
			// the measurement never parks; it only asks what a park at that point would cost
			const read = await one.run(
				"<?php echo json_encode($GLOBALS['CFW_DISPATCH'] ?? ['missing' => true]);"
			);
			return {
				build: 'current' as const,
				state: String(ran['s'] ?? ''),
				dispatch: JSON.parse(read.slice(read.indexOf('{'))) as Record<string, unknown>
			};
		});

		if (seen.build !== 'current') {
			console.log(`[park-dispatch] ${seen.build} ${JSON.stringify(seen)}`);
			expect(seen.build).toBe('current');
			return;
		}
		console.log(`[park-dispatch] run=${seen.state} ${JSON.stringify(seen.dispatch, null, 1)}`);
		expect(seen.state).toBe('DONE');
		const read = seen.dispatch;

		// THE CONTROL, and without it every reading below could come from a predicate that answers 0
		// for everything -- which is the version of this that silently truncates a render.
		expect(read['evalArrayMap']).toBe(1);
		// the same source line, compiled where the name IS resolved at compile time: no frame at all
		expect(read['evalCufa']).toBe(0);
		expect(read['fileCufa']).toBe(0);

		/**
		 * THE GATE ON THE ARTIFACT, not on the tree.
		 *
		 * `cdn-manifest.json` names the interpreter a clean checkout downloads, and until the build
		 * carrying `park_flatten()` is published there `bun install` replaces the local one with a
		 * binary that refuses this. That would leave `SHIPPED_BLOCKING_HTTP` claiming a capability
		 * the artifact does not have, and every other spec would still pass -- which is the shape
		 * this repository has been caught by twice. So the flag and the reading are pinned together.
		 */
		const form = read['form'] as { unsafe?: number; frames?: string[] } | null;
		expect(form, 'the probe form never built, so nothing was measured').not.toBeNull();
		expect(
			form?.unsafe,
			`Drupal's dispatch refuses a park on this interpreter, and blockingOutbound is ` +
				`${SHIPPED_CAPABILITIES.blockingOutbound}. Frames: ${JSON.stringify(form?.frames)}`
		).toBe(SHIPPED_CAPABILITIES.blockingOutbound ? 0 : 1);
		// and the frame is still THERE; what changed is whether the park can splice it, so a reading
		// of 0 from an empty chain would not pass this
		expect(form?.frames).toContain('I:call_user_func_array');
	});
});
