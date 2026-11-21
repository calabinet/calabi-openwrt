include $(TOPDIR)/rules.mk

PKG_NAME:=calabi
PKG_VERSION:=2.8.0~openwrtdev6
PKG_RELEASE:=2
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE NOTICE
PKG_FILE_DEPENDS:=$(CURDIR)/local-input

include $(INCLUDE_DIR)/package.mk

# The staged Go build is already stripped and its hash is recorded.
RSTRIP:=:

define Package/calabi
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Calabi daemon for OpenWrt (local development build)
  URL:=https://github.com/calabinet/calabi
  DEPENDS:=@TARGET_x86_64 +ca-bundle +ip-full +kmod-tun +firewall4 +curl +jsonfilter
endef

define Package/calabi/description
 Calabi daemon with procd integration for mesh networking, declared
 subnets, and local services. This build is for local OpenWrt testing.
endef

define Build/Prepare
	(cd "$(CURDIR)/local-input" && sha256sum --strict -c SHA256SUMS)
	$(INSTALL_DIR) "$(PKG_BUILD_DIR)"
	$(INSTALL_BIN) "$(CURDIR)/local-input/calabi" "$(PKG_BUILD_DIR)/calabi"
	$(INSTALL_DATA) "$(CURDIR)/local-input/LICENSE" "$(PKG_BUILD_DIR)/LICENSE"
	$(INSTALL_DATA) "$(CURDIR)/local-input/NOTICE" "$(PKG_BUILD_DIR)/NOTICE"
endef

define Build/Compile
endef

define Package/calabi/conffiles
/etc/config/calabi
endef

define Package/calabi/postinst
#!/bin/sh
[ -z "$$IPKG_INSTROOT" ] || exit 0
if nft list table inet fw4 >/dev/null 2>&1; then
	# LuCI labels all stderr output as an error, even on a successful reload.
	if output="$$(fw4 reload 2>&1)"; then
		[ -z "$$output" ] || printf '%s\n' "$$output"
	else
		code=$$?
		printf '%s\n' 'Calabi: firewall reload failed.' "$$output" >&2
		exit "$$code"
	fi
fi
printf '%s\n' 'Calabi 安装配置完成。 / Calabi installation configured successfully.'
endef

define Package/calabi/postrm
#!/bin/sh
[ -z "$$IPKG_INSTROOT" ] || exit 0
[ "$$1" != upgrade ] || exit 0
sets=
for set in calabi_egress calabi_published_v4; do
	if nft list set inet fw4 "$$set" >/dev/null 2>&1; then
		sets="$$sets $$set"
	fi
done
[ -n "$$sets" ] || exit 0
fw4 reload || exit $$?
# fw4 removes the rule references but its table flush leaves set definitions.
for set in $$sets; do
	if nft list set inet fw4 "$$set" >/dev/null 2>&1; then
		printf 'delete set inet fw4 %s\n' "$$set"
	fi
done | nft -f -
endef

define Package/calabi/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/etc/init.d $(1)/etc/config $(1)/usr/share/calabi
	$(INSTALL_DIR) $(1)/usr/share/nftables.d/table-pre $(1)/usr/share/nftables.d/chain-post/forward
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/calabi $(1)/usr/bin/calabi
	$(INSTALL_BIN) ./files/calabi.init.sh $(1)/etc/init.d/calabi
	$(INSTALL_BIN) ./files/fw4-sync.sh $(1)/usr/share/calabi/fw4-sync
	$(INSTALL_CONF) ./files/calabi.config $(1)/etc/config/calabi
	$(INSTALL_DATA) ./files/fw4-sets.nft $(1)/usr/share/nftables.d/table-pre/90-calabi.nft
	$(INSTALL_DATA) ./files/fw4-forward.nft $(1)/usr/share/nftables.d/chain-post/forward/90-calabi.nft
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/LICENSE $(1)/usr/share/calabi/LICENSE
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/NOTICE $(1)/usr/share/calabi/NOTICE
	printf '%s\n' '$(PKG_VERSION)-$(PKG_RELEASE)' > $(1)/usr/share/calabi/openwrt-version
endef

$(eval $(call BuildPackage,calabi))
