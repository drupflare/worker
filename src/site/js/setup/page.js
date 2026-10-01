document.getElementById('f').addEventListener('submit', async (e) => {
	e.preventDefault();
	const form = e.target;
	const button = form.querySelector('button');
	const out = document.getElementById('o');
	const body = {};
	for (const [k, v] of new FormData(form)) if (v) body[k] = v;
	button.disabled = true;
	out.textContent = 'Claiming...';
	try {
		const res = await fetch('/firstrun', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = await res.json();
		if (!data.ok) throw new Error(data.error || 'refused');
		// a password the visitor typed is one they already have, so it is not shown back
		const chose = Boolean(body.adminPass);
		const creds = [['Username', 'admin']];
		if (data.adminPass) creds.push(['Password', data.adminPass]);
		if (data.ownerToken) creds.push(['Owner Token', data.ownerToken]);
		out.textContent = '';
		const say = (tag, text, cls) => {
			const el = document.createElement(tag);
			el.textContent = text;
			if (cls) el.className = cls;
			out.appendChild(el);
			return el;
		};
		say('h2', 'Claimed');
		if (data.ownerToken || data.adminPass) {
			say(
				'p',
				(data.ownerToken ? 'The owner token' : 'The password') +
					' is shown once, on this page, and this site cannot show it again. ' +
					(data.ownerToken
						? 'It reaches the site when Drupal itself is broken, so store it somewhere other than this site.'
						: ''),
				'alert'
			);
		}
		for (const [name, value] of creds) {
			const row = document.createElement('div');
			row.className = 'cred';
			const label = document.createElement('label');
			label.textContent = name;
			const input = document.createElement('input');
			input.readOnly = true;
			input.value = value;
			label.appendChild(input);
			const copy = document.createElement('button');
			copy.type = 'button';
			copy.textContent = 'Copy';
			copy.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(value);
				} catch {
					input.select();
					document.execCommand('copy');
				}
				copy.textContent = 'Copied';
			});
			row.append(label, copy);
			out.appendChild(row);
		}
		if (chose) say('p', 'Password: the one you just entered.', 'warn');
		const save = document.createElement('button');
		save.type = 'button';
		save.textContent = 'Download as Text';
		save.addEventListener('click', () => {
			const text =
				creds.map(([n, v]) => n + ': ' + v).join('\n') +
				'\nsite: ' +
				location.origin +
				'\n';
			const a = document.createElement('a');
			a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
			a.download = location.hostname + '-credentials.txt';
			a.click();
		});
		out.appendChild(save);
		const go = document.createElement('p');
		const login = document.createElement('a');
		login.href = '/user/login';
		login.textContent = 'Log in as admin';
		go.appendChild(login);
		if (data.ownerToken) {
			// nothing leaves this page until the visitor says the token is somewhere else
			login.className = 'off';
			const ack = document.createElement('label');
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.style.display = 'inline';
			box.style.width = 'auto';
			box.addEventListener('change', () => {
				login.className = box.checked ? '' : 'off';
			});
			ack.append(box, ' I have stored the owner token');
			out.appendChild(ack);
		}
		out.appendChild(go);
	} catch (err) {
		button.disabled = false;
		out.textContent = 'Could not claim this site: ' + err.message;
	}
});
