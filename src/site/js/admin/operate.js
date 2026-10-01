(function () {
	const out = document.getElementById('operate-out');
	const pane = document.getElementById('operate-result');
	function show(data) {
		const pre = document.createElement('pre');
		pre.style.margin = '0';
		pre.style.overflowX = 'auto';
		pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
		const card = document.createElement('div');
		card.className = 'card';
		card.appendChild(pre);
		pane.replaceChildren(card);
	}
	async function ask(path, query) {
		const res = await fetch(path + (query ? '?' + query : ''), { credentials: 'same-origin' });
		if (res.status === 401) {
			window.location.href =
				'__CFW_LOGIN_PATH__?next=' + encodeURIComponent(location.pathname);
			return null;
		}
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch (e) {
			return text.slice(0, 4000);
		}
	}
	document.querySelectorAll('button[data-op]').forEach((b) => {
		b.addEventListener('click', async () => {
			if (
				b.dataset.writes === '1' &&
				!window.confirm(b.dataset.label + '? This changes the site.')
			)
				return;
			out.textContent = b.dataset.label + '...';
			try {
				const data = await ask(b.dataset.path, b.dataset.query);
				if (data === null) return;
				out.textContent = b.dataset.label + ': done';
				show(data);
			} catch (err) {
				out.textContent = 'Failed: ' + err.message;
			}
		});
	});
	document.getElementById('mailtest-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		const o = document.getElementById('mailtest-out');
		const to = String(new FormData(e.target).get('to') || '');
		if (!to) {
			o.textContent = 'Enter an address to send the test to.';
			return;
		}
		o.textContent = 'Sending...';
		try {
			const res = await fetch('/setup/mail?action=test&to=' + encodeURIComponent(to), {
				method: 'POST',
				credentials: 'same-origin'
			});
			const data = await res.json();
			const t = data.test || data;
			// the TRANSPORT either way: "which one refused" is the first thing an operator asks
			o.textContent = t.ok
				? 'Sent through ' +
					(t.transport || 'the configured transport') +
					' as ' +
					(t.from || '?') +
					'. Check the inbox; delivery is the proof, not this line.'
				: 'Refused' +
					(t.transport ? ' by ' + t.transport : '') +
					': ' +
					(t.error || 'no reason given');
		} catch (err) {
			o.textContent = 'Failed: ' + err.message;
		}
	});
	document.getElementById('restore-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		const o = document.getElementById('restore-out');
		const form = new FormData(e.target);
		if (form.get('confirm') !== 'replace') {
			o.textContent = 'Type the word replace to confirm, so this cannot happen by accident.';
			return;
		}
		const bookmark = String(form.get('bookmark') || '');
		if (!bookmark) {
			o.textContent = 'Paste a bookmark from Recovery Points above.';
			return;
		}
		o.textContent = 'Scheduling...';
		try {
			const res = await fetch('/pitr?bookmark=' + encodeURIComponent(bookmark), {
				method: 'POST',
				credentials: 'same-origin'
			});
			const data = await res.json();
			if (!data.ok) throw new Error(data.error || 'refused');
			// the undo exists ONLY in this reply; there is no second call that can produce it
			o.textContent =
				"Scheduled; it applies on this object's next start. Keep this undo bookmark, it is the only way back: " +
				(data.undo || 'none reported');
		} catch (err) {
			o.textContent = 'Failed: ' + err.message;
		}
	});
})();
