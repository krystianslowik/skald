#!/bin/sh
# Builds bridge/out/SkaldBridge.dll.
#
# Reference DLLs (game, Unity, BepInEx) are never committed. If bridge/refs/ is
# missing they are fetched here, anonymously:
#   - six DLLs of the Valheim dedicated server (Steam app 896660, Linux depot
#     896661) through DepotDownloader's anonymous login, about 2 MB: only the
#     files the compiler needs, not the 2.3 GB install
#   - BepInEx.dll and 0Harmony.dll (HarmonyX) from BepInExPack_Valheim on
#     Thunderstore, pinned to the version the community-valheim-tools image
#     installs
# Only the DLLs needed for compilation are kept in bridge/refs/.
#
# The game assemblies are not on NuGet in a current version (the BepInEx
# feed's Valheim.GameLibs stops at 0.202.14, before 1.0), and the plugin
# calls them directly, so the terrain plugin's NuGet-only route does not work
# here.
#
# Usage:  bridge/build.sh            fetch refs if missing, then build
#         bridge/build.sh --refetch  drop bridge/refs/ and fetch again
#         bridge/build.sh --refs-only  fetch refs, do not build
#         GAME_REFS=/path bridge/build.sh   use an existing Managed/ + BepInEx.dll + 0Harmony.dll dir
#         SKALD_TEST=1 bridge/build.sh      test build (adds /v1/debug/spawn-prefab)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
refs=${GAME_REFS:-$here/refs}
bepinex_version=${BEPINEX_PACK_VERSION:-5.4.2351}
dd_version=${DEPOTDOWNLOADER_VERSION:-3.4.0}
need="assembly_valheim assembly_utils Splatform Newtonsoft.Json UnityEngine UnityEngine.CoreModule"

case "${1:-}" in
  --refetch) [ -z "${GAME_REFS:-}" ] && rm -rf "$refs" ;;
esac

# DepotDownloader's framework build runs on any OS and CPU with the .NET SDK
# that builds the plugin anyway.
fetch() {
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "fetching DepotDownloader $dd_version ..."
  curl -fsSL -o "$tmp/dd.zip" \
    "https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_$dd_version/DepotDownloader-framework.zip"
  (cd "$tmp" && unzip -q dd.zip -d dd)
  printf 'regex:^valheim_server_Data/Managed/(%s)\\.dll$\n' "$(echo "$need" | sed 's/\./\\./g; s/ /|/g')" > "$tmp/files.txt"
  echo "fetching game reference DLLs (app 896660, depot 896661, anonymous) ..."
  for attempt in 1 2 3; do
    dotnet "$tmp/dd/DepotDownloader.dll" -app 896660 -depot 896661 -os linux \
      -filelist "$tmp/files.txt" -dir "$tmp/game" || true
    [ -f "$tmp/game/valheim_server_Data/Managed/assembly_valheim.dll" ] && break
    [ "$attempt" = 3 ] && { echo "DepotDownloader failed 3 times" >&2; exit 1; }
    echo "attempt $attempt failed, retrying"
  done
  echo "fetching BepInExPack_Valheim $bepinex_version ..."
  curl -fsSL -o "$tmp/bepinex.zip" \
    "https://thunderstore.io/package/download/denikson/BepInExPack_Valheim/$bepinex_version/"
  (cd "$tmp" && unzip -q bepinex.zip -d bepinex)
  mkdir -p "$refs"
  for d in $need; do
    cp "$tmp/game/valheim_server_Data/Managed/$d.dll" "$refs/"
  done
  for d in BepInEx 0Harmony; do
    cp "$(find "$tmp/bepinex" -path "*BepInEx/core/$d.dll" | head -1)" "$refs/"
  done
}

missing=0
for d in $need BepInEx 0Harmony; do [ -f "$refs/$d.dll" ] || missing=1; done
if [ "$missing" = 1 ]; then
  if [ -n "${GAME_REFS:-}" ]; then echo "GAME_REFS=$refs lacks some of: $need BepInEx 0Harmony" >&2; exit 1; fi
  fetch
fi
[ "${1:-}" = "--refs-only" ] && exit 0

defines=""
[ "${SKALD_TEST:-}" = 1 ] && defines="-p:DefineConstants=SKALD_TEST"
# shellcheck disable=SC2086
dotnet build "$here/plugin/SkaldBridge.csproj" -c Release -p:GameRefs="$refs" $defines -o "$here/out"
ls -l "$here/out/SkaldBridge.dll"
