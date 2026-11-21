'use strict';
'require baseclass';
'require poll';
'require rpc';
'require ui';

const readRPC = rpc.declare({ object: 'calabi', method: 'read', params: ['operation'], reject: true });
const writeRPC = rpc.declare({ object: 'calabi', method: 'write', params: ['operation', 'id', 'data'], reject: true });

async function read(operation) {
	const result = await readRPC(operation).catch(() => null);
	return result?.ok ? result.data : null;
}

function status(text, connected) {
	return E('span', { class: 'calabi-pill ' + (connected ? 'calabi-pill--good' : 'calabi-pill--warn') }, [text]);
}

function dropdown(text, group, choices, parent, warning) {
	const root = E('details', { class: 'calabi-egress-dropdown', 'data-kind': group }, [
		E('summary', { class: 'calabi-context-chip' + (warning ? ' calabi-context-warn' : '') },
			[text, E('span', { class: 'calabi-egress-chevron', 'aria-hidden': 'true' })]),
		E('div', { class: 'calabi-egress-options' }, choices)
	]);
	root.addEventListener('toggle', () => {
		if (root.open)
			parent.querySelectorAll('.calabi-egress-dropdown[open]').forEach(other => { if (other !== root) other.open = false; });
	});
	root.addEventListener('focusout', event => {
		if (!root.contains(event.relatedTarget)) root.open = false;
	});
	root.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			root.open = false;
			root.querySelector('summary').focus();
		}
	});
	return root;
}

function confirmSwitch(title, operation, data) {
	const result = E('p', { class: 'calabi-setting-feedback', role: 'status' });
	const cancel = E('button', { type: 'button', class: 'btn', click: () => ui.hideModal() }, [_('Cancel')]);
	const submit = E('button', { type: 'button', class: 'btn cbi-button-action' }, [_('Switch edge')]);
	submit.addEventListener('click', async () => {
		submit.disabled = cancel.disabled = true;
		result.textContent = _('Switching…');
		try {
			const response = await writeRPC(operation, '', data);
			if (!response?.ok) throw new Error('switch rejected');
			result.textContent = _('Saved. Calabi is reconnecting.');
			setTimeout(() => window.location.reload(), 1200);
		} catch (err) {
			result.textContent = _('Could not change the edge selection. Check your permissions and connection.');
			submit.disabled = cancel.disabled = false;
		}
	});
	ui.showModal(title, [E('div', { class: 'calabi-dialog' }, [
		E('p', {}, [_('Calabi reconnects after switching. Active endpoints may be briefly interrupted.')]),
		result, E('div', { class: 'calabi-actions' }, [cancel, submit])
	])]);
}

function controls(root, directory, affinity, snapshot) {
	const items = directory.items || [];
	const current = items.find(edge => snapshot?.edge_node_id > 0 && String(edge.edge_node_id) === String(snapshot.edge_node_id));
	const hasOwnEdge = Number(directory.owned_total) > 0 || items.some(edge => edge.owned);
	const preferPlatform = affinity?.affinity === 'platform';
	const wantedOwn = hasOwnEdge && !preferPlatform;
	const ownOffline = wantedOwn && !items.some(edge => edge.owned && edge.healthy);
	const currentRegion = current?.region || snapshot?.preferred_region;
	const crossClass = hasOwnEdge && current && Boolean(current.owned) !== wantedOwn;
	const unavailable = snapshot?.lifecycle === 'unavailable';
	const writable = L.hasViewPermission() === true;
	const regions = new Map();
	for (const edge of items) {
		if (edge.region && (!hasOwnEdge || Boolean(edge.owned) === wantedOwn))
			regions.set(edge.region, regions.get(edge.region) || Boolean(edge.healthy));
	}
	if (currentRegion && !crossClass && !regions.has(currentRegion))
		regions.set(currentRegion, snapshot?.connected === true);

	function choice(label, selected, enabled, callback, detail) {
		const button = E('button', { type: 'button', class: 'calabi-egress-option', 'aria-current': selected ? 'true' : null }, [
			E('span', { class: 'calabi-egress-check', 'aria-hidden': 'true' }, [selected ? '✓' : '']),
			E('span', {}, [label]), detail || ''
		]);
		button.disabled = !enabled;
		if (enabled) button.addEventListener('click', () => {
			const menu = button.closest('details');
			menu.open = false;
			callback();
		});
		return button;
	}

	const toggles = [];
	if (affinity && hasOwnEdge) {
		const options = [['own', _('Self-hosted')], ['platform', _('Platform')]].map(([key, label]) =>
			choice(label, key === affinity.affinity, writable && key !== affinity.affinity, () =>
				confirmSwitch(_('Switch edge to %s?').format(label), 'edge_affinity_save', { affinity: key })));
		const label = wantedOwn ? _('Self-hosted edge') : _('Platform edge');
		toggles.push(dropdown(ownOffline ? label + ' · ' + _('Offline') : label, 'affinity', options, root, ownOffline));
	}
	if (affinity && (regions.size || currentRegion || hasOwnEdge)) {
		const options = Array.from(regions.keys()).sort().map(region =>
			choice(region, region === currentRegion, writable && (region !== currentRegion || unavailable),
				() => confirmSwitch(_('Connect to %s?').format(region), 'edge_region_save', { region }),
				status(regions.get(region) ? _('Online') : _('Offline'), regions.get(region))));
		if (!options.length)
			options.push(E('p', { class: 'calabi-egress-empty' }, [_('No matching regions')]));
		toggles.push(dropdown(currentRegion || _('Choose a region'), 'region', options, root, unavailable));
	}
	return toggles;
}

return baseclass.extend({
	render: function() {
		const root = E('div', { class: 'calabi-egress', hidden: '' });
		const info = E('div', { class: 'calabi-egress-identity' });
		const buttons = E('div', { class: 'calabi-egress-buttons' });
		root.append(info, buttons);
		Promise.all([read('identity'), read('health'), read('account')]).then(async ([identity, health, account]) => {
			const standalone = identity?.mode === 'self_hosted';
			const name = account?.org?.name || identity?.mesh?.server;
			const connection = E('span');
			if (name) info.append(E('span', { class: 'calabi-context-chip' }, [name]));
			if (health) {
				info.append(connection);
				connection.append(status(health.connected ? _('Online') : _('Disconnected'), health.connected));
			}
			root.hidden = !info.childElementCount;
			if (standalone || !identity || !account) return;
			const [directory, affinity, initial] = await Promise.all([
				read('edges'), read('edge_affinity'), read('overview_snapshot')
			]);
			if (!directory) return;
			let previous = '';
			function paint(snapshot) {
				if (!snapshot) return;
				const key = [snapshot.edge_node_id, snapshot.preferred_region, snapshot.connected, snapshot.lifecycle].join('|');
				if (key === previous) return;
				previous = key;
				connection.replaceChildren(status(snapshot.connected ? _('Online') : _('Disconnected'), snapshot.connected));
				buttons.replaceChildren(...controls(root, directory, affinity, snapshot));
			}
			paint(initial || { connected: health?.connected });
			poll.add(async () => {
				if (!root.querySelector('.calabi-egress-dropdown[open]'))
					paint(await read('overview_snapshot'));
			}, 5);
		});
		return root;
	}
});
