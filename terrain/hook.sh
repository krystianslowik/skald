# Sourced by the community image's valheim-server script as
# PRE_SERVER_RUN_HOOK (see run.sh). The working directory is the BepInEx
# install and the doorstop variables are already exported. Runs the server
# binary once with the Skald plugin, which samples the world generator,
# writes its grids and quits; then stops supervisord, so the container ends
# instead of starting the real server.
skald_terrain_hook() {
    local status="${SKALD_TERRAIN_STATUS:-/skald-run/status}" rc
    mkdir -p BepInEx/plugins
    if ! cp -f /skald/SkaldTerrain.dll BepInEx/plugins/SkaldTerrain.dll; then
        echo "13 install cannot copy the plugin into BepInEx/plugins" >"$status"
        return
    fi
    info "Skald terrain: sampling the world generator"
    # The plugin quits the process within seconds of start. If BepInEx does
    # not load, this would become a real (private, unlisted) server: the
    # timeout stops it.
    timeout --signal=INT --kill-after=30 "${SKALD_TERRAIN_TIMEOUT:-180}" \
        env LD_PRELOAD=libdoorstop_x64.so nice -n "${SKALD_TERRAIN_NICE:-10}" ./valheim_server.x86_64 \
        -nographics -batchmode -name skald-terrain -port 2470 -world skald-terrain -public 0 \
        -password "$SERVER_PASS"
    rc=$?
    if [ ! -s "$status" ]; then
        if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
            echo "12 timeout the plugin did not run (BepInEx not loaded?); stopped after ${SKALD_TERRAIN_TIMEOUT:-180} s" >"$status"
        else
            echo "12 crashed the server process exited with $rc before the plugin wrote a status" >"$status"
        fi
    fi
    info "Skald terrain: $(cat "$status")"
}
skald_terrain_hook
supervisorctl -c /usr/local/etc/supervisord.conf shutdown >/dev/null 2>&1 || true
# Leave the valheim-server script here: it must not go on to start the server.
exit 0
