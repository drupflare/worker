document.getElementById('cfoauth').addEventListener('submit', async (e) => {
	e.preventDefault();
	const out = document.getElementById('cfoauth-out');
	const id = new FormData(e.target).get('client_id');
	if (!id) {
		out.textContent = 'Enter the client ID from your OAuth client.';
		return;
	}
	out.textContent = 'Starting...';
	try {
		const res = await fetch('/setup/cf?action=connect&client_id=' + encodeURIComponent(id), {
			credentials: 'same-origin'
		});
		const data = await res.json();
		if (!data.ok) throw new Error(data.error || 'refused');
		window.location.href = data.authorizeUrl;
	} catch (err) {
		out.textContent = 'Could not start: ' + err.message;
	}
});
