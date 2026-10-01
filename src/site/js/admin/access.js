(function () {
	const out = document.getElementById('oidc-out');
	const shown = document.getElementById('oidc-discovery');
	function esc(s) {
		const e = document.createElement('span');
		e.textContent = String(s == null ? '' : s);
		return e.innerHTML;
	}
	async function send(url, init) {
		const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, init || {}));
		if (res.status === 401) {
			window.location.href =
				'__CFW_LOGIN_PATH__?next=' + encodeURIComponent(location.pathname);
			return null;
		}
		const body = await res.json().catch(() => ({}));
		if (!res.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + res.status);
		return body;
	}
	document.getElementById('oidc-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		out.textContent = 'Saving...';
		try {
			const body = await send('/setup/oidc?action=save', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(new FormData(e.target)).toString()
			});
			if (!body) return;
			out.textContent = 'Saved.';
			const dd = body.discovery;
			shown.innerHTML = !dd
				? ''
				: dd.ok
					? '<div class="card"><strong>Discovery</strong><p class="sub" style="margin:.3rem 0 0">authorization <code>' +
						esc(dd.authorization) +
						'</code><br>token <code>' +
						esc(dd.token) +
						'</code><br>jwks <code>' +
						esc(dd.jwks) +
						'</code></p></div>'
					: '<div class="card bad"><strong>Discovery</strong><p class="sub" style="margin:.3rem 0 0"><span class="over">' +
						esc(dd.error) +
						'</span></p></div>';
			document.getElementById('oidc-clear').disabled = false;
		} catch (err) {
			out.textContent = 'Refused: ' + err.message;
		}
	});
	document.getElementById('oidc-clear').addEventListener('click', async () => {
		if (!window.confirm('Clear the issuer and client id? Single sign-on stops working.'))
			return;
		out.textContent = 'Clearing...';
		try {
			if (await send('/setup/oidc?action=clear')) window.location.reload();
		} catch (err) {
			out.textContent = 'Refused: ' + err.message;
		}
	});
})();
