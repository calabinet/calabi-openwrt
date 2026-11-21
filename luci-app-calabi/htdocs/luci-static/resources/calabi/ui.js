'use strict';
'require baseclass';
'require calabi.dashboard as dashboard';
'require calabi.frame as frame';
'require fs';
'require poll';
'require rpc';
'require ui';
'require view';

const readRPC = rpc.declare({ object: 'calabi', method: 'read',
	params: [ 'operation', 'id', 'data' ], reject: true });
const writeRPC = rpc.declare({ object: 'calabi', method: 'write',
	params: [ 'operation', 'id', 'data' ], reject: true });
const opkgAccess = rpc.declare({ object: 'session', method: 'access',
	params: [ 'scope', 'object', 'function' ], expect: { access: false } });
const saveUpdatePolicy = rpc.declare({ object: 'calabi', method: 'update_policy_write', params: ['data'], reject: true });
const inspectRPC = rpc.declare({ object: 'calabi', method: 'inspect', params: ['operation', 'id', 'data'], reject: true });

const errors = {
	unsupported_operation: _('This operation is unavailable.'),
	bad_input: _('Check the values and try again.'),
	endpoint_not_local: _('Manage this endpoint in the web console or take it over first.'),
	bad_link: _('Enter a valid invitation link.'),
	untrusted: _('Compare the certificate fingerprint with the one shown by your coordinator.'),
	pin_mismatch: _('The server certificate differs from the trusted fingerprint.'),
	no_tls: _('The server does not offer TLS.'),
	key_refused: _('The server rejected this key.'),
	key_unverified: _('The platform could not verify the API key.'),
	configured: _('This device already has an identity.'),
	joined: _('This device is already connected to a self-hosted server.'),
	switching: _('Wait for Calabi to restart.'),
	identity_unmanaged: _('This identity is managed outside LuCI.'),
	save: _('Calabi could not save the configuration.'),
	network_unavailable: _('OpenWrt could not list its networks.'),
	unreachable: _('The coordinator is unreachable.'),
	disabled: _('The device or key is disabled.'),
	full: _('The server cannot accept another device.'),
	client_offline: _('Wait for this device to connect to the edge and try again.')
};

function explain(r) {
	return errors[r?.code] || ({
		401: _('The management session or device authorization expired.'),
		403: _('This account or API key lacks permission for the operation.'),
		404: _('The item or daemon interface is unavailable.'),
		409: _('The requested change conflicts with the current state.'),
		501: _('The installed core does not support this operation.'),
		502: _('The upstream service is unavailable.'),
		503: _('Calabi is starting, disconnected, or unavailable.')
	})[r?.status] || _('The request failed. Check the connection and try again.');
}

function read(op, id, data) {
	return readRPC(op, id || '', data || {}).catch(function() { return { ok: false, status: 403 }; });
}

function value(r, fallback) {
	return r?.ok ? r.data : (fallback || {});
}

function notice(message, style) {
	return E('div', { class: 'calabi-notice alert-message ' + (style || 'warning'), role: 'status' }, [message]);
}

function feedbackArea() {
	const element = E('div', { class: 'calabi-feedback', role: 'status', 'aria-atomic': 'true' });
	return {
		element,
		show(message, style) {
			if (!message) { element.replaceChildren(); return; }
			const banner = notice(message, style);
			banner.removeAttribute('role');
			element.replaceChildren(banner);
		}
	};
}

const operationFeedback = new WeakMap();

function actionFeedback(button) {
	const scope = button.closest('.calabi-dialog, .calabi-card, .calabi-authorization-card, .calabi-main');
	if (!scope) return () => {};
	let target = operationFeedback.get(scope);
	if (!target) {
		target = feedbackArea();
		scope.append(target.element);
		operationFeedback.set(scope, target);
	}
	return target.show;
}

function writable() {
	return L.hasViewPermission() === true;
}

function action(title, handler, css, enabled, feedback) {
	const button = E('button', { type: 'button', class: 'btn ' + (css || '') }, [title]);
	button.disabled = enabled === false || !writable();
	button.addEventListener('click', async function() {
		const report = feedback?.show || actionFeedback(button);
		button.disabled = true;
		report();
		try { await handler(report); }
		catch (e) { report(_('The operation failed or your LuCI session expired.'), 'danger'); }
		finally { button.disabled = enabled === false || !writable(); }
	});
	return button;
}

function write(op, data, id) {
	return writeRPC(op, id || '', data || {});
}

async function save(report, op, data, id, closeModal) {
	const r = await write(op, data, id);
	if (!r?.ok) {
		report(explain(r), 'danger');
		return false;
	}
	if (closeModal)
		ui.hideModal();
	window.location.reload();
	return true;
}

function section(title, elements, options = {}) {
	return E('section', { class: ['calabi-card', options.summary ? 'calabi-summary' : '', options.className].filter(Boolean).join(' ') }, [
		E('div', { class: 'calabi-card-header' }, [E('h3', {}, [title]), options.actions || '']),
		...elements
	]);
}

function metrics(entries) {
	return E('dl', { class: 'calabi-metrics' }, entries.map(([label, content]) =>
		E('div', {}, [E('dt', {}, [label]), E('dd', {}, [content || '—'])])));
}

function status(text, tone) {
	return E('span', { class: 'calabi-pill' + (tone ? ' calabi-pill--' + tone : '') }, [text]);
}

function field(label, input, help, button, feedback) {
	const id = 'calabi-field-' + (++field.seq);
	input.setAttribute('id', id);
	if (feedback) {
		feedback.id = id + '-feedback';
		input.setAttribute('aria-describedby', feedback.id);
	}
	return E('div', { class: 'calabi-field' }, [
		E('label', { for: id }, [label]),
		E('div', {}, [button ? E('div', { class: 'calabi-subnet-entry' }, [input, button]) : input,
			help ? E('div', { class: 'calabi-field-help' }, [help]) : '', feedback || ''])
	]);
}
field.seq = 0;

function text(initial, type, placeholder) {
	return E('input', { class: 'cbi-input-text', type: type || 'text', value: initial ?? '',
		autocomplete: type === 'password' ? 'new-password' : 'off', placeholder: placeholder || '' });
}

function lines(initial, placeholder) {
	return E('textarea', { class: 'cbi-input-textarea', rows: '3', placeholder: placeholder || '' },
		[(initial || []).join('\n')]);
}

function list(input) {
	return input.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function check(initial) {
	const input = E('input', { type: 'checkbox' });
	input.checked = initial === true;
	return input;
}

function select(choices, initial) {
	const input = E('select', { class: 'cbi-input-select' },
		choices.map(c => E('option', { value: c[0] }, [c[1]])));
	if (initial != null)
		input.value = initial;
	return input;
}

function table(headers, records) {
	const head = E('tr', {}, headers.map(h => E('th', { scope: 'col' }, [h])));
	const body = records.map(r => E('tr', {}, r.map(cell => E('td', {}, [cell || '—']))));
	return E('div', { class: 'calabi-table-wrap', tabindex: 0 }, [E('table', { class: 'calabi-table' }, [
		E('thead', {}, [head]), E('tbody', {}, body.length ? body : [
			E('tr', {}, [E('td', { class: 'calabi-empty', colspan: headers.length }, [_('No entries')])])
		])
	])]);
}

function actions(...items) {
	return E('div', { class: 'calabi-actions' }, items);
}

function modal(title, items, submit, caption) {
	ui.showModal(title, [E('div', { class: 'calabi-dialog' }, [...items, actions(
		E('button', { type: 'button', class: 'btn', click: () => ui.hideModal() }, [_('Cancel')]),
		action(caption || _('Save'), submit, 'cbi-button-action'))])]);
}

function https(report) {
	if (window.location.protocol === 'https:')
		return true;
	report(_('Open LuCI over HTTPS to submit credentials.'), 'warning');
	return false;
}

function fingerprintDialog(pin) {
	return window.confirm(_('Compare this fingerprint with the coordinator before confirming.') + '\n\n' + pin);
}

async function identityChange(report, op, data) {
	const response = await write(op, data);
	if (!response?.ok) {
		report(explain(response), 'danger');
		return;
	}
	report(_('Configuration accepted. Waiting for Calabi to restart.'), 'info');
	for (let n = 0; n < 18; n++) {
		await new Promise(resolve => setTimeout(resolve, 850));
		const fresh = await read('platform_identity');
		const state = value(fresh);
		if (state.change === 'failed') {
			report(_('Calabi could not save the identity. The previous configuration is active.'), 'danger');
			return;
		}
		if (fresh.ok && !!state.configured === (op !== 'platform_clear') &&
			(state.change === 'saved' || (!state.change && op !== 'platform_replace'))) {
			window.location.reload();
			return;
		}
	}
	report(_('Calabi has not reported the new identity yet. Refresh to check its status.'), 'warning');
}

function overview(health, identity, platform, account, data) {
	const info = value(identity), p = value(platform);
	const standalone = info.mode === 'self_hosted';
	const diagnostics = E('details', { class: 'calabi-diagnostics' }, [
		E('summary', {}, [_('Calabi diagnostics')]),
		table([_('Check'), _('Result')], [
			[_('Daemon'), health], [_('Device identity'), identity],
			...(!standalone ? [[_('Platform authorization'), platform]] : []),
			...(!standalone && p.configured ? [[_('Platform account'), account]] : [])
		].map(([label, result]) => [label, result.ok ? _('Available') : explain(result)]))
	]);
	const output = dashboard.render(data, info, value(health), value(account), (op, args) => read(op, '', args), diagnostics);
	if (!health.ok)
		output.push(notice(explain(health)));
	const meshState = { connected: _('Connected'), pending: _('Awaiting approval'), paused: _('Paused'),
		connecting: _('Connecting'), disabled: _('Disabled'), disconnected: _('Disconnected') };
	if (standalone && info.mesh?.state !== 'connected')
		output.push(notice(meshState[info.mesh?.state] || _('Check the coordinator connection.')));
	return output;
}

function automaticUpdates(result, allowed) {
	const data = value(result), policy = data.policy;
	if (!policy)
		return notice(_('Automatic update settings are unavailable.'));
	const forms = [
		['auto', _('Automatic updates')], ['security', _('Security updates only')], ['notify', _('Notify only')]
	].map(([mode, label]) => {
		const input = E('input', { type: 'radio', name: 'calabi-update-mode', value: mode });
		input.checked = policy.mode === mode;
		input.disabled = !allowed;
		return [input, E('label', { class: 'calabi-update-mode' }, [input, E('span', {}, [label])])];
	});
	const enabled = check(policy.window_start_hour !== policy.window_end_hour);
	enabled.disabled = !allowed;
	const hours = Array.from({ length: 24 }, (_, hour) => [String(hour), String(hour).padStart(2, '0') + ':00']);
	const start = select(hours, enabled.checked ? policy.window_start_hour : 3);
	const end = select(hours, enabled.checked ? policy.window_end_hour : 5);
	start.setAttribute('aria-label', _('Maintenance window start'));
	end.setAttribute('aria-label', _('Maintenance window end'));
	const deferDays = [...new Set([0, 1, 3, 7, 14, 30, 90, policy.max_defer_days])].sort((a, b) => a - b);
	const defer = select(deferDays.map(n => [String(n), n === 0 ? _('Immediately') : _('%d days').format(n)]), policy.max_defer_days);
	defer.disabled = !allowed;
	function toggleWindow() { start.disabled = end.disabled = !allowed || !enabled.checked; }
	enabled.addEventListener('change', toggleWindow);
	toggleWindow();
	const feedback = E('p', { class: 'calabi-setting-feedback', role: 'status' });
	const states = {
		up_to_date: _('The trusted feed offers no newer Calabi package.'),
		available: _('An update is available.'),
		ordinary_update: _('An ordinary update is available. It will wait for manual installation.'),
		waiting_window: _('Waiting for the maintenance window.'),
		waiting_idle: _('Waiting for traffic to become idle.'),
		check_failed: _('The automatic update check failed.'),
		install_failed: _('Automatic installation failed. Check the installed versions.'),
		installing: _('Installing an update…'),
		installed: _('The update was installed.')
	};
	const status = data.status && states[data.status];
	const button = E('button', { type: 'button', class: 'btn cbi-button-action' }, [_('Save update settings')]);
	button.disabled = !allowed;
	button.addEventListener('click', async () => {
		if (enabled.checked && start.value === end.value) {
			feedback.textContent = _('Choose different hours for the maintenance window.');
			return;
		}
		button.disabled = true;
		feedback.textContent = '';
		try {
			const updated = await saveUpdatePolicy({
				mode: forms.find(([input]) => input.checked)[0].value,
				window_start_hour: Number(start.value),
				window_end_hour: Number(enabled.checked ? end.value : start.value),
				max_defer_days: Number(defer.value)
			});
			if (!updated?.ok) throw new Error('save failed');
			feedback.textContent = _('Update settings saved.');
		} catch (err) {
			feedback.textContent = _('Could not save the update settings.');
		} finally {
			button.disabled = !allowed;
		}
	});
	return E('div', { class: 'calabi-update-policy' }, [
		E('fieldset', { class: 'calabi-update-modes' }, [
			E('legend', {}, [_('How this device updates')]),
			...forms.map(([, label]) => label)
		]),
		E('label', { class: 'calabi-update-window' }, [enabled, E('span', {}, [_('Use a maintenance window')])]),
		E('div', { class: 'calabi-update-hours' }, [
			E('div', { class: 'calabi-update-hours-range' }, [start, E('span', { 'aria-hidden': 'true' }, ['–']), end]),
			E('small', {}, [_('Router local time') + (data.timezone ? ' (' + data.timezone + ')' : '')])
		]),
		field(_('Maximum deferral'), defer, _('After this limit, an ordinary update in automatic mode installs even outside the window or while busy.')),
		E('p', { class: 'calabi-update-explanation' }, [_('Signed security updates can install immediately in automatic or security-only mode.')]),
		data.feed_ready ? (status ? E('p', { class: 'calabi-update-explanation' }, [status, data.candidate ? ' ' + data.candidate : '']) : '') :
			notice(_('Automatic updates need a configured Calabi feed and its signing key.')),
		actions(button), feedback
	]);
}

function updateSettings(versions, canViewPackages, canRefreshPackages, policy, canChangePolicy) {
	const packageURL = L.url('admin', 'system', 'opkg') + '?query=calabi';
	const listing = E('div');
	const feedback = E('p', { class: 'calabi-setting-feedback', role: 'status' });
	const openPackages = () => E('a', { class: 'btn', href: packageURL }, [_('Open software manager')]);
	function display(result, refreshed) {
		if (!result?.ok) {
			listing.replaceChildren(notice(_('Package versions are unavailable.')));
			feedback.textContent = '';
			return;
		}
		const packages = result.data;
		const rows = [
			[_('Calabi core'), packages.calabi],
			[_('LuCI plugin'), packages['luci-app-calabi']]
		];
		listing.replaceChildren(table([_('Component'), _('Installed version'), _('Available update')],
			rows.map(([label, pkg]) => [label, pkg?.installed, pkg?.available])));
		feedback.textContent = rows.some(([, pkg]) => pkg?.available) ? _('An update is available. Review it in the software manager.') :
			refreshed ? _('The configured software sources offer no newer Calabi package.') : '';
	}
	display(versions, false);
	const checkButton = E('button', { type: 'button', class: 'btn cbi-button-action' }, [_('Check for updates')]);
	checkButton.addEventListener('click', async () => {
		checkButton.disabled = true;
		feedback.textContent = _('Refreshing software sources…');
		try {
			const result = await fs.exec_direct('/usr/libexec/opkg-call', ['update', '--'], 'json');
			if (result?.code !== 0 || /signature check failed/i.test((result.stdout || '') + (result.stderr || '')))
				throw new Error('package list refresh failed');
			display(await read('package_versions'), true);
		} catch (err) {
			feedback.textContent = _('Could not refresh the software sources. Check the software manager.');
		} finally {
			checkButton.disabled = false;
		}
	});
	return section(_('Client updates'), [
		listing, feedback,
		actions(canRefreshPackages ? checkButton : '', canViewPackages ? openPackages() : ''),
		automaticUpdates(policy, canChangePolicy)
	]);
}

function identityPanels(identity, platform, onJoin) {
	const info = value(identity), p = value(platform), standalone = info.mode === 'self_hosted';
	const output = [];
	if (!writable() || !identity.ok)
		return output;
	const secure = window.location.protocol === 'https:';
	const credentialNotice = () => {
		const url = new URL(window.location.href);
		url.protocol = 'https:';
		url.port = '';
		return notice(E('a', { href: url.href }, [_('Open LuCI over HTTPS to submit credentials.')]));
	};
	if (!standalone && platform.ok && p.managed) {
		const key = text('', 'password');
		output.push(section(_('Platform API key'), [
			secure ? field(_('API Key'), key) : credentialNotice(),
			actions(secure ? action(p.configured ? _('Replace key') : _('Save key'), async report => {
				if (!https(report))
					return;
				const api_key = key.value.trim();
				key.value = '';
				if (!api_key) { report(_('Enter an API key.'), 'warning'); return; }
				if (!p.configured || window.confirm(_('Replace the device’s platform key and reconnect?')))
					await identityChange(report, p.configured ? 'platform_replace' : 'platform_setup', { api_key });
			}, 'cbi-button-action') : '',
			p.configured ? action(_('Clear platform configuration'), async report => {
				if (window.confirm(_('Disconnect platform endpoints and clear this device’s saved identity?')))
					await identityChange(report, 'platform_clear', {});
			}, 'cbi-button-negative') : '')
		]));
	} else if (!standalone && !platform.ok) {
		output.push(notice(_('Update the Calabi core to configure platform identity in LuCI.')));
	}
	if (!secure && info.can_join && (!p.configured || standalone))
		output.push(section(_('Connect to a self-hosted server'), [credentialNotice()]));
	if (secure && info.can_join && (!p.configured || standalone)) {
		const link = text('', 'password');
		const server = text('', 'text', 'server.example.com:7012');
		const key = text('', 'password');
		output.push(section(_('Connect to a self-hosted server'), [
			field(_('Invitation link'), link),
			field(_('Server address'), server, _('For manual setup, enter the server and join key.')),
			field(_('Join key'), key),
			action(_('Join'), async report => {
				if (!https(report)) return;
				const mesh = link.value.trim() ? { link: link.value.trim() } :
					{ server: server.value.trim(), key: key.value.trim() };
				if (!mesh.link && (!mesh.server || !mesh.key)) {
					report(_('Enter an invitation link or both server address and join key.'), 'warning');
					return;
				}
				link.value = key.value = '';
				if (standalone && !window.confirm(_('Replace the self-hosted connection?'))) return;
				let r = await write('join', { mesh, replace: standalone });
				if (r?.code === 'untrusted' && r.pin && fingerprintDialog(r.pin)) {
					mesh.pin = r.pin;
					r = await write('join', { mesh, replace: standalone });
				}
				if (r?.ok) {
					report(_('Configuration accepted. Waiting for Calabi to restart.'), 'info');
					if (onJoin) await onJoin(report);
					else setTimeout(() => window.location.reload(), 1200);
				} else report(explain(r), 'danger');
			}, 'cbi-button-action')
		]));
	}
	if (standalone && info.mesh?.cert_presented) {
		output.push(section(_('Coordinator certificate'), [
			E('p', {}, [info.mesh.cert_presented]),
			action(_('Confirm fingerprint'), report => {
				if (fingerprintDialog(info.mesh.cert_presented))
					return save(report, 'trust', { part: 'mesh', pin: info.mesh.cert_presented });
			})
		]));
	}
	if (standalone && info.can_leave)
		output.push(section(_('Self-hosted identity'), [
			action(_('Disconnect and forget'), report => {
				if (window.confirm(_('Forget this server and delete the local endpoints configured for it?')))
					return save(report, 'leave', {});
			}, 'cbi-button-negative')
		]));
	return output;
}

function settings(health, identity, platform, versions, canViewPackages, canRefreshPackages, policy, canChangePolicy) {
	return [
		updateSettings(versions, canViewPackages, canRefreshPackages, policy, canChangePolicy),
		...(!health.ok ? [notice(explain(health))] : []),
		...identityPanels(identity, platform)
	];
}

function peerOverlay(peer) {
	const prefix = (peer.allowed_ips || []).find(ip => /^100\.(6[4-9]|[78][0-9]|9[0-5])\.\d{1,3}\.\d{1,3}\/32$/.test(ip));
	return peer.overlay || prefix?.slice(0, -3) || '';
}

function peerTable(peers, nodes) {
	const presence = new Map(nodes.map(node => [node.overlay, node]));
	const enriched = peers.map(peer => {
		const ip = peerOverlay(peer);
		return [peer, ip, presence.get(ip)];
	});
	enriched.sort((a, b) => Number(b[2]?.online === true) - Number(a[2]?.online === true));
	const list = table([_('Peers'), _('Overlay IP'), _('Connection'), _('Traffic (RX / TX)'), _('Accessible subnets')], enriched.map(([peer, ip, node]) => {
		const os = ({ windows: 'Windows', darwin: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS' })[peer.os] || peer.os;
		const presenceKnown = typeof node?.online === 'boolean';
		const link = peer.path === 'direct' ? _('Direct') : peer.path === 'relay' ? _('Relay') : '';
		const rtt = peer.path === 'direct' ? peer.rtt_micros : peer.relay_rtt_micros;
		const delay = link && rtt > 0 ? ' · ' + (rtt / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ms' : '';
		const team = [os, node?.owner].filter(Boolean).join(' · ');
		const routes = [...new Set((peer.allowed_ips || []).filter(prefix =>
			prefix !== ip + '/32' && prefix !== '0.0.0.0/0' && prefix !== '::/0'))];
		return [
			E('div', { class: 'calabi-peer' }, [
				E('span', { class: 'calabi-peer-icon' + (peer.os === 'linux' ? ' calabi-peer-server' : ''), 'aria-hidden': 'true' }),
				E('div', {}, [
					E('div', { class: 'calabi-peer-name' }, [
						peer.name || ip || '—', presenceKnown ? status(node.online ? _('Online') : _('Offline'), node.online ? 'good' : '') : ''
					]),
					team ? E('small', {}, [team]) : ''
				])
			]),
			E('code', {}, [ip || '—']),
			presenceKnown && !node.online ? '—' : E('span', {
				title: peer.path === 'relay' && delay ? _('Latency to the relay') : null
			}, [link ? link + delay : '—']),
			E('span', { class: 'calabi-peer-traffic' }, [dashboard.formatBytes(peer.rx_bytes) + ' / ' + dashboard.formatBytes(peer.tx_bytes)]),
			routes.length ? E('div', { class: 'calabi-peer-subnets' }, routes.map(route => E('code', {}, [route]))) : '—'
		];
	}));
	list.classList.add('calabi-peer-table');
	return list;
}

function meshPage(initial, services, platform) {
	const svc = value(services).items || [];
	const statusPanel = E('div', { class: 'calabi-mesh-live', 'aria-live': 'polite' });
	const peersPanel = E('div');
	let lastStatus, lastPeers, refreshing;
	let presence = [], presenceTime = 0, presenceChecked = 0;

	function canReadPresence(m) {
		return platform && m.up && (!platform.org_id || !m.org_id || platform.org_id === m.org_id);
	}

	function update(mesh) {
		const m = value(mesh);
		const state = m.up ? _('Connected') : m.enrollment_error === 'device_limit' ? _('Device limit reached') :
			m.paused ? _('Paused') : m.enabled ? _('Connecting') : _('Disconnected');
		const current = JSON.stringify([mesh.ok, mesh.status, mesh.code, state, m.up, m.paused, m.enabled, m.name, m.overlay]);
		if (current !== lastStatus) {
			lastStatus = current;
			statusPanel.replaceChildren(section(_('Mesh status'), [
				mesh.ok ? metrics([
					[_('State'), status(state, m.up ? 'good' : 'warn')],
					[_('Device'), m.name], [_('Overlay address'), m.overlay]
				]) : notice(explain(mesh))
			], { summary: true, actions: actions(
				action(_('Enable mesh'), report => change('mesh_up', report), 'cbi-button-action', mesh.ok && (!m.enabled || m.paused)),
				action(_('Pause mesh'), report => change('mesh_down', report), '', m.enabled && !m.paused))
			}));
		}
		const peers = m.peers || [], nodes = canReadPresence(m) && Date.now() - presenceTime < 15000 ? presence : [];
		const revision = JSON.stringify([peers, nodes, mesh.ok]);
		if (revision !== lastPeers && !peersPanel.matches(':focus-within')) {
			lastPeers = revision;
			peersPanel.replaceChildren(section(_('Peers'), [mesh.ok ? peerTable(peers, nodes) : notice(explain(mesh))]));
		}
	}

	function refresh() {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			const mesh = await read('mesh');
			const m = value(mesh);
			update(mesh);
			if (canReadPresence(m) && Date.now() - presenceChecked >= 6000) {
				presenceChecked = Date.now();
				const nodes = await read('mesh_nodes');
				if (nodes.ok) {
					presence = value(nodes).items || [];
					presenceTime = Date.now();
					update(mesh);
				}
			}
		})().finally(() => { refreshing = null; });
		return refreshing;
	}

	async function change(op, report) {
		const r = await write(op, {});
		if (!r?.ok) { report(explain(r), 'danger'); return; }
		await refresh();
	}

	update(initial);
	poll.add(() => document.hidden ? null : refresh(), 3);
	const records = svc.map(s => [s.name, s.proto, String(s.port), s.target, s.approved ? _('Approved') : _('Pending'),
		s.health_checked ? (s.target_ok ? _('Reachable') : _('Unreachable')) : '—',
		action(_('Remove'), report => save(report, 'mesh_services_save', { items: svc.filter(row => row !== s) }), 'cbi-button-negative')]);
	return [
		statusPanel, peersPanel,
		section(_('Mesh services'), [services.ok ? table([_('Name'), _('Protocol'), _('Port'), _('Target'), _('Approval'), _('Health'), _('Actions')], records) : notice(explain(services))],
			{ actions: action(_('Declare mesh service'), () => {
				const name = text(), proto = select([['tcp', 'TCP'], ['udp', 'UDP']]), port = text('', 'number'), target = text('', 'text', '127.0.0.1:8080'), note = text();
				modal(_('Declare mesh service'), [field(_('Name'), name), field(_('Protocol'), proto),
					field(_('Port'), port), field(_('Target'), target), field(_('Note'), note)],
				report => save(report, 'mesh_services_save', { items: [...svc, { name: name.value, proto: proto.value,
					port: Number(port.value), target: target.value, note: note.value }] }, '', true));
			}, 'cbi-button-action', services.ok) })
	];
}

function subnetToggle(label, input, device) {
	return E('label', { class: 'calabi-subnet-toggle' }, [
		input, E('span', {}, [label]), device ? E('small', {}, [device]) : ''
	]);
}

function ipv4Prefix(input, minimumBits) {
	const match = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(?:\/([0-9]{1,2}))?$/.exec(input);
	if (!match)
		return null;
	const octets = match.slice(1, 5).map(Number);
	const bits = Number(match[5] ?? 32);
	if (octets.some(o => o > 255) || bits < minimumBits || bits > 32)
		return null;
	const mask = 0xffffffff << (32 - bits);
	const address = octets.reduce((acc, o) => (acc << 8) | o, 0) & mask;
	const cidr = [24, 16, 8, 0].map(shift => (address >>> shift) & 255).join('.') + '/' + bits;
	return { address, mask, cidr };
}

function subnetsPage(mesh, routes, firewall) {
	const d = value(routes), fw = value(firewall);
	let meshStatus = mesh, lastNetmap, revision, refreshing, statusGeneration = 0, reconnectUntil = 0;
	const excludes = lines(d.route_excludes);
	const subnetInput = text('', 'text', '192.168.11.0/24');
	const aliasInput = text('', 'text', '192.168.11.2');
	const accept = check(d.accept_routes), shield = check(d.block_incoming), advertiseExit = check(d.advertise_exit_node);
	const exit = text(d.exit_node);
	const selected = new Set(fw.selected || []);
	const offered = (fw.networks || []).filter(n => n.interface !== 'loopback');
	const choices = offered.map(n => [n.interface, check(selected.has(n.interface)), n.l3_device]);
	for (const n of selected)
		if (!choices.some(c => c[0] === n))
			choices.push([n, check(true), '']);
	const canEditRoutes = routes.ok && writable();
	const hasAliasAPI = Array.isArray(d.alias_hosts);
	const canRequestAlias = canEditRoutes && hasAliasAPI && d.alias_supported !== false;
	let declared = new Set(d.routes || []);
	let requested = new Set(d.alias_hosts || []);
	const subnets = new Set(declared), aliases = new Set(requested);
	const subnetList = E('div');
	const aliasList = E('div');
	const pending = E('p', { class: 'calabi-subnet-empty', role: 'status' });
	const subnetFeedback = feedbackArea(), aliasFeedback = feedbackArea();
	const saveFeedback = feedbackArea(), firewallFeedback = feedbackArea(), syncFeedback = feedbackArea();
	const publishedBefore = new Set();
	subnetInput.disabled = !canEditRoutes;
	aliasInput.disabled = !canRequestAlias;
	for (const input of [shield, accept, excludes, advertiseExit, exit])
		input.disabled = !canEditRoutes;
	for (const [, input] of choices)
		input.disabled = !firewall.ok || !writable();

	function covered(host) {
		const target = ipv4Prefix(host, 32);
		return target && [...subnets].some(cidr => {
			const subnet = ipv4Prefix(cidr, 24);
			return subnet && (target.address & subnet.mask) === subnet.address;
		});
	}

	function connectionStatus(result) {
		const m = value(result);
		if (!result.ok) return _('Mesh status unavailable');
		if (m.paused) return _('Paused');
		if (!m.up) return Date.now() < reconnectUntil ? _('Reconnecting to the mesh') : _('Disconnected');
		return m.netmap_seen ? null : _('Synchronizing approvals');
	}

	function renderOffers(changedMessage) {
		const unavailable = connectionStatus(meshStatus);
		const m = lastNetmap?.mesh || {};
		const published = new Set(m.published_routes || []);
		const mappings = new Map(m.aliases?.map(a => [a.real, a.alias]));
		const syncMessage = unavailable && lastNetmap ? unavailable + ' · ' + _('Showing the last synchronized results.') : unavailable;
		syncFeedback.show(routes.ok ? syncMessage : null, 'info');
		const remove = (label, removeEntry) => {
			const button = action(_('Delete'), removeEntry, 'cbi-button-remove', canEditRoutes);
			button.setAttribute('aria-label', _('Delete') + ' ' + label);
			return button;
		};
		const rows = [...subnets].map(cidr => [
			cidr,
			!declared.has(cidr) ? status(_('Pending save')) : lastNetmap?.subnets.has(cidr) ?
				(published.has(cidr) ? status(_('Published'), 'good') :
					status(publishedBefore.has(cidr) ? _('Not published') : _('Awaiting approval'), 'warn')) : null,
			declared.has(cidr) && lastNetmap?.subnets.has(cidr) ? mappings.get(cidr) : null,
			remove(cidr, () => {
				subnets.delete(cidr);
				publishedBefore.delete(cidr);
				const dependent = [...aliases].filter(host => !covered(host));
				dependent.forEach(host => aliases.delete(host));
				renderOffers(dependent.length ? _('Saving will also withdraw the stand-in requests covered only by the removed subnet.') : null);
				subnetInput.focus();
			})
		]);
		const hostRows = [...aliases].map(host => {
			const known = requested.has(host) && lastNetmap?.aliases.has(host);
			const alias = known ? mappings.get(host) : null;
			const waiting = !requested.has(host) ? status(_('Pending save')) : known ?
				status((m.unaliased_routes || []).includes(host) ? _('Alias unavailable') : _('Awaiting approval'), 'warn') : null;
			return [host.split('/')[0], alias || waiting, remove(host, () => {
				aliases.delete(host);
				renderOffers();
				(aliasInput.disabled ? subnetInput : aliasInput).focus();
			})];
		});
		subnetList.replaceChildren(table([_('Subnet'), _('State'), _('Alias'), _('Actions')], rows));
		aliasList.replaceChildren(table([_('Local address'), _('Alias'), _('Actions')], hostRows));
		if (changedMessage)
			pending.textContent = changedMessage;
		else if (!pending.textContent)
			pending.textContent = _('Save subnet settings to apply additions and deletions.');
	}

	function updateStatus(next) {
		const m = value(next);
		const unavailable = connectionStatus(next);
		const key = JSON.stringify([unavailable, m.published_routes, m.aliases, m.unaliased_routes]);
		if (key === revision || subnetList.matches(':focus-within') || aliasList.matches(':focus-within'))
			return;
		revision = key;
		meshStatus = next;
		if (!unavailable) {
			reconnectUntil = 0;
			lastNetmap = { mesh: m, subnets: new Set(declared), aliases: new Set(requested) };
			(m.published_routes || []).forEach(cidr => publishedBefore.add(cidr));
		}
		renderOffers();
	}

	function refreshStatus() {
		const generation = statusGeneration;
		if (refreshing?.generation === generation)
			return refreshing.result;
		const result = read('mesh').then(next => {
			if (statusGeneration === generation)
				updateStatus(next);
		}).finally(() => {
			if (refreshing?.result === result)
				refreshing = null;
		});
		refreshing = { generation, result };
		return result;
	}

	function stage(input, host) {
		const raw = input.value.trim();
		if (!raw)
			return true;
		const feedback = host ? aliasFeedback : subnetFeedback;
		const parsed = ipv4Prefix(raw, host ? 32 : 24);
		if (!parsed || (host && !covered(parsed.cidr))) {
			feedback.show(host ? _('Enter a single IPv4 address within a subnet listed above.') :
				_('Enter an IPv4 subnet from /24 to /32, or a single IPv4 address.'), 'danger');
			input.setAttribute('aria-invalid', 'true');
			input.focus();
			return false;
		}
		(host ? aliases : subnets).add(parsed.cidr);
		feedback.show();
		input.removeAttribute('aria-invalid');
		input.value = '';
		renderOffers();
		return true;
	}

	const addSubnet = action(_('Add'), () => stage(subnetInput, false), '', canEditRoutes, subnetFeedback);
	const addAlias = action(_('Add'), () => stage(aliasInput, true), '', canRequestAlias, aliasFeedback);
	for (const [input, button, feedback] of [[subnetInput, addSubnet, subnetFeedback], [aliasInput, addAlias, aliasFeedback]]) {
		input.addEventListener('input', () => {
			input.removeAttribute('aria-invalid');
			feedback.show();
		});
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				button.click();
			}
		});
	}
	updateStatus(mesh);
	if (routes.ok) {
		const refreshOpen = () => {
			if (!subnetList.isConnected) return poll.remove(refreshOpen);
			if (!document.hidden) return refreshStatus();
		};
		poll.add(refreshOpen, 3);
	}
	return [
		section(_('Receive on this device'), [
			routes.ok ? '' : notice(explain(routes)),
			E('div', { class: 'calabi-subnet-toggles' }, [
				subnetToggle(_('Block incoming mesh connections'), shield),
				subnetToggle(_('Accept subnet routes'), accept)
			]),
			field(_('Excluded routes'), excludes)
		], { className: 'calabi-subnet-receive' }),
		section(_('Offer to the network'), [
			syncFeedback.element,
			field(_('IPv4 subnets'), subnetInput, _('Add a subnet or a single IPv4 address. An administrator approves routes before publishing.'), addSubnet, subnetFeedback.element),
			routes.ok ? subnetList : '',
			field(_('Host alias requests'), aliasInput, !hasAliasAPI ? _('Update the Calabi core to request stand-in addresses.') :
				d.alias_supported === false ? _('This device cannot install stand-in address rules.') :
					_('Enter the IPv4 address of one host in a subnet above, add it, then save. An administrator approves the request.'), addAlias, aliasFeedback.element),
			hasAliasAPI ? aliasList : '',
			routes.ok ? pending : '',
			E('div', { class: 'calabi-subnet-toggles' }, [subnetToggle(_('Offer this device as an exit node'), advertiseExit)]),
			E('div', { class: 'calabi-subnet-firewall' }, [
				E('h4', {}, [_('OpenWrt firewall')]),
				firewall.ok && !fw.fw4_available ? notice(_('The Calabi fw4 rules are not loaded.')) : '',
				firewall.ok ? E('p', {}, [_('Select the OpenWrt networks that may receive traffic for approved subnets.')]) : notice(explain(firewall)),
				E('div', { class: 'calabi-subnet-toggles' }, choices.map(([name, input, device]) => subnetToggle(name, input, device))),
				actions(action(_('Save firewall networks'), async report => {
					const r = await write('firewall_save', { networks: choices.filter(c => c[1].checked).map(c => c[0]) });
					report(r?.ok ? _('Firewall networks saved.') : explain(r), r?.ok ? 'success' : 'danger');
				}, '', firewall.ok, firewallFeedback), firewallFeedback.element)
			])
		], { className: 'calabi-subnet-offer' }),
		section(_('Internet access from this device'), [
			field(_('Use exit device'), exit, _('Enter the peer name or overlay address.'))
		], { className: 'calabi-subnet-egress' }),
		actions(
			action(_('Save subnet settings'), async report => {
				if (!stage(subnetInput, false) || !stage(aliasInput, true))
					return;
				const sentSubnets = [...subnets], sentAliases = [...aliases];
				const result = await write('routes_save', { routes: sentSubnets, accept_routes: accept.checked,
					...(hasAliasAPI ? { alias_hosts: sentAliases } : {}),
					route_excludes: list(excludes), block_incoming: shield.checked, advertise_exit_node: advertiseExit.checked,
					exit_node: exit.value.trim() });
				if (!result?.ok) { report(explain(result), 'danger'); return; }
				declared = new Set(sentSubnets);
				requested = new Set(sentAliases);
				statusGeneration++;
				revision = undefined;
				reconnectUntil = Date.now() + 20_000;
				pending.textContent = '';
				meshStatus = { ok: true, data: { ...value(meshStatus), netmap_seen: false } };
				renderOffers();
				report(_('Subnet settings saved.'), 'success');
				await refreshStatus();
			}, 'cbi-button-action', canEditRoutes, saveFeedback), saveFeedback.element
		)
	];
}

function endpointHost(address) {
	if (!address) return '';
	if (address.startsWith('[')) return address.match(/^(\[[^\]]+\])(?::\d+)?$/)?.[1] || '';
	const parts = address.split(':');
	return parts.length > 2 ? '[' + address + ']' : parts[0];
}

function endpointAddress(row, edge, snapshot, useCurrentEdge) {
	if (row.domain) return row.domain;
	if (!(row.remote_port > 0)) return ['tcp', 'udp'].includes(row.type) ? _('Awaiting port assignment') : '—';
	const host = (useCurrentEdge ? endpointHost(snapshot.server_ip) || endpointHost(snapshot.server_addr) : '') ||
		endpointHost(edge?.public_addr) || edge?.base_domain || (useCurrentEdge ? snapshot.base_domain : '');
	return (host || '') + ':' + row.remote_port;
}

function endpointState(row) {
	const states = { enabled: _('Enabled'), disabled: _('Disabled'), admin_disabled: _('Disabled by administrator'),
		pending: _('Pending'), pending_review: _('Awaiting approval') };
	if (row.approval === 'pending')
		return status(_('Awaiting approval'), 'warn');
	const tone = ['pending', 'pending_review'].includes(row.status) ? 'warn' : row.status === 'enabled' ? 'good' : '';
	return status(states[row.status] || '—', tone);
}

function editEndpoint(row) {
	const name = text(row.name), target = text(row.local_addr, 'text', '127.0.0.1:8080');
	const result = E('span', { role: 'status' });
	let revision = 0;
	target.addEventListener('input', () => {
		revision++;
		result.replaceChildren();
	});
	const probe = action(_('Probe target'), async () => {
		const attempt = ++revision;
		result.textContent = _('Checking the local service…');
		const r = await write('probe', { local_addr: target.value.trim(), type: row.type }).catch(() => null);
		if (attempt !== revision || !result.isConnected) return;
		const healthy = r?.ok && r.data.healthy;
		const message = r?.ok ? (healthy ? _('Target is reachable.') : _('Target is unreachable from OpenWrt.')) : explain(r);
		result.replaceChildren(status(message, healthy ? 'good' : 'warn'));
	});
	const feedback = E('div', { class: 'calabi-edit-probe' }, [probe, result]);
	modal(_('Edit endpoint'), [field(_('Name'), name), field(_('Local address'), target, feedback)], report =>
		save(report, 'endpoint_edit', { name: name.value.trim(), local_addr: target.value.trim() }, row.id, true));
}

function endpointWizard(host, opts) {
	const { platform, account, snapshot, edges, domains, policies, org, totals } = opts;
	const features = account.features || {};
	const edge = edges.find(e => e.edge_node_id > 0 && String(e.edge_node_id) === String(snapshot.edge_node_id));
	const own = platform && edge?.owned === true;
	const base = snapshot.base_domain || edge?.base_domain || '';
	const parents = domains.filter(d => d.status === 'verified' &&
		(d.name || d.domain || '').toLowerCase() === base.toLowerCase());
	const paid = !platform || (account.plan?.code && account.plan.code !== 'free');
	const tls = platform ? own && edge.tls_passthrough && parents.length > 0 : snapshot.https_port > 0;
	const header = E('ol', { class: 'calabi-wizard-steps' });
	const body = E('div', { class: 'calabi-wizard-body' }), footer = actions();
	const panel = section(_('Create endpoint'), [header, body, footer], { className: 'calabi-endpoint-wizard' });
	const leave = () => { if (!submitting) window.location.reload(); };
	host.replaceChildren(panel);

	const name = text('', 'text', _('Endpoint name'));
	name.maxLength = 64;
	const target = text('127.0.0.1:8080');
	const kind = select([['http', 'HTTP'], ['https', 'HTTPS'], ['sni', 'TLS'], ['tcp', 'TCP'], ['udp', 'UDP']], 'http');
	kind.options[2].disabled = !tls;
	if (!tls) kind.options[2].textContent = _('TLS (requires a compatible edge and domain)');
	kind.options[3].disabled = platform && features.tcp === false;
	kind.options[4].disabled = platform && features.udp === false;
	const port = text('', 'number', _('Automatic'));
	port.min = 1024; port.max = 65535;
	const prefix = text('', 'text', 'myapp');
	prefix.maxLength = 63;
	const parent = select([['', _('Select a verified domain')], ...parents.map(d => [d.name || d.domain, d.name || d.domain])]);
	const external = E('div'), transportHint = E('p', { class: 'calabi-access-hint' });
	const checked = E('p', { role: 'status', class: 'calabi-wizard-message' });
	const error = E('p', { role: 'alert', class: 'calabi-wizard-message calabi-wizard-error' });
	const policyNames = [...new Set([org.default_ip_policy, ...policies.map(p => p.name)].filter(Boolean))];
	const mode = select([['none', _('Leave unconfigured')], ['policy', _('Follow an organization policy')], ['custom', _('Enter an allowlist')]]);
	mode.options[1].hidden = !policyNames.length;
	const policy = select([['', _('Select a policy')], ...policyNames.map(n => [n,
		n === org.default_ip_policy ? n + ' · ' + _('Organization default') : n])], org.default_ip_policy || '');
	if (policy.value) mode.value = 'policy';
	const allow = lines([], '203.0.113.0/24\n198.51.100.7');
	const userRows = E('div'), users = [];
	let submitting = false, probeRevision = 0;
	const isPort = () => ['tcp', 'udp'].includes(kind.value);
	const isBare = () => isPort() || kind.value === 'sni';
	const requiredIP = () => org.require_protection === true || (isBare() && org.require_bare_port_protection === true);
	const canIP = () => !platform || features.ip_policy === true || requiredIP();
	const canBasic = () => !isBare() && (!platform || features.basic_auth === true);

	function step(index, items, buttons) {
		error.textContent = '';
		header.replaceChildren(...[_('Endpoint settings'), _('Access control'), _('Complete')].map((label, i) =>
			E('li', i === index ? { 'aria-current': 'step' } : {}, [
				E('span', {}, [i < index ? '✓' : String(i + 1)]), label
			])));
		body.replaceChildren(...items, error);
		footer.replaceChildren(...buttons);
	}
	function report(message, control) {
		error.textContent = message;
		control?.focus();
		return false;
	}
	function validTarget() {
		const part = target.value.trim().match(/^(?:(?:\[[^\]\s]+\]|[^:\s/]+):)?(\d{1,5})$/)?.[1];
		return part && Number(part) > 0 && Number(part) <= 65535;
	}
	function endpointData() {
		const data = { name: name.value.trim(), type: kind.value, local_addr: target.value.trim() };
		if (!data.name) return report(_('Enter an endpoint name.'), name);
		if (!validTarget()) return report(_('Enter a valid port or host:port.'), target);
		if (isPort()) {
			if (!port.validity.valid) return report(_('Enter an external port between 1024 and 65535.'), port);
			if (port.value) data.remote_port = Number(port.value);
			return data;
		}
		if (own && !parent.value) return report(_('Select a verified domain for this edge.'), parent);
		const part = prefix.value.trim().toLowerCase();
		if ((!own && kind.value === 'sni' && !part) || (part && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))
			return report(_('Enter a valid subdomain prefix.'), prefix);
		if (own) {
			const selected = parents.find(d => (d.name || d.domain) === parent.value);
			if (!part && selected?.in_use) return report(_('This domain is already in use. Enter a prefix.'), prefix);
			data.domain = part ? part + '.' + parent.value : parent.value;
		} else if (paid && part) data.subdomain = part;
		return data;
	}
	function updateExternal() {
		const data = kind.value;
		prefix.disabled = !paid && !own;
		transportHint.textContent = data === 'https' ? _('OpenWrt connects to the local service over HTTPS.') :
			data === 'sni' ? _('TLS passes through to the local service, which provides its own certificate.') : '';
		const controls = E('div', { class: 'calabi-wizard-address' }, [prefix,
			own ? parent : base ? E('span', {}, ['.' + base]) : '']);
		prefix.setAttribute('aria-label', _('Subdomain prefix'));
		parent.setAttribute('aria-label', _('Custom domain'));
		external.replaceChildren(isPort()
			? field(_('External port'), port, _('Leave empty to assign automatically.'))
			: field(own || data === 'sni' ? _('Custom domain') : _('Subdomain prefix'), controls,
				own ? (parents.length ? _('Leave the prefix empty to use the domain itself.') : _('This edge has no verified domain.')) :
					!paid ? _('A subdomain is assigned automatically.') : data !== 'sni' ? _('Leave empty to assign automatically.') : ''));
	}
	async function probe(data) {
		const revision = ++probeRevision;
		checked.textContent = _('Checking the local service…');
		const result = await write('probe', { type: data.type, local_addr: data.local_addr }).catch(() => null);
		const message = result?.ok && result.data.healthy ?
			(result.data.latency_ms != null ? _('Local service reachable in %s ms.').format(result.data.latency_ms) : _('Target is reachable.')) :
			result?.ok ? _('Target is unreachable from OpenWrt.') : explain(result);
		if (revision === probeRevision) checked.textContent = message;
		return { ok: result?.ok && result.data.healthy, invalid: result?.data?.reason === 'invalid', message };
	}
	const checkService = action(_('Probe target'), () => validTarget() ?
		probe({ type: kind.value, local_addr: target.value.trim() }) : report(_('Enter a valid port or host:port.'), target));
	for (const control of [kind, target]) {
		control.addEventListener('input', () => { ++probeRevision; checked.textContent = ''; error.textContent = ''; });
	}
	kind.addEventListener('change', updateExternal);
	function settings() {
		updateExternal();
		const service = E('div', { class: 'calabi-wizard-service' }, [kind, target, checkService]);
		kind.setAttribute('aria-label', _('Protocol'));
		target.setAttribute('aria-label', _('Local address'));
		step(0, [field(_('Name'), name), field(_('Local service'), service), transportHint, checked, external,
			totals.team_total > 0 ? E('p', { class: 'calabi-access-hint' }, [_('Organization endpoints: %s').format(totals.team_total)]) : ''
		], [action(_('Cancel'), leave), action(_('Next'), () => { if (endpointData()) protection(); }, 'cbi-button-action')]);
	}
	function addUser() {
		const pair = [text('', 'text', _('Username')), text('', 'password', _('Password'))];
		pair[0].setAttribute('aria-label', _('Username'));
		pair[1].setAttribute('aria-label', _('Password'));
		users.push(pair);
		const row = E('div', { class: 'calabi-access-pair' }, [...pair, action(_('Delete'), () => {
			users.splice(users.indexOf(pair), 1);
			row.remove();
		}, 'cbi-button-negative')]);
		userRows.append(row);
	}
	const rules = E('div');
	function showRules() {
		rules.replaceChildren(mode.value === 'policy' ? field(_('Organization IP policy'), policy) :
			mode.value === 'custom' ? field(_('Allowlist'), allow) : '');
	}
	mode.addEventListener('change', showRules);
	function protection() {
		mode.options[0].disabled = requiredIP();
		if (requiredIP() && mode.value === 'none') {
			mode.value = policyNames.length ? 'policy' : 'custom';
			if (policyNames.length) policy.value = policyNames[0];
		}
		showRules();
		step(1, [E('p', { class: 'calabi-access-hint' }, [requiredIP()
			? _('The organization requires access protection for this endpoint.')
			: _('Choose who can access this endpoint. You can change these settings later.')]),
			canIP() ? field(_('IP access control'), mode) : E('p', {}, [_('IP access control is unavailable for this account.')]), canIP() ? rules : '',
			canBasic() ? E('section', {}, [E('h4', {}, [_('Basic authentication')]), userRows,
				action('+ ' + _('Add user'), addUser)]) : isBare() ? E('p', { class: 'calabi-access-hint' }, [_('Basic authentication applies to HTTP/HTTPS endpoints.')]) : ''
		], [action(_('Previous step'), () => { if (!submitting) settings(); }), action(_('Create'), submit, 'cbi-button-action')]);
	}
	async function submit() {
		const data = endpointData();
		if (!data) return;
		const security = {};
		const addresses = canIP() && mode.value === 'custom' ? list(allow) : [];
		if (canIP() && mode.value === 'policy') {
			if (!policy.value) return report(_('Select a policy'), policy);
			security.ip = { from_policy: policy.value };
		}
		if (canIP() && mode.value === 'custom') {
			if (!addresses.length) return report(_('Enter at least one IP address or CIDR.'), allow);
			security.ip = { allow: addresses };
		}
		if (canBasic()) {
			const entries = users.map(([u, p]) => ({ user: u.value.trim(), password: p.value }));
			if (entries.some(u => Boolean(u.user) !== Boolean(u.password))) return report(_('Enter both the username and password.'));
			const complete = entries.filter(u => u.user && u.password);
			if (complete.length) security.basic_auth = { users: complete };
		}
		if (requiredIP() && !security.ip?.from_policy && !(addresses.length && !addresses.some(a => /\/0+$/.test(a))) && !security.basic_auth)
			return report(_('Choose a rule that restricts access before creating this endpoint.'));
		if (security.basic_auth && !https(message => report(message))) return;
		if (Object.keys(security).length) data.security = security;
		submitting = true;
		error.textContent = '';
		try {
			const result = await probe(data);
			if (result.invalid) {
				settings();
				return report(_('Use the address of a local or LAN service.'), target);
			}
			if (!panel.isConnected || (!result.ok && !window.confirm(result.message + '\n\n' +
				_('Create the endpoint anyway? You can start the local service later.')))) return;
			const response = await write('endpoint_create', data);
			if (!response?.ok) return report(explain(response));
			for (const [, password] of users) password.value = '';
			const protection = [
				security.ip?.from_policy || (security.ip?.allow?.length ? _('Custom addresses') : ''),
				security.basic_auth ? _('Basic authentication') : ''
			].filter(Boolean).join(' · ');
			complete({ ...data, ...response.data, security: undefined }, protection);
		} finally {
			submitting = false;
		}
	}
	function complete(created, protection) {
		const result = E('div', { class: 'calabi-wizard-result', 'aria-live': 'polite' });
		const retry = action(_('Keep waiting'), watch);
		let current = created, currentSnapshot = snapshot;
		const ready = () => current.edge_node_id > 0 || (!platform &&
			(currentSnapshot.tunnels || []).some(t => String(t.tunnel_id) === String(current.id) && t.proxy_id && !t.pending));
		function show(state) {
			const heading = { done: _('Endpoint created'), waiting: _('Endpoint created · waiting for address'), approval: _('Endpoint created · awaiting approval'),
				timeout: _('Endpoint created · address still unassigned'), missing: _('The created endpoint could not be found') };
			let address = endpointAddress(current, edge, currentSnapshot, true);
			if (current.domain && ['http', 'https'].includes(current.type)) {
				const secure = platform || currentSnapshot.https_port > 0;
				const listener = secure ? currentSnapshot.https_port : currentSnapshot.http_port;
				const standard = secure ? 443 : 80;
				address = (secure ? 'https://' : 'http://') + address +
					(!platform && listener > 0 && listener !== standard ? ':' + listener : '');
			}
			const ext = current.domain || current.remote_port > 0 ? address : _('Awaiting address');
			result.replaceChildren(E('h3', {}, [heading[state]]), metrics([
				[_('Name'), current.name], [_('Protocol'), current.type === 'sni' ? 'TLS' : current.type.toUpperCase()],
				[_('Local address'), current.local_addr], [_('External address'), ext],
				[_('Access control'), protection || _('Leave unconfigured')]
			]), state === 'timeout' ? retry : '');
		}
		async function watch() {
			if (ready()) return show('done');
			if (current.approval === 'pending' || current.status === 'pending_review') return show('approval');
			if (!created.id) return show('timeout');
			show('waiting');
			for (let attempt = 0; attempt < 16 && result.isConnected; attempt++) {
				await new Promise(resolve => window.setTimeout(resolve, 1500));
				if (!result.isConnected) return;
				const [r, snap] = await Promise.all([read('endpoint', created.id), platform ? null : read('overview_snapshot')]);
				if (!result.isConnected) return;
				if (r.status === 404) return show('missing');
				if (r.ok) current = { ...current, ...r.data };
				if (snap?.ok) currentSnapshot = snap.data;
				if (ready()) return show('done');
				if (current.approval === 'pending' || current.status === 'pending_review') return show('approval');
			}
			if (result.isConnected) show('timeout');
		}
		step(2, [result], [action(_('Create another endpoint'), () => endpointWizard(host, opts)), action(_('Back to endpoints'), leave, 'cbi-button-action')]);
		void watch();
	}
	settings();
}

function takeoverEndpoint(row) {
	const target = text(row.local_addr, 'text', '127.0.0.1:8080');
	modal(_('Take over endpoint: %s').format(row.name), [
		notice(_('This OpenWrt device will serve the endpoint. The previous client will stop serving it, and existing connections may be briefly interrupted.')),
		field(_('Local address'), target, _('Enter the address of the service reachable from this OpenWrt device.'))
	], report => {
		const address = target.value.trim();
		const port = address.match(/^(?:(?:\[[^\]\s]+\]|[^:\s]+):)?(\d{1,5})$/)?.[1];
		if (!port || Number(port) < 1 || Number(port) > 65535) {
			report(_('Enter a valid port or host:port.'), 'warning');
			target.focus();
			return;
		}
		return save(report, 'endpoint_takeover', { local_addr: address }, row.id, true);
	}, _('Take over'));
}

function accessControl(row, account, ipPolicies, oauthPolicies) {
	const features = value(account).features || {};
	const opts = [
		['ip', _('IP access control'), _('Allow or deny by source IP or CIDR, one entry per line. Rules are enforced at the edge.')],
		['basic_auth', _('Basic authentication'), _('Visitors must enter a username and password. Passwords are stored as hashes.')],
		['rate_limit', _('Connection rate limits'), _('Limit new connections to protect the upstream service. Zero or blank means unlimited.')],
		['request_headers', _('Request header rewriting'), _('Rewrite headers forwarded upstream. Protocol headers such as Content-Length cannot be changed.')],
		['oauth', _('OAuth sign-in'), _('Require visitors to sign in with an identity provider.')]
	];
	const flag = { ip: 'ip_policy', basic_auth: 'basic_auth', rate_limit: 'rate_limit', request_headers: 'header_rewrite', oauth: 'oauth' };
	const barePort = ['tcp', 'udp', 'sni'].includes(row.type);
	const applicable = opts.filter(([key]) => !barePort || ['ip', 'rate_limit'].includes(key));
	const stored = { ip: Object.keys(row.ip || {}).length, basic_auth: row.basic_users?.length,
		rate_limit: Object.keys(row.rate_limit || {}).length, request_headers: row.header_names?.length || row.remove_headers?.length,
		oauth: Object.keys(row.oauth || {}).length };
	const hint = message => E('p', { class: 'calabi-access-hint' }, [message]);
	function editor(which, label, description) {
		const fields = E('div');
		let encode;
		if (which === 'ip') {
			const storedPolicy = row.ip?.from_policy || '';
			const choices = ipPolicies.filter(p => p.name).map(p => [p.name, p.name + ' · ' + ((p.allow?.length || 0) + (p.deny?.length || 0))]);
			if (storedPolicy && !ipPolicies.some(p => p.name === storedPolicy)) choices.push([storedPolicy, storedPolicy]);
			const policy = select([['', _('Custom addresses')], ...choices], storedPolicy);
			const allow = lines(row.ip?.allow, '203.0.113.0/24\n198.51.100.7'), deny = lines(row.ip?.deny, '192.0.2.0/24');
			deny.rows = 2;
			const follow = E('div', { class: 'calabi-field-help' });
			const source = field(_('Address source'), policy);
			source.lastElementChild.append(follow);
			fields.replaceChildren(choices.length ? source : '', field(_('Allowlist — only these addresses may connect (blank allows all)'), allow),
				field(_('Denylist — always blocked, even if allowlisted'), deny));
			let custom = storedPolicy ? ['', ''] : [allow.value, deny.value];
			function showAddresses() {
				const name = policy.value;
				const selected = ipPolicies.find(p => p.name === name) || (name && name === storedPolicy ? row.ip : null);
				if (!allow.readOnly) custom = [allow.value, deny.value];
				allow.readOnly = deny.readOnly = Boolean(name);
				[allow.value, deny.value] = name ? [(selected?.allow || []).join('\n'), (selected?.deny || []).join('\n')] : custom;
				follow.textContent = name ? _('Follows organization policy “%s” and updates automatically when the policy changes.').format(name) : '';
				follow.hidden = !name;
			}
			allow.readOnly = Boolean(storedPolicy);
			policy.addEventListener('change', showAddresses);
			showAddresses();
			encode = () => policy.value ? { from_policy: policy.value } :
				(list(allow).length || list(deny).length ? { allow: list(allow), deny: list(deny) } : null);
		} else if (which === 'basic_auth') {
			const entries = E('div'), secrets = [];
			function add(user) {
				const n = text(user, 'text', _('Username'));
				const p = text('', 'password', user ? _('Leave blank to keep the current password') : _('Password'));
				n.setAttribute('aria-label', _('Username'));
				p.setAttribute('aria-label', _('Password'));
				const pair = [n, p];
				secrets.push(pair);
				const entry = E('div', { class: 'calabi-access-pair' }, [n, p,
					action(_('Delete'), () => {
						secrets.splice(secrets.indexOf(pair), 1);
						entry.remove();
					}, 'cbi-button-negative')]);
				entries.append(entry);
			}
			(row.basic_users || []).forEach(u => add(u.user));
			fields.replaceChildren(entries, action('+ ' + _('Add user'), () => add('')));
			encode = () => {
				const users = secrets.filter(pair => pair[0].value.trim() || pair[1].value).map(pair => ({
					user: pair[0].value.trim(), password: pair[1].value }));
				return users.length ? { users } : null;
			};
		} else if (which === 'rate_limit') {
			const all = text(row.rate_limit?.per_minute || '', 'number', _('e.g. 600'));
			const perIP = text(row.rate_limit?.per_ip_per_minute || '', 'number', _('e.g. 600'));
			for (const input of [all, perIP]) input.min = '0';
			const suggest = hint(_('A per-IP limit can prevent one source from using the entire endpoint allowance.'));
			function showRateHint() { suggest.hidden = !(Number(all.value) > 0 && !Number(perIP.value)); }
			for (const input of [all, perIP]) input.addEventListener('input', showRateHint);
			showRateHint();
			const rates = [_('per minute (entire endpoint)'), _('per minute (per source IP)')].map((unit, i) => {
				const input = [all, perIP][i];
				input.id = 'calabi-field-' + (++field.seq);
				return E('div', { class: 'calabi-access-rate' }, [input, E('label', { for: input.id }, [unit])]);
			});
			fields.replaceChildren(...rates, suggest);
			encode = () => Number(all.value || 0) || Number(perIP.value || 0) ?
				{ per_minute: Number(all.value || 0), per_ip_per_minute: Number(perIP.value || 0) } : null;
		} else if (which === 'request_headers') {
			const headerRows = [], entries = E('div'), remove = lines(row.remove_headers, 'X-Powered-By\nCookie');
			remove.rows = 2;
			function addHeader(saved) {
				const name = text(saved, 'text', _('Header name'));
				const value = text('', 'password', saved ? _('Leave blank to keep the saved value') : _('Header value'));
				name.setAttribute('aria-label', _('Header name'));
				value.setAttribute('aria-label', _('Header value'));
				const row = [name, value, saved];
				headerRows.push(row);
				const entry = E('div', { class: 'calabi-access-pair' }, [name, value,
					action(_('Delete'), () => { headerRows.splice(headerRows.indexOf(row), 1); entry.remove(); }, 'cbi-button-negative')
				]);
				entries.append(entry);
			}
			(row.header_names || []).forEach(addHeader);
			fields.replaceChildren(hint(_('Set or add headers, replacing any existing values')), entries,
				action('+ ' + _('Add header'), () => addHeader('')), field(_('Remove headers, one name per line'), remove));
			encode = () => {
				const set = Object.fromEntries(headerRows.filter(([name]) => name.value.trim()).map(([name, value, saved]) =>
					[name.value.trim(), name.value.trim() === saved && !value.value ? null : value.value]));
				return Object.keys(set).length || list(remove).length ? { set, remove: list(remove) } : null;
			};
		} else {
			const oauth = row.oauth || {}, savedPolicy = oauth.from_policy || '';
			const policies = oauthPolicies.filter(p => p.name);
			const savedProvider = oauth.provider || policies.find(p => p.name === savedPolicy)?.provider || '';
			const provider = select([['', _('Provider (off)')], ['google', 'Google'], ['github', 'GitHub']], savedProvider);
			const policy = select([]);
			const id = text(oauth.client_id, 'text', _('Client ID'));
			const secret = text('', 'password', oauth.client_secret_set ? _('Leave blank to keep the saved secret.') : _('Client secret'));
			const emails = lines(oauth.allow_emails, 'alice@example.com'), domains = lines(oauth.allow_domains, 'example.com');
			emails.rows = domains.rows = 2;
			const follow = hint('');
			const source = field(_('Organization OAuth policy'), policy);
			const custom = E('div', {}, [field(_('Client ID'), id), field(_('Client secret'), secret),
				field(_('Allowed email addresses (one per line, blank allows any signed-in user)'), emails),
				field(_('Allowed email domains (one per line)'), domains)]);
			const callback = row.domain && E('div', { class: 'calabi-access-callback' }, [
				hint(_('Register this callback URL in your OAuth application.')),
				E('code', {}, ['https://' + row.domain + '/__calabi/oauth/callback'])
			]);
			const body = E('div', {}, [callback || '', source, follow, custom]);
			fields.replaceChildren(field(_('Provider'), provider), body);
			function showOAuth() {
				body.hidden = !provider.value && !policy.value;
				custom.hidden = Boolean(policy.value) || !provider.value;
				follow.hidden = !policy.value;
				follow.textContent = policy.value ? _('Provider, Client ID and access rules follow organization policy “%s”.').format(policy.value) : '';
			}
			function updatePolicies(name) {
				const matching = policies.filter(p => p.provider === provider.value || !p.provider);
				const choices = matching.map(p => [p.name, [p.name, p.provider].filter(Boolean).join(' · ')]);
				if (name && !matching.some(p => p.name === name)) choices.push([name, name]);
				policy.replaceChildren(...[['', _('Configure this endpoint')], ...choices].map(([v, title]) => E('option', { value: v }, [title])));
				policy.value = name;
				source.hidden = !choices.length;
				showOAuth();
			}
			provider.addEventListener('change', () => updatePolicies(''));
			policy.addEventListener('change', showOAuth);
			updatePolicies(savedPolicy);
			encode = () => policy.value ? { from_policy: policy.value } : provider.value ? { provider: provider.value, client_id: id.value.trim(),
				client_secret: secret.value, allow_emails: list(emails), allow_domains: list(domains) } : null;
		}
		const initial = JSON.stringify(encode());
		return {
			which, encode, initial,
			node: E('section', { class: 'calabi-access-section' }, [
				E('h4', {}, [label]), hint(description), fields
			])
		};
	}
	const panels = [], savedLocked = [];
	const locked = applicable.filter(([key]) => features[flag[key]] !== true);
	const items = [
		!account.ok ? notice(explain(account)) : '',
		account.ok && locked.length ? notice(_('Unavailable for the current account or client: %s.').format(locked.map(([, label]) => label).join(', '))) : '',
		...locked.filter(([key]) => stored[key] && account.ok).map(([which, label]) => {
			const remove = check(false);
			savedLocked.push({ which, remove });
			return field(_('Remove saved %s').format(label), remove);
		}),
		barePort ? hint(_('%s endpoints forward raw bytes and support IP access control and connection rate limits. Basic authentication, OAuth and header rewriting apply to HTTP/HTTPS endpoints.').format(row.type === 'sni' ? 'TLS' : row.type.toUpperCase())) : '',
		...applicable.map(([which, label, description]) => {
			if (features[flag[which]] !== true) return '';
			const panel = editor(which, label, description);
			panels.push(panel);
			return panel.node;
		}),
		hint(_('Saved rules take effect immediately at the edge, without reconnecting.'))
	];
	const submit = action(_('Save'), report => {
		const changes = {};
		for (const panel of panels) {
			const next = panel.encode();
			if (JSON.stringify(next) !== panel.initial) changes[panel.which] = next;
		}
		for (const panel of savedLocked)
			if (panel.remove.checked) changes[panel.which] = null;
		if (!Object.keys(changes).length) { ui.hideModal(); return; }
		if (Object.entries(changes).some(([key, val]) => val && ['basic_auth', 'oauth', 'request_headers'].includes(key)) && !https(report)) return;
		return save(report, 'endpoint_protection', { changes }, row.id, true);
	}, 'cbi-button-action', panels.length + savedLocked.length > 0);
	endpointModal(_('Access control: %s').format(row.name), items, submit, 'calabi-access-modal');
}

function endpointModal(title, items, primary, className = '') {
	const content = E('div', { class: 'calabi-dialog calabi-endpoint-modal ' + className }, [
		E('div', { class: 'calabi-endpoint-modal-body' }, items),
		actions(E('button', { type: 'button', class: 'btn', click: () => ui.hideModal() }, [primary ? _('Cancel') : _('Close')]), primary || '')
	]);
	ui.showModal(title, [content]);
	return content;
}

function requestTime(value) {
	return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
}

function requestDetails(item) {
	function block(title, headers, body) {
		const entries = Object.entries(headers || {});
		return E('section', { class: 'calabi-access-section' }, [
			E('h4', {}, [title]),
			entries.length ? table([_('Name'), _('Value')], entries) : '',
			body ? E('pre', {}, [body]) : E('p', {}, [_('No captured body')])
		]);
	}
	return [
		block(_('Request headers and body'), item.request_headers, item.request_body),
		block(_('Response headers and body'), item.response_headers, item.response_body)
	];
}

function viewRequests(row) {
	let kind = 'captures', busy = false, revision;
	const body = E('div', { class: 'calabi-request-results', 'aria-live': 'polite' });
	const tabs = [['captures', _('HTTP requests')], ['connections', _('Connection records')]].map(([key, title]) =>
		E('button', { type: 'button', class: 'btn', click: () => {
			kind = key;
			tabs.forEach((tab, i) => tab.setAttribute('aria-pressed', String(i === Number(key === 'connections'))));
			refresh();
		}}, [title]));
	tabs[0].setAttribute('aria-pressed', 'true');
	const refreshButton = E('button', { type: 'button', class: 'btn', click: () => refresh() }, [_('Refresh')]);
	const root = endpointModal(_('Requests: %s').format(row.name), [actions(...tabs, refreshButton), body]);
	async function readCapture(op, data) {
		return inspectRPC(op, String(row.id), data || {}).catch(() => ({ ok: false, status: 403 }));
	}
	async function refresh() {
		if (busy) return;
		busy = refreshButton.disabled = true;
		const tab = kind;
		try {
			const result = await readCapture(tab);
			if (!root.isConnected) return;
			if (kind !== tab) return;
			const current = JSON.stringify([tab, result]);
			if (current === revision) return;
			revision = current;
			if (!result?.ok) {
				body.replaceChildren(notice(explain(result)));
				return;
			}
			const items = result.data.items || [];
			body.replaceChildren(tab === 'connections' ?
				table([_('Time'), _('Visitor IP'), _('Duration'), _('Traffic (RX / TX)')], items.map(item => [
					requestTime(item.started_at), item.visitor_ip, item.duration_ms == null ? '—' : item.duration_ms + ' ms',
					dashboard.formatBytes(item.bytes_in) + ' / ' + dashboard.formatBytes(item.bytes_out)
				])) : items.length ? E('div', {}, items.map(item => {
					const detail = E('div', { class: 'calabi-request-detail' });
					const entry = E('details', { class: 'calabi-request' }, [
						E('summary', {}, [
							status(String(item.response_status || '—'), item.failed || item.response_status >= 400 ? 'warn' : 'good'),
							E('strong', {}, [item.method || '—']), E('code', {}, [item.path || '/']),
							E('small', {}, [[requestTime(item.started_at), item.duration_ms == null ? '' : item.duration_ms + ' ms'].filter(Boolean).join(' · ')])
						]), detail
					]);
					entry.addEventListener('toggle', async () => {
						if (!entry.open || detail.childNodes.length) return;
						if (window.location.protocol !== 'https:') {
							detail.replaceChildren(notice(_('Open LuCI over HTTPS to view captured headers and bodies.')));
							return;
						}
						detail.replaceChildren(E('p', {}, [_('Loading…')]));
						const capture = await readCapture('capture', { capture_id: String(item.id) });
						detail.replaceChildren(...(capture.ok ? requestDetails(capture.data) : [notice(explain(capture))]));
					});
					return entry;
				})) : E('p', {}, [_('No HTTP requests have been captured for this endpoint.')]));
		} finally {
			busy = refreshButton.disabled = false;
			if (kind !== tab && root.isConnected) refresh();
		}
	}
	refresh();
	function refreshOpen() {
		if (!root.isConnected) return poll.remove(refreshOpen);
		if (!document.hidden && !body.querySelector('details[open]')) return refresh();
	}
	poll.add(refreshOpen, 5);
}

function endpointsPage(tunnels, initialHealth, account, identity, edges, domains, ipPolicies, oauthPolicies, initialSnapshot, canInspect, orgSecurity) {
	const a = value(account), platform = value(identity).mode !== 'self_hosted';
	const manages = !platform || (a.scopes || []).includes('tunnel.write');
	const myDevice = value(tunnels).my_device_id;
	const edge = value(initialSnapshot).edge_node_id;
	const pools = value(edges).items || [], hosts = value(domains).items || [];
	const edgesByID = new Map(pools.map(item => [String(item.edge_node_id), item]));
	const liveRows = new Map();
	const records = (value(tunnels).items || []).map(row => {
		const enabled = row.status !== 'disabled';
		const healthCell = E('span', { class: 'calabi-endpoint-health' });
		const addressCell = E('span', { class: 'calabi-endpoint-address' });
		const trafficCell = E('span', { class: 'calabi-endpoint-traffic' });
		const inspect = E('button', { type: 'button', class: 'btn', click: () => viewRequests(row) }, [_('View requests')]);
		const offMachine = myDevice > 0 && row.client_id > 0 && String(row.client_id) !== String(myDevice);
		const canEdit = manages && (!platform || (myDevice > 0 && String(row.client_id) === String(myDevice)));
		function editAction(label, handler, style) {
			const button = action(label, handler, style, canEdit);
			if (!button.disabled) return button;
			const reason = manages && writable() ? _('Manage this endpoint in the web console or take it over first.') :
				_('This account or API key lacks permission for the operation.');
			return E('span', { class: 'calabi-disabled-action', title: reason }, [button]);
		}
		let takeover = '';
		if (platform && manages && offMachine && row.created_by_me === true) {
			const crossEdge = row.edge_node_id > 0 && edge > 0 && String(row.edge_node_id) !== String(edge);
			takeover = action(_('Take over'), () => takeoverEndpoint(row), '', !crossEdge);
			if (crossEdge)
				takeover.title = _('Switch to the endpoint’s edge before taking it over to keep its external address.');
		}
		liveRows.set(String(row.id), { row, addressCell, healthCell, trafficCell, inspect,
			enabled: enabled && !row.disabled_by_admin && row.status !== 'admin_disabled', healthSignature: '' });
		return [row.name, row.type?.toUpperCase(), row.local_addr, addressCell,
			endpointState(row),
			healthCell, trafficCell,
			actions(editAction(_('Edit'), () => editEndpoint(row)),
				!enabled && !row.disabled_by_admin ? editAction(_('Enable'), report => save(report, 'endpoint_state', { enabled: true }, row.id)) : '',
				takeover,
				editAction(_('Access control'), () => accessControl(row, account, value(ipPolicies).items || [], value(oauthPolicies).items || [])),
				canInspect ? inspect : '',
				editAction(_('Delete'), report => {
					if (window.confirm(_('Delete endpoint') + ' ' + row.name + '?')) return save(report, 'endpoint_delete', {}, row.id);
				}, 'cbi-button-negative'))];
	});
	function updateHealth(health, snapshot) {
		const current = value(snapshot);
		const probes = new Map((value(health).items || []).map(p => [p.proxy_id, p]));
		const local = new Map((current.tunnels || []).filter(t => t.proxy_id && !t.pending).map(t => [String(t.tunnel_id), t]));
		for (const [id, entry] of liveRows) {
			const active = local.get(id), proxy = active?.proxy_id, probe = probes.get(proxy);
			const rowEdge = entry.row.edge_node_id;
			const useCurrentEdge = !platform || (rowEdge > 0 && current.edge_node_id > 0 ?
				String(rowEdge) === String(current.edge_node_id) : Boolean(active) || (myDevice > 0 && String(entry.row.client_id) === String(myDevice)));
			const address = endpointAddress(entry.row, edgesByID.get(String(rowEdge)), current, useCurrentEdge);
			if (entry.addressCell.textContent !== address) entry.addressCell.textContent = address;
			const counters = [active?.bytes_in, active?.bytes_out];
			const trafficSignature = counters.join('|');
			if (entry.trafficSignature !== trafficSignature) {
				entry.trafficSignature = trafficSignature;
				entry.trafficCell.replaceChildren(...(counters.some(n => n != null) ? [
					E('span', { 'aria-label': _('Received') }, ['↓ ' + dashboard.formatBytes(counters[0])]),
					E('span', { 'aria-label': _('Sent') }, ['↑ ' + dashboard.formatBytes(counters[1])])
				] : ['—']));
			}
			entry.inspect.disabled = !proxy;
			entry.inspect.title = proxy ? '' : _('Requests are available while this endpoint runs on this device.');
			const label = !entry.enabled ? _('Disabled') : !snapshot.ok || !health.ok ? _('Health data unavailable') :
				!proxy ? _('Not running on this device') : health.data?.enabled === false ? _('Health checks disabled') :
				!probe ? _('Waiting for health check') : probe.healthy ? _('Reachable') : _('Unreachable');
			const tone = probe ? (probe.healthy ? 'good' : 'danger') : '';
			const signature = [label, tone, probe?.latency_ms].join('|');
			if (signature === entry.healthSignature) continue;
			entry.healthSignature = signature;
			entry.healthCell.replaceChildren(status(label, tone));
			if (probe?.healthy && probe.latency_ms != null)
				entry.healthCell.append(E('small', {}, [probe.latency_ms + ' ms']));
		}
	}
	updateHealth(initialHealth, initialSnapshot);
	if (liveRows.size) {
		poll.add(async () => {
			if (document.hidden) return;
			const [health, snapshot] = await Promise.all([read('endpoint_health'), read('overview_snapshot')]);
			updateHealth(health, snapshot);
		}, 5);
	}
	const host = E('div');
	host.append(section(_('Endpoints'), [
		tunnels.ok ? table([_('Name'), _('Protocol'), _('Local address'), _('External address'), _('State'), _('Health'), _('Traffic'), _('Actions')], records) : notice(explain(tunnels))
	], { actions: action(_('Create endpoint'), async () => {
		const result = await read('overview_snapshot');
		endpointWizard(host, { platform, account: a, snapshot: value(result, value(initialSnapshot)), edges: pools, domains: hosts,
			policies: value(ipPolicies).items || [], org: value(orgSecurity), totals: value(tunnels) });
	}, 'cbi-button-action', tunnels.ok && manages) }));
	return [host];
}

async function authorization() {
	const identity = await read('identity');
	const info = value(identity);
	if (info.mode === 'self_hosted')
		return { identity, platform: null, ready: true, authorized: Boolean(info.mesh?.server) };
	const platform = await read('platform_identity');
	return { identity, platform, ready: identity.ok && platform.ok,
		authorized: info.mode === 'platform' && value(platform).configured === true };
}

function authorizationPage(id, gate) {
	const retry = E('button', { type: 'button', class: 'btn', click: () => window.location.reload() }, [_('Check authorization again')]);
	const forms = gate.ready ? identityPanels(gate.identity, gate.platform, async report => {
		for (let attempt = 0; attempt < 18; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 850));
			if ((await authorization()).authorized) {
				window.location.reload();
				return;
			}
		}
		report(_('Calabi has not reported the new identity yet. Refresh to check its status.'), 'warning');
	}) : [];
	const buttons = forms.map(form => E('button', { type: 'button', class: 'btn', click: () => choose(form) },
		[form.querySelector('h3').textContent]));
	function choose(form) {
		forms.forEach((panel, i) => {
			panel.hidden = panel !== form;
			buttons[i].setAttribute('aria-pressed', String(panel === form));
		});
	}
	if (forms.length > 1)
		choose(forms[0]);
	return frame.render(id, [E('div', { class: 'calabi-authorization-card' }, [
		E('h2', {}, [_('Authorize Calabi')]),
		E('p', {}, [!gate.ready ? _('Could not read Calabi authorization. Check that the Calabi service is running.') :
			forms.length ? _('Choose how to connect this device.') : _('Contact a LuCI administrator to authorize this device.')]),
		forms.length > 1 ? actions(...buttons) : '',
		...forms,
		actions(retry)
	])], false);
}

function page(id, loads, render) {
	return view.extend({
		load: async function() {
			frame.prepare();
			const gate = await authorization();
			const values = gate.authorized ? await (typeof loads === 'function' ? loads(gate) :
				Promise.all(loads.map(op => read(op)))) : [];
			return { gate, values };
		},
		render: function({ gate, values }) { return gate.authorized ? frame.render(id, render(...values)) : authorizationPage(id, gate); },
		handleSave: null, handleSaveApply: null, handleReset: null
	});
}

return baseclass.extend({
	guardedPage: page,
	overview: () => page('overview', ({ identity, platform }) => Promise.all([
		read('health'), identity, platform, read('account'),
		dashboard.load((op, args) => read(op, '', args), value(identity).mode === 'self_hosted')
	]), overview),
	mesh: () => page('mesh', ({ platform }) => Promise.all([
		read('mesh'), read('mesh_services'), platform?.ok ? value(platform) : null
	]), meshPage),
	subnets: () => page('subnets', ['mesh', 'routes', 'firewall'], subnetsPage),
	endpoints: () => page('endpoints', ({ identity }) => Promise.all([
		read('endpoints'), read('endpoint_health'), read('account'), identity, read('edges'), read('domains'),
		read('ip_policies'), read('oauth_policies'), read('overview_snapshot'),
		opkgAccess('ubus', 'calabi', 'inspect').catch(() => false),
		value(identity).mode === 'self_hosted' ? null : read('org_security')
	]), endpointsPage),
	settings: () => page('settings', ({ identity, platform }) => Promise.all([
		read('health'), identity, platform, read('package_versions'),
		opkgAccess('access-group', 'luci-app-opkg', 'read').catch(() => false),
		opkgAccess('file', '/usr/libexec/opkg-call update --', 'exec').catch(() => false),
		read('update_policy'),
		opkgAccess('ubus', 'calabi', 'update_policy_write').catch(() => false)
	]), settings)
});
