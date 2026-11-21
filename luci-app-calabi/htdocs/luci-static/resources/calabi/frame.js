'use strict';
'require baseclass';
'require calabi.egress as egress';

return baseclass.extend({
	prepare: function() {
		document.documentElement.classList.add('calabi-authorization-pending');
		if (!document.getElementById('calabi-client-styles'))
			document.head.appendChild(E('link', { id: 'calabi-client-styles', rel: 'stylesheet',
				href: L.resource('calabi/client.css') }));
	},
	render: function(active, sections, authorized = true) {
		document.documentElement.classList.toggle('calabi-authorization-pending', !authorized);
		return E('div', { class: 'cbi-map calabi-workspace' + (authorized ? '' : ' calabi-authorization') }, [
			E('div', { class: 'calabi-main calabi-main-' + active }, [
				authorized ? egress.render() : '',
				E('div', { class: 'calabi-grid calabi-grid-' + active }, sections)
			])
		]);
	}
});
