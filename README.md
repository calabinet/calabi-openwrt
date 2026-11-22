# Calabi for OpenWrt

Calabi for OpenWrt provides mesh networking, advertised subnet routes, and access to local services. The native LuCI application manages both platform API key enrollment and self-hosted enrollment. This repository maintains the OpenWrt packages, LuCI views and rpcd bridge, service startup, and fw4 integration. The daemon comes from [calabinet/calabi](https://github.com/calabinet/calabi).

## Compatibility

The initial build target is OpenWrt 23.05 x86/64 with opkg packages. ImmortalWrt 23.05.4 x86/64 is the first compatibility test environment. Use kernel modules from the device's matching firmware feeds. See [build instructions](BUILD.md) for the pinned inputs and local verification procedure.

## Packages

- `calabi` installs the shared daemon, its procd service, and the fw4 integration for approved subnets.
- `luci-app-calabi` provides the authorization flow, overview, mesh, subnets, endpoints, logs, and update settings using LuCI permissions and the daemon's local management socket.

Download both x86_64 IPKs and SHA256SUMS from the [releases page](https://github.com/calabinet/calabi-openwrt/releases). Verify the checksums, then upload and install calabi followed by luci-app-calabi in LuCI under System → Software. Keep the firmware feeds enabled so opkg can install dependencies.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
