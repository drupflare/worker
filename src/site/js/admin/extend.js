(function () {
	const out = document.getElementById('installed');
	// the module a composer package provides is its name after the vendor prefix, so drupal/pathauto
	// enables as pathauto, which is what /enable takes
	function machineName(pkg) {
		return String(pkg).split('/').pop().replace(/-/g, '_');
	}
	async function ask(url) {
		const res = await fetch(url, { credentials: 'same-origin' });
		const body = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(body.refused || body.error || 'HTTP ' + res.status);
		return body;
	}
	async function install(name, force) {
		out.textContent = 'Installing ' + name + '...';
		try {
			const body = await ask(
				'/install?module=' + encodeURIComponent(name) + (force ? '&force=1' : '')
			);
			// installPackage() reports `files`; this read `stored`, which it has never returned, so
			// every successful install said "0 files"
			out.textContent =
				'Installed ' + name + ': ' + (body.files || 0) + ' files. Now enable it.';
			const b = document.querySelector('[data-enable="' + name + '"]');
			if (b) b.disabled = false;
		} catch (e) {
			out.textContent = 'Refused: ' + e.message;
		}
	}
	async function enable(name) {
		const machine = machineName(name);
		out.textContent = 'Enabling ' + machine + '...';
		try {
			// `retry` means the object dropped a resident interpreter and needs a new invocation
			// before it can boot a fresh one. Repeated here rather than shown, because it is
			// bookkeeping the operator did not ask about
			let body = await ask('/enable?module=' + encodeURIComponent(machine));
			for (let i = 0; i < 2 && body.retry; i++) {
				await new Promise((r) => setTimeout(r, 2000));
				body = await ask('/enable?module=' + encodeURIComponent(machine));
			}
			// `nowEnabled` is what ENABLE_MODULE reads back out of core.extension. This read
			// `enabled`, which only ENABLE_VERIFY sets and only to a module name, so a successful
			// enable rendered "Not enabled: unknown"
			if (!body.nowEnabled) {
				out.textContent =
					'Not enabled: ' +
					(body.error || body.throwMessage || body.readbackError || 'unknown');
				return;
			}
			out.textContent = 'Enabled ' + machine + '.';
			// the object hands back this cue and the page dropped it, so a UI enable left the
			// requeued pages asleep until the next alarm happened along
			if (body.armFill) {
				out.textContent = 'Enabled ' + machine + '. Waking the fill chain...';
				try {
					await ask('/armfill');
					out.textContent = 'Enabled ' + machine + '. Pages are regenerating.';
				} catch (e) {
					out.textContent =
						'Enabled ' + machine + ', but the fill chain did not wake: ' + e.message;
				}
			}
		} catch (e) {
			out.textContent = 'Refused: ' + e.message;
		}
	}
	for (const b of document.querySelectorAll('[data-install]')) {
		b.addEventListener('click', () => install(b.dataset.install, b.dataset.force === '1'));
	}
	for (const b of document.querySelectorAll('[data-enable]')) {
		b.addEventListener('click', () => enable(b.dataset.enable));
	}
})();
