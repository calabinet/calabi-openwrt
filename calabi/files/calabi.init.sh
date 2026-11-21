#!/bin/sh /etc/rc.common

USE_PROCD=1
START=95
STOP=10

start_service() {
	local state_dir=/etc/calabi
	local run_dir=/var/run/calabi
	local app_version=

	umask 077
	if [ -L "$state_dir" ] || [ -L "$run_dir" ]; then
		logger -t calabi "refusing to start with a symlinked state or runtime directory"
		return 1
	fi
	if ! mkdir -p "$state_dir" "$run_dir" ||
		! chown 0:0 "$state_dir" "$run_dir" ||
		! chmod 0700 "$state_dir" "$run_dir"; then
		logger -t calabi "could not prepare private state and runtime directories"
		return 1
	fi

	procd_open_instance
	procd_set_param command /usr/bin/calabi daemon
	if [ -r /usr/share/calabi/openwrt-version ]; then
		IFS= read -r app_version < /usr/share/calabi/openwrt-version
	fi
	procd_set_param env "XDG_CONFIG_HOME=/etc" "CALABI_DAEMON_SOCKET=$run_dir/control.sock" "CALABI_OPENWRT_VERSION=$app_version"
	procd_set_param respawn 3600 5 5
	procd_set_param term_timeout 30
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance

	procd_open_instance fw4
	procd_set_param command /usr/share/calabi/fw4-sync "$run_dir/control.sock"
	procd_set_param respawn 3600 5 5
	procd_set_param term_timeout 8
	procd_close_instance
}
