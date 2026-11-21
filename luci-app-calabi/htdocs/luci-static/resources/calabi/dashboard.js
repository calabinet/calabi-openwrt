'use strict';
'require baseclass';
'require poll';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ns = 'http://www.w3.org/2000/svg';
const edgeColor = 'var(--ca-chart-edge)';
const relayColor = 'var(--ca-chart-relay)';

function value(response) { return response?.ok ? response.data : null; }

function bytes(n) {
	if (!Number.isFinite(n)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unit = 0;
	while (n >= 1024 && unit < units.length - 1) {
		n /= 1024;
		unit++;
	}
	return n.toLocaleString(undefined, { maximumFractionDigits: unit ? 2 : 0 }) + ' ' + units[unit];
}

function usage(u, localRelay, standalone, ownEdge, ownRelay) {
	if (!u) return null;
	const own = u.scope === 'own';
	const tunnel = ownEdge && !standalone && !own ? u.self_hosted_bytes_total ?? 0 : u.platform_bytes_total ?? u.bytes_total;
	const relay = standalone || own ? localRelay :
		ownRelay ? u.self_hosted_relay_bytes_total ?? localRelay : u.platform_relay_bytes_total ?? localRelay;
	return Number.isFinite(tunnel) && Number.isFinite(relay) ? { tunnel, relay } : null;
}

function buckets(history, local, standalone, ownEdge, ownRelay) {
	if (standalone)
		return [...(local?.daily || [])].sort((a, b) => a.date.localeCompare(b.date))
			.map(row => ({ day: row.date, tunnel: 0, relay: row.relay || 0 }));
	return [...(history?.buckets || [])].sort((a, b) => a.ts.localeCompare(b.ts)).map(row => {
		const day = row.ts.slice(0, 10);
		const groupRelay = ownEdge ? row.self_hosted_relay_bytes_out : row.relay_bytes_out;
		return { day, tunnel: Math.max(0, (ownEdge ? row.self_hosted_bytes_total || 0 : row.bytes_total) - (groupRelay || 0)),
			relay: (ownRelay ? row.self_hosted_relay_bytes_out : row.relay_bytes_out) || 0 };
	});
}

function svg(tag, attrs, label) {
	const node = document.createElementNS(ns, tag);
	for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
	if (label !== undefined) node.textContent = label;
	return node;
}

function chart(label, maximum, draw, width, rate = false) {
	const height = Math.max(142, Math.min(232, Math.round(width * .29)));
	const x = 76, y = height - (rate ? 14 : 26), top = 14;
	const end = width - 7;
	const root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': label });
	const at = (n) => y - n / maximum * (y - top);
	for (let i = 0; i <= 4; i++) {
		const amount = maximum * i / 4, line = at(amount);
		root.append(
			svg('line', { x1: x, x2: end, y1: line, y2: line, class: 'ca-chart-guide' }),
			svg('text', { x: x - 7, y: line + 4, 'text-anchor': 'end' }, bytes(amount) + (rate ? '/s' : ''))
		);
	}
	root.append(svg('path', { d: 'M' + x + ' ' + top + 'V' + y + 'H' + end, class: 'ca-chart-axis' }));
	draw(root, x, y, end, at);
	return root;
}

function historyChart(label, rows, width, relayOnly) {
	const max = Math.max(4, ...rows.map(r => r.tunnel + r.relay));
	return chart(label, max, (root, x, bottom, end, y) => {
		const step = (end - x) / rows.length;
		const bar = Math.min(step * .7, 52);
		const tick = Math.max(rows.length > 7 ? 3 : 1, Math.ceil(29 / step));
		rows.forEach((row, index) => {
			const middle = x + (index + .5) * step;
			const text = row.day.slice(5).replace('-', '/');
			const group = svg('g', {});
			if (row.tunnel > 0) group.append(svg('rect', { x: middle - bar / 2, y: y(row.tunnel), width: bar,
				height: bottom - y(row.tunnel), rx: 2, fill: edgeColor }));
			if (row.relay > 0) group.append(svg('rect', { x: middle - bar / 2, y: y(row.tunnel + row.relay), width: bar,
				height: y(row.tunnel) - y(row.tunnel + row.relay), rx: 2, fill: relayColor }));
			const breakdown = relayOnly ? '' : _('Endpoints') + ' ' + bytes(row.tunnel) + ' · ';
			group.append(svg('title', {}, row.day + ' · ' + breakdown + _('Relay') + ' ' + bytes(row.relay)));
			if (index === rows.length - 1 || (index % tick === 0 && index < rows.length - tick))
				group.append(svg('text', { x: middle, y: bottom + 18, 'text-anchor': 'middle' }, text));
			root.append(group);
		});
	}, width);
}

function throughputChart(samples, width) {
	const maximum = Math.max(4, ...samples);
	return chart(_('Live throughput'), maximum, (root, x, bottom, end, y) => {
		const values = samples.length === 1 ? [samples[0], samples[0]] : samples;
		const step = (end - x) / (values.length - 1);
		root.append(svg('polyline', { points: values.map((n, i) => (x + i * step) + ',' + y(n)).join(' '),
			fill: 'none', stroke: edgeColor, 'stroke-width': 2 }));
	}, width, true);
}

function card(title, content, summary) {
	return E('section', { class: 'calabi-card calabi-dashboard-card' }, [
		E('div', { class: 'calabi-dashboard-header' }, [E('h3', {}, [title]), summary || '']),
		E('div', { class: 'calabi-dashboard-body' }, content)
	]);
}

function stat(label, metric, foot) {
	return E('div', { class: 'calabi-stat' }, [
		E('div', { class: 'calabi-stat-label' }, [label]),
		E('div', { class: 'calabi-stat-number' }, [metric ?? '—']),
		foot ? E('div', { class: 'calabi-stat-note' }, [foot]) : ''
	]);
}

function trafficStat(label, totals) {
	return stat(label, totals ? bytes(totals.tunnel + totals.relay) : '—', totals ?
		_('Endpoints') + ' ' + bytes(totals.tunnel) + ' · ' + _('Relay') + ' ' + bytes(totals.relay) : '');
}

function pill(text, connected) {
	return E('span', { class: 'calabi-pill ' + (connected ? 'calabi-pill--good' : 'calabi-pill--warn') }, [text]);
}

function sampledRate(previous, rows, key, total, at) {
	const counters = new Map(rows.map(row => [row[key], total(row)]));
	let rate = 0;
	if (previous && at > previous.at) {
		for (const [id, n] of counters) {
			const before = previous.counters.get(id);
			if (before !== undefined && n >= before) rate += n - before;
		}
		rate /= (at - previous.at) / 1000;
	}
	return { at, counters, rate };
}

return baseclass.extend({
	formatBytes: bytes,
	load: async function(read, standalone) {
		const results = await Promise.all([
			read('overview_snapshot'), standalone ? Promise.resolve(null) : read('overview_devices'),
			read('overview_mesh'), read('endpoints'), read('edges'), read('usage_today', { tz: zone }),
			read('usage_month'), read('usage_daily', { tz: zone }), read('usage_mesh'),
			standalone ? Promise.resolve(null) : read('overview_quota')
		]);
		const [snap, devices, mesh, endpoints, edges, today, month, daily, local, quota] = results.map(value);
		return { snap, devices, mesh, endpoints, edges, today, month, daily, local, quota };
	},

	render: function(data, info, health, account, read, diagnostics) {
		const { snap, devices, mesh, endpoints, edges, today, month, daily, local, quota } = data;
		const standalone = info?.mode === 'self_hosted';
		const isOwnEdge = s => edges?.items?.some(e => e.owned && e.edge_node_id != null &&
			s?.edge_node_id != null && String(e.edge_node_id) === String(s.edge_node_id));
		let ownEdge = Boolean(isOwnEdge(snap)), ownRelay = Boolean(mesh?.derp_home?.startsWith('self-'));
		const localCount = endpoints?.my_total ?? endpoints?.items?.length;
		const orgLimit = account?.plan?.max_tunnels;
		const quotaBinds = quota && quota.exempt !== true && Number.isFinite(quota.limit) && quota.limit >= 0 &&
			(!(orgLimit > 0) || quota.limit < orgLimit);
		const endpointCount = quotaBinds ? quota.used : endpoints?.team_total ?? endpoints?.items?.length;
		const limit = quotaBinds ? quota.limit : orgLimit;
		let rows = buckets(daily, local, standalone, ownEdge, ownRelay);
		const unavailable = () => E('p', { class: 'calabi-chart-empty' }, [_('Traffic data is unavailable.')]);
		const legend = E('div', { class: 'calabi-chart-legend' }, [
			standalone ? '' : E('span', { class: 'calabi-legend-edge' }, [_('Endpoints')]),
			E('span', { class: 'calabi-legend-relay' }, [_('Relay')])
		]);
		const historyTitle = document.createTextNode(_('Last 7 days'));
		const historySummary = E('span', { class: 'calabi-chart-summary' });
		const history = E('div', { class: 'calabi-chart' }, [unavailable()]);
		const live = E('div', { class: 'calabi-chart' }, [unavailable()]);
		const liveSummary = E('span', { class: 'calabi-chart-summary' });
		const facts = E('dl', { class: 'calabi-facts', 'aria-live': 'polite' });
		const todayLabel = _('Traffic today'), monthLabel = _('Traffic this month');
		let todayCard = trafficStat(todayLabel, usage(today, local?.today?.relay, standalone, ownEdge, ownRelay));
		let monthCard = trafficStat(monthLabel, usage(month, local?.month?.relay, standalone, ownEdge, ownRelay));
		const samples = [];
		let peak = 0, pending = false, liveAvailable = false, start = snap?.started_at, tunnelSample, meshSample, factsRevision;
		function drawHistory() {
			const width = history.clientWidth;
			if (width <= 100) return;
			const days = width >= 680 && rows.length > 7 ? 30 : 7;
			const visible = rows.slice(-days);
			const title = days === 30 ? _('Last 30 days') : _('Last 7 days');
			const sum = visible.reduce((total, row) => total + row.tunnel + row.relay, 0);
			historyTitle.nodeValue = title;
			historySummary.textContent = visible.length ?
				_('Total') + ' ' + bytes(sum) + ' · ' + _('Excludes direct traffic') : '';
			legend.hidden = !visible.length;
			history.replaceChildren(visible.length ? historyChart(title, visible, width, standalone) : unavailable());
		}
		function drawLive() {
			const width = live.clientWidth;
			if (width > 100)
				live.replaceChildren(liveAvailable ? throughputChart(samples, width) : unavailable());
		}
		const widths = new WeakMap();
		const observer = new ResizeObserver(entries => {
			for (const entry of entries) {
				const width = entry.target.clientWidth;
				if (width === widths.get(entry.target)) continue;
				widths.set(entry.target, width);
				if (entry.target === history) drawHistory();
				else drawLive();
			}
		});
		observer.observe(history);
		observer.observe(live);

		function updateFacts(s, m) {
			const edgeState = !s ? '' : s.connected ? _('Connected') :
				['starting', 'connecting', 'reconnecting'].includes(s.lifecycle) ? _('Connecting') : _('Disconnected');
			const relayReady = Boolean(m?.relay && m.relay_rtt_micros > 0 && m.enabled && !m.paused);
			const relayState = !m ? '' : m.paused ? _('Paused') : !m.enabled ? _('Disabled') :
				relayReady ? _('Connected') : _('Connecting');
			const latency = relayReady ? (m.relay_rtt_micros / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ms' : '';
			const localFacts = [
				[_('Core version'), s?.client_version || health?.version],
				[_('Session / caller'), [s?.session_id, s?.client_id].filter(Boolean).join('\n')],
				[_('Client fingerprint'), [s?.fingerprint, s?.device_id ? '#' + s.device_id : ''].filter(Boolean).join(' · ')],
				[_('Edge node'), s?.server_addr, s && (standalone || isOwnEdge(s)), edgeState, s?.connected],
				[_('Relay node'), [m?.relay, latency].filter(Boolean).join(' · '), m?.derp_home?.startsWith('self-'), relayState, relayReady],
				[_('Overlay address'), [m?.overlay, m?.up ? _('%d peers').format(m.peers?.length ?? 0) : ''].filter(Boolean).join(' · ')]
			];
			const revision = JSON.stringify(localFacts);
			if (revision === factsRevision) return;
			factsRevision = revision;
			facts.replaceChildren(...localFacts.map(([label, content, selfHosted, state, connected]) =>
				E('div', {}, [E('dt', {}, [label, selfHosted ? pill(_('Self-hosted'), true) : '', state ? pill(state, connected) : '']),
					E('dd', { class: 'calabi-fact-value' }, [content || '—'])])));
		}
		function updateUsage(s, m) {
			const nextEdge = s?.edge_node_id ? Boolean(isOwnEdge(s)) : ownEdge;
			const nextRelay = m?.derp_home ? m.derp_home.startsWith('self-') : ownRelay;
			if (nextEdge === ownEdge && nextRelay === ownRelay) return;
			ownEdge = nextEdge;
			ownRelay = nextRelay;
			rows = buckets(daily, local, standalone, ownEdge, ownRelay);
			const nextToday = trafficStat(todayLabel, usage(today, local?.today?.relay, standalone, ownEdge, ownRelay));
			const nextMonth = trafficStat(monthLabel, usage(month, local?.month?.relay, standalone, ownEdge, ownRelay));
			todayCard.replaceWith(nextToday);
			monthCard.replaceWith(nextMonth);
			todayCard = nextToday;
			monthCard = nextMonth;
			drawHistory();
		}

		async function sample() {
			if (pending) return;
			pending = true;
			try {
				const get = async op => ({ data: value(await read(op)), at: performance.now() });
				const [tunnelResult, meshResult] = await Promise.all([get('overview_snapshot'), get('overview_mesh')]);
				const s = tunnelResult.data, m = meshResult.data;
				updateFacts(s, m);
				updateUsage(s, m);
				liveAvailable = Boolean(s || m);
				if (!s && !m) {
					drawLive();
					liveSummary.textContent = '';
					tunnelSample = meshSample = null;
					return;
				}
				if (s?.started_at && s.started_at !== start) {
					start = s.started_at;
					tunnelSample = meshSample = null;
					samples.length = 0;
					peak = 0;
				}
				tunnelSample = s ? sampledRate(tunnelSample, s.tunnels || [], 'proxy_id', r => (r.bytes_in || 0) + (r.bytes_out || 0), tunnelResult.at) : null;
				meshSample = m ? sampledRate(meshSample, m.peers || [], 'public_key', r => (r.rx_bytes || 0) + (r.tx_bytes || 0), meshResult.at) : null;
				const rate = (tunnelSample?.rate || 0) + (meshSample?.rate || 0);
				samples.push(rate);
				if (samples.length > 30) samples.shift();
				peak = Math.max(peak, rate);
				liveSummary.textContent = _('Current') + ' ' + bytes(rate) + '/s · ' + _('Peak') + ' ' + bytes(peak) + '/s';
				drawLive();
			} finally {
				pending = false;
			}
		}
		updateFacts(snap, mesh);
		poll.add(() => document.hidden ? null : sample(), 2);
		return [
			E('div', { class: 'calabi-stat-row' }, [
				stat(standalone ? _('Peers') : _('Organization devices'), standalone ? (mesh?.peers?.length ?? '—') : devices?.count),
				stat(quotaBinds || standalone ? _('My endpoints') : _('Active endpoints'),
					endpointCount == null ? '—' : endpointCount + (limit > 0 || quotaBinds ? ' / ' + limit : ''),
					localCount == null || localCount === endpointCount ? '' : _('On this client: %d').format(localCount)),
				todayCard, monthCard
			]),
			E('div', { class: 'calabi-overview-detail' }, [
				E('div', { class: 'calabi-chart-stack' }, [
					card(historyTitle, [legend, history], historySummary),
					card(_('Live throughput'), [live], liveSummary)
				]),
				card(_('Local information'), [facts, diagnostics])
			])
		];
	}
});
