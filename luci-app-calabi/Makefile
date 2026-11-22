include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-calabi
PKG_VERSION:=0.1.0
PKG_RELEASE:=31
PKG_LICENSE:=Apache-2.0
PKG_FILE_DEPENDS:=$(CURDIR)/local-input

include $(INCLUDE_DIR)/package.mk

# The bridge is a static, prebuilt target binary with a pinned SHA-256.
RSTRIP:=:

define Package/luci-app-calabi
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI support for Calabi
  DEPENDS:=@TARGET_x86_64 +luci-base +rpcd +calabi +logd +usign
endef

define Build/Prepare
	(cd "$(CURDIR)/local-input" && sha256sum --strict -c SHA256SUMS)
	$(INSTALL_DIR) "$(PKG_BUILD_DIR)"
	$(INSTALL_BIN) ./local-input/calabi-rpc "$(PKG_BUILD_DIR)/calabi-rpc"
endef

define Build/Compile
endef

define Package/luci-app-calabi/install
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd $(1)/www/luci-static/resources $(1)/usr/lib/lua/luci/i18n
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/calabi-rpc $(1)/usr/libexec/rpcd/calabi
	$(CP) ./root/. $(1)/
	$(INSTALL_BIN) ./root/usr/share/calabi/update-cron $(1)/usr/share/calabi/update-cron
	$(CP) ./htdocs/luci-static/resources/. $(1)/www/luci-static/resources/
	$(INSTALL_DATA) ./local-input/calabi.zh-cn.lmo $(1)/usr/lib/lua/luci/i18n/calabi.zh-cn.lmo
endef

define Package/luci-app-calabi/postinst
#!/bin/sh
[ -z "$$IPKG_INSTROOT" ] || exit 0
/usr/share/calabi/update-cron install || logger -t calabi "could not schedule Calabi package update checks"
/etc/init.d/rpcd restart
endef

define Package/luci-app-calabi/prerm
#!/bin/sh
[ -z "$$IPKG_INSTROOT" ] || exit 0
[ "$$PKG_UPGRADE" != 1 ] && [ "$$1" != upgrade ] || exit 0
/usr/share/calabi/update-cron remove
endef

define Package/luci-app-calabi/postrm
#!/bin/sh
[ -z "$$IPKG_INSTROOT" ] || exit 0
[ "$$1" != upgrade ] || exit 0
/etc/init.d/rpcd restart
endef

$(eval $(call BuildPackage,luci-app-calabi))
