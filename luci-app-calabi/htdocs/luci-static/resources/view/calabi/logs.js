'use strict';
'require calabi.ui as calabi';
'require poll';
'require rpc';

const getLogs = rpc.declare({
	object: 'calabi', method: 'read', params: [ 'operation' ], reject: true
});

function readLogs() {
	return getLogs('logs').catch(() => null);
}

function formatLog(entry) {
	const time = new Date(entry.time);
	const pad = value => String(value).padStart(2, '0');
	const stamp = isNaN(time) ? '—' : time.getFullYear() + '/' + pad(time.getMonth() + 1) + '/' +
		pad(time.getDate()) + ' ' + pad(time.getHours()) + ':' + pad(time.getMinutes()) + ':' + pad(time.getSeconds());
	return stamp + '  ' + entry.level.toUpperCase() + '  ' + entry.message;
}

return calabi.guardedPage('logs', async () => [await readLogs()], function(initial) {
	const filter = E('input', { class: 'cbi-input-text', type: 'search', id: 'calabi-log-search' });
	const levels = E('select', { class: 'cbi-input-select', id: 'calabi-log-level' },
		[['', _('All levels')], ['debug', _('Debug')], ['info', _('Info')],
			['warn', _('Warning')], ['error', _('Error')]].map(([value, label]) =>
			E('option', { value }, [label])));
	const refreshButton = E('button', { type: 'button', class: 'btn' }, [_('Refresh')]);
	const auto = E('input', { type: 'checkbox' });
	auto.checked = true;
	const feedback = E('p', { class: 'calabi-log-feedback', role: 'status' });
	const output = E('textarea', {
		class: 'calabi-log-output', readonly: '', wrap: 'off', 'aria-label': _('Logs')
	});
	let entries = [], available = false, refreshing = false;

	function update() {
		const query = filter.value.trim().toLowerCase();
		const lines = entries.filter(entry => (!levels.value || entry.level === levels.value))
			.map(formatLog).filter(line => line.toLowerCase().includes(query));
		const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
		const previousScroll = output.scrollTop;
		const next = lines.join('\n');
		if (output.value !== next) {
			output.value = next;
			output.scrollTop = follow ? output.scrollHeight : previousScroll;
		}
		feedback.textContent = !available ? _('Logs are temporarily unavailable.') : lines.length ?
			_('%d entries').format(lines.length) : entries.length ?
				_('No logs match your filters.') : _('No logs have been recorded.');
	}

	function accept(result) {
		available = result?.ok === true && Array.isArray(result.data?.lines);
		if (available)
			entries = result.data.lines;
		update();
	}

	async function refresh() {
		if (refreshing) return;
		refreshing = refreshButton.disabled = true;
		try {
			accept(await readLogs());
		} finally {
			refreshing = refreshButton.disabled = false;
		}
	}

	filter.addEventListener('input', update);
	levels.addEventListener('change', update);
	refreshButton.addEventListener('click', refresh);
	accept(initial);
	requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; });
	poll.add(() => auto.checked ? refresh() : null, 5);
	return [
		E('section', { class: 'calabi-card' }, [
			E('div', { class: 'calabi-log-toolbar' }, [
				E('label', { class: 'calabi-log-filter calabi-log-search', for: 'calabi-log-search' }, [_('Search logs'), filter]),
				E('label', { class: 'calabi-log-filter', for: 'calabi-log-level' }, [_('Log level'), levels]),
				refreshButton, E('label', { class: 'calabi-log-auto' }, [auto, _('Auto-refresh')])
			]),
			feedback, output
		])
	];
});
