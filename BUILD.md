# Build and verify

Follow these steps on a Linux x86_64 host with Bash, Git, Go, a C compiler, Python 3, GNU make, tar, gpg, OpenSSL and fakeroot. Keep both work directories clean and record the integration repository commit used for the build.

1. Use [core-source.json](core-source.json) to clone the public core repository. Check out the pinned commit in a detached worktree and compare both `git rev-parse HEAD` and `git rev-parse 'HEAD^{tree}'` with the lock. Use the Go toolchain and daemon linker flags recorded in the lock. The platform API and console defaults come from the public core release manifest. Leave `GOWORK` unset for the daemon so its own workspace is used.
2. Verify the OpenWrt SDK archive against the official signed checksum list, then compare its SHA-256 with the lock. Use the SDK for OpenWrt 23.05.6 x86/64 and its pinned feed revisions. Install the feed definitions if building runtime dependencies as well. Check out the LuCI revision in the lock and build `po2lmo` with `make -C modules/luci-base/src po2lmo`. On WSL, make sure the install tool and fakeroot produce archive files owned by `root:root`. [Official SDK and signatures](https://downloads.openwrt.org/releases/23.05.6/targets/x86/64/)
3. Fetch the released public core build manifest linked in the lock and verify its SHA-256. Reconstruct the public platform CA from `inputs.edge_ca.pem` by joining its lines with LF and adding a trailing LF. Verify the PEM and DER hashes in the lock using `sha256sum` and `openssl x509 -outform DER`. In a disposable core checkout, replace the file at `inputs.edge_ca.path` with that PEM before building. This preserves platform certificate verification. [Public core 2.9.0 manifest](https://github.com/calabinet/calabi/releases/download/v2.9.0/build-manifest.json)
4. Build the two static Linux amd64 binaries and the translation catalog. The following shell commands assume the integration and core checkouts and the verified SDK have already been prepared. Set `integration`, `core`, `sdk` and `po2lmo` to their absolute paths. Use a fresh SDK extraction per build. On WSL, keep the integration checkout and SDK on the native Linux filesystem. If the checkout is on a Windows drive, extract a Git archive on the Linux filesystem before staging the recipes so static assets retain their Git file modes.

   ```sh
   mkdir -p "$sdk/package/calabi/local-input" "$sdk/package/luci-app-calabi/local-input"
   cp -R "$integration/calabi/." "$sdk/package/calabi/"
   cp -R "$integration/luci-app-calabi/." "$sdk/package/luci-app-calabi/"
   core_inputs="$sdk/package/calabi/local-input"
   luci_inputs="$sdk/package/luci-app-calabi/local-input"

   unset GOWORK GO111MODULE
   export CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 GOTOOLCHAIN=local
   core_ldflags="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["core"]["ldflags"])' "$integration/core-source.json")"
   go -C "$core/apps/client" build -trimpath -buildvcs=false \
       -ldflags "$core_ldflags" -o "$core_inputs/calabi" ./cmd/calabi
   bridge="$integration/luci-app-calabi/bridge"
   go -C "$core/apps/client" build -trimpath -buildvcs=false \
       -ldflags '-s -w' -o "$luci_inputs/calabi-rpc" "$bridge/main.go" "$bridge/update.go"
   cp "$core/LICENSE" "$core/NOTICE" "$core_inputs/"
   "$po2lmo" "$integration/luci-app-calabi/po/zh_Hans/calabi.po" "$luci_inputs/calabi.zh-cn.lmo"
   (cd "$core_inputs" && sha256sum calabi LICENSE NOTICE > SHA256SUMS)
   (cd "$luci_inputs" && sha256sum calabi-rpc calabi.zh-cn.lmo > SHA256SUMS)
   ```

5. Build the two package targets in the SDK. For a package-only build, the commands below generate the package metadata without rebuilding the runtime dependencies. The resulting packages retain those dependencies for opkg. Set both timestamp variables because the SDK's IPK builder prefers `PKG_SOURCE_DATE_EPOCH`. Use a GNU install implementation and verify that fakeroot produces `root:root` archive entries. Record the host tools and input hashes.

   ```sh
   export SOURCE_DATE_EPOCH="$(git -C "$core" show -s --format=%ct HEAD)"
   fakeroot_bin="$(command -v fakeroot)"
   (
       cd "$sdk"
       printf 'CONFIG_PACKAGE_calabi=m\nCONFIG_PACKAGE_luci-app-calabi=m\n' > .config
       make defconfig SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH"
       for package in calabi luci-app-calabi; do
           make -r -C "package/$package" BUILD_SUBDIR="package/$package" OPENWRT_BUILD=1 \
               TOPDIR="$sdk" STAGING_DIR_HOST="$sdk/staging_dir/host" FAKEROOT="$fakeroot_bin" \
               SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" PKG_SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" compile V=s
       done
   )
   ```
6. Build from two fresh checkouts and SDK extractions, then compare the SHA-256 of both binaries, the catalog and both `.ipk` files. Inspect the package metadata, dependencies, archive owners and installed paths. If IPK hashes differ, compare the control and data archives independently before reporting reproducibility.
7. Test the resulting packages on a compatible device. Check both enrollment modes, real IP and single IP alias access, and fw4 reload and recovery. Keep the source revision, manifest, package hashes, and soak evidence together.
