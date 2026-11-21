#!/bin/sh
set -f

. /lib/functions.sh
. /lib/functions/network.sh

socket="$1"

flush_sets() {
	printf '%s\n' 'flush set inet fw4 calabi_egress' 'flush set inet fw4 calabi_published_v4'
}

stop() {
	flush_sets | nft -f - 2>/dev/null
	exit 0
}
trap stop TERM INT HUP

add_egress_device() {
	local network="$1" device
	case "$network" in ''|*[!a-zA-Z0-9_-]*) return ;; esac
	network_is_up "$network" && network_get_device device "$network" || return
	case "$device" in ''|lo|calabi-mesh|*[!a-zA-Z0-9_.-]*) return ;; esac
	devices="$devices $device"
}

read_routes() {
	local response route
	response="$(curl -q --noproxy '*' -fsS --max-time 2 --unix-socket "$socket" http://localhost/v1/mesh 2>/dev/null)" ||
		return
	[ "$(printf '%s' "$response" | jsonfilter -e '@.up' 2>/dev/null)" = true ] || return
	[ "$(printf '%s' "$response" | jsonfilter -e '@.netmap_seen' 2>/dev/null)" = true ] || return
	for route in $(printf '%s' "$response" | jsonfilter -e '@.published_routes[*]' 2>/dev/null); do
		# Restrict the nft grammar to IPv4 prefix tokens. nft validates the
		# octets and network mask. An exit route has a different policy.
		case "$route" in */0|*[!0-9./]*) continue ;; esac
		case "$route" in *.*.*.*/*) routes="$routes $route" ;; esac
	done
}

apply_sets() {
	local item
	flush_sets
	[ -n "$devices" ] && [ -n "$routes" ] || return 0
	for item in $(printf '%s\n' $devices | sort -u); do
		printf 'add element inet fw4 calabi_egress { "%s" }\n' "$item"
	done
	for item in $(printf '%s\n' $routes | sort -u); do
		printf 'add element inet fw4 calabi_published_v4 { %s }\n' "$item"
	done
}

failed=0
while :; do
	devices= routes=
	network_flush_cache
	if config_load calabi; then
		config_list_foreach firewall network add_egress_device
	fi
	if [ -n "$devices" ]; then
		read_routes
	fi
	if apply_sets | nft -f - 2>/dev/null; then
		failed=0
	else
		# A failed update cannot extend the old entries' lease. Also clear
		# them immediately when the sets still exist.
		flush_sets | nft -f - 2>/dev/null
		if [ -n "$devices" ] && [ "$failed" = 0 ]; then
			logger -t calabi "could not sync approved subnets with fw4; check the active firewall includes"
			failed=1
		fi
	fi
	sleep 4 &
	wait "$!"
done
