const out = document.getElementById('git-out');
const detail = document.getElementById('git-detail');
function esc(s) {
	const d = document.createElement('span');
	d.textContent = String(s == null ? '' : s);
	return d.innerHTML;
}
// the session cookie rides on a same-origin fetch, so nothing here holds the token
async function call(params) {
	const res = await fetch('/git?' + new URLSearchParams(params), { credentials: 'same-origin' });
	if (res.status === 401) {
		window.location.href = '__CFW_LOGIN_PATH__?next=' + encodeURIComponent(location.pathname);
		return;
	}
	const data = await res.json();
	if (!data.ok) throw new Error(data.error || 'refused');
	return data;
}
function showChanges(data) {
	const c = data.counts || {};
	const head =
		'<h2>' +
		esc(String(data.sha || '').slice(0, 12)) +
		'</h2>' +
		'<p class="sub">+' +
		(c.added || 0) +
		' added, ~' +
		(c.modified || 0) +
		' modified, -' +
		(c.removed || 0) +
		' removed, ' +
		(c.unchanged || 0) +
		' unchanged. ' +
		(data.rowsWritten || 0) +
		' rows would be written.</p>';
	const conflicts = (data.conflicts || []).length
		? '<p class="sub"><strong>' +
			data.conflicts.length +
			' conflicting path(s):</strong> ' +
			data.conflicts
				.map(function (x) {
					return esc(x.path) + ' (owned by ' + esc(x.owner) + ')';
				})
				.join(', ') +
			'</p>'
		: '';
	const mods = (data.modules || []).length
		? '<p class="sub">Modules: ' +
			data.modules
				.map(function (m) {
					return '<code>' + esc(m.name) + '</code> (' + esc(m.type) + ')';
				})
				.join(', ') +
			'</p>'
		: '';
	const rows = (data.changes || [])
		.filter(function (ch) {
			return ch.kind !== 'unchanged';
		})
		.map(function (ch) {
			return (
				'<tr><td><code>' +
				esc(ch.path) +
				'</code></td><td>' +
				esc(ch.kind) +
				'</td>' +
				'<td class="dim">+' +
				(ch.added || 0) +
				' / -' +
				(ch.removed || 0) +
				'</td></tr>'
			);
		})
		.join('');
	detail.innerHTML =
		'<div class="card">' +
		head +
		mods +
		conflicts +
		(rows
			? '<table><thead><tr><th>File</th><th>Change</th><th>Lines</th></tr></thead><tbody>' +
				rows +
				'</tbody></table>'
			: '<p class="sub">No file differs.</p>') +
		'</div>';
}
function showPulls(data, id) {
	const rows = (data.pulls || [])
		.map(function (p) {
			return (
				'<tr><td>#' +
				esc(p.id) +
				'</td><td>' +
				esc(p.title) +
				'</td><td><code>' +
				esc(p.branch) +
				'</code> &rarr; <code>' +
				esc(p.target) +
				'</code></td><td>' +
				esc(p.author) +
				(p.draft ? ' <em>draft</em>' : '') +
				'</td><td><button data-preview="' +
				esc(p.id) +
				'" data-id="' +
				esc(id) +
				'">Preview</button></td></tr>'
			);
		})
		.join('');
	detail.innerHTML =
		'<div class="card"><h2>Open Requests</h2>' +
		(rows
			? '<table><thead><tr><th>#</th><th>Title</th><th>Branch</th><th>Author</th><th></th></tr></thead><tbody>' +
				rows +
				'</tbody></table>'
			: '<p class="sub">Nothing open.</p>') +
		'<p class="sub">A preview installs that request\'s head instead of the branch. Polling and pushes are held until you leave it.</p></div>';
	detail.querySelectorAll('button[data-preview]').forEach(function (b) {
		b.addEventListener('click', async function () {
			out.textContent = 'Previewing #' + b.dataset.preview + '...';
			try {
				const res = await call({
					action: 'preview',
					id: b.dataset.id,
					pr: b.dataset.preview
				});
				out.textContent = 'Previewing #' + b.dataset.preview + '.';
				showChanges(res);
			} catch (err) {
				out.textContent = 'Failed: ' + err.message;
			}
		});
	});
}
document.getElementById('git-add').addEventListener('submit', async (e) => {
	e.preventDefault();
	const f = new FormData(e.target);
	if (!f.get('repo')) {
		out.textContent = 'A repository is needed.';
		return;
	}
	if (!f.get('token') && f.get('provider') !== 'generic') {
		out.textContent = 'That provider needs an access token.';
		return;
	}
	out.textContent = 'Connecting...';
	try {
		const data = await call({
			action: 'add',
			provider: f.get('provider'),
			repo: f.get('repo'),
			branch: f.get('branch') || '',
			token: f.get('token') || '',
			email: f.get('email') || '',
			username: f.get('username') || '',
			interval: f.get('interval') || '60'
		});
		out.textContent = 'Connected ' + data.repo + ' at ' + (data.head || 'unknown') + '.';
		window.location.reload();
	} catch (err) {
		out.textContent = 'Could not connect: ' + err.message;
	}
});
document.querySelectorAll('select[data-branch]').forEach((s) => {
	s.addEventListener('focus', async () => {
		if (s.dataset.loaded) return;
		try {
			const data = await call({ action: 'branches', id: s.dataset.branch });
			s.dataset.loaded = '1';
			data.branches.forEach(function (b) {
				const o = document.createElement('option');
				o.value = b;
				o.textContent = b + (b === data.current ? ' (current)' : '');
				s.appendChild(o);
			});
		} catch (err) {
			out.textContent = 'Could not list branches: ' + err.message;
		}
	});
	s.addEventListener('change', async () => {
		if (!s.value) return;
		out.textContent = 'Switching to ' + s.value + '...';
		try {
			const data = await call({ action: 'switch', id: s.dataset.branch, branch: s.value });
			showChanges(data);
			window.location.reload();
		} catch (err) {
			out.textContent = 'Could not switch: ' + err.message;
		}
	});
});
document.querySelectorAll('input[data-interval]').forEach((i) => {
	i.addEventListener('change', async () => {
		try {
			const data = await call({
				action: 'interval',
				id: i.dataset.interval,
				minutes: i.value
			});
			out.textContent = data.message;
		} catch (err) {
			out.textContent = 'Failed: ' + err.message;
		}
	});
});
document.querySelectorAll('button[data-act]').forEach((b) => {
	b.addEventListener('click', async () => {
		if (
			b.dataset.act === 'remove' &&
			!window.confirm('Disconnect ' + b.dataset.id + '? Its files stay installed.')
		)
			return;
		out.textContent = b.dataset.act + '...';
		try {
			// A PLAIN REMOTE HAS NO API TO REGISTER A HOOK THROUGH, and this page told the operator
			// to press this button anyway: action=hook is refused with 400 for a non-API provider,
			// and hooksecret -- the manual path the prose describes -- had no caller anywhere.
			const action =
				b.dataset.act === 'hook' && b.dataset.provider === 'generic'
					? 'hooksecret'
					: b.dataset.act;
			const data = await call({ action, id: b.dataset.id });
			if (
				b.dataset.act === 'diff' ||
				b.dataset.act === 'pull' ||
				b.dataset.act === 'unpreview'
			) {
				showChanges(data);
				out.textContent = data.applied === false && data.rolledBack ? data.error : 'done';
				return;
			}
			if (b.dataset.act === 'prs') {
				showPulls(data, b.dataset.id);
				out.textContent = 'done';
				return;
			}
			if (b.dataset.act === 'hook') {
				out.textContent = data.secret
					? 'Add this delivery URL and secret to your host. URL: ' +
						data.deliverTo +
						'  Secret: ' +
						data.secret
					: data.message + ' Delivery URL: ' + data.deliverTo;
				return;
			}
			out.textContent = data.message || 'done';
			if (b.dataset.act === 'remove') window.location.reload();
		} catch (err) {
			out.textContent = 'Failed: ' + err.message;
		}
	});
});
