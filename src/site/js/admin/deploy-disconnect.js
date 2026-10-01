document.getElementById('cfdisconnect').addEventListener('click', async () => {
	const out = document.getElementById('cfdisconnect-out');
	out.textContent = 'Disconnecting...';
	try {
		const res = await fetch('/setup/cf?action=disconnect', { credentials: 'same-origin' });
		const data = await res.json();
		if (!data.ok) throw new Error(data.error || 'refused');
		out.textContent = data.revoked
			? 'Disconnected and revoked at Cloudflare.'
			: 'Disconnected here; Cloudflare did not confirm the revocation, so revoke it in your dashboard too.';
		setTimeout(() => window.location.reload(), 1200);
	} catch (err) {
		out.textContent = 'Could not disconnect: ' + err.message;
	}
});
