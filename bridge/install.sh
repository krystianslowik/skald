#!/bin/sh
# Installs SkaldBridge.dll for the community valheim-server image (BEPINEX=true).
#
# The image copies /config/bepinex/plugins into its BepInEx install
# (/opt/valheim/bepinex/BepInEx/plugins) on every server start, but never
# removes anything there. So any old copy is deleted from both places first,
# then the plugin goes into /config/bepinex/plugins and, when the install
# already exists, straight into it as well.
#
#   SKALD_BRIDGE=off   remove the plugin instead of installing it
#   PLUGINS_DIR        default /config/bepinex/plugins
#   INSTALL_DIR        default /opt/valheim/bepinex/BepInEx/plugins
set -eu

src=/skald/SkaldBridge.dll
plugins=${PLUGINS_DIR:-/config/bepinex/plugins}
installed=${INSTALL_DIR:-/opt/valheim/bepinex/BepInEx/plugins}

rm -f "$plugins"/SkaldBridge*.dll
[ -d "$installed" ] && rm -f "$installed"/SkaldBridge*.dll

case "$(echo "${SKALD_BRIDGE:-on}" | tr 'A-Z' 'a-z')" in
  off | false | 0 | no)
    echo "skald-bridge: SKALD_BRIDGE=off, plugin removed"
    exit 0
    ;;
esac

mkdir -p "$plugins"
cp "$src" "$plugins/SkaldBridge.dll"
chmod 0644 "$plugins/SkaldBridge.dll"
if [ -d "$installed" ]; then
  cp "$src" "$installed/SkaldBridge.dll"
  chmod 0644 "$installed/SkaldBridge.dll"
fi
echo "skald-bridge: installed $(md5sum "$src" | cut -d' ' -f1)"
