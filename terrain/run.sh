#!/bin/bash
# Entry point of the terrain Job's game container (the community
# valheim-server image, unchanged). Decides what to sample, then runs the
# image's own bootstrap with BepInEx on and hook.sh as PRE_SERVER_RUN_HOOK:
# the image downloads the dedicated server and BepInEx as usual, the hook
# samples the world generator with the Skald plugin and stops supervisord
# before the real server would start. Exits with the plugin's code.
#
# What to sample, either:
#   SKALD_AGENT_URL + SKALD_AGENT_TOKEN   ask the agent (/state terrain.request);
#                                         exits 0 at once if its terrain is current
#                                         (SKALD_TERRAIN_FORCE=true runs anyway)
#   SKALD_TERRAIN_SEED [+ _SEED_HASH, _WORLDGEN_VERSION]   given directly
#
# Exit codes: 0 done or nothing to do, 10 bad settings, 11 game API not
# found, 12 sampling failed, 13 output not writable, 20 agent unreachable,
# 21 the agent cannot read the world, 70 the game never ran the hook.
set -u

say() { echo "skald-terrain: $*"; }
run=/skald-run
mkdir -p "$run"
rm -f "$run/status"

if [ -n "${SKALD_AGENT_URL:-}" ]; then
    if ! state=$(curl -fsS --max-time 20 -H "X-Agent-Token: ${SKALD_AGENT_TOKEN:-}" "${SKALD_AGENT_URL%/}/state"); then
        say "cannot read ${SKALD_AGENT_URL%/}/state"
        exit 20
    fi
    req=$(jq -c '.terrain.request // empty' <<<"$state")
    if [ -z "$req" ]; then
        say "the agent cannot read the world yet (or predates 0.7.0)"
        exit 21
    fi
    if [ "$(jq -r '(.terrain.available == true) and (.terrain.stale == false)' <<<"$state")" = true ] && [ "${SKALD_TERRAIN_FORCE:-}" != true ]; then
        say "the agent's terrain is current (build $(jq -r .terrain.build <<<"$state")); nothing to do"
        exit 0
    fi
    say "the agent asks for terrain: $(jq -r '.terrain.reason // "missing"' <<<"$state")"
    SKALD_TERRAIN_SEED=$(jq -r .seedName <<<"$req")
    SKALD_TERRAIN_SEED_HASH=$(jq -r .seedHash <<<"$req")
    SKALD_TERRAIN_WORLDGEN_VERSION=$(jq -r .worldGenVersion <<<"$req")
    export SKALD_TERRAIN_SEED SKALD_TERRAIN_SEED_HASH SKALD_TERRAIN_WORLDGEN_VERSION
fi
if [ -z "${SKALD_TERRAIN_SEED:-}" ]; then
    say "set SKALD_AGENT_URL (and SKALD_AGENT_TOKEN) or SKALD_TERRAIN_SEED"
    exit 10
fi

# Inherited through supervisord by the image's valheim-server script, which
# sources the hook. The server itself is never started: nothing listens, no
# Steam or PlayFab session, no world is created.
export SKALD_TERRAIN_OUT="${SKALD_TERRAIN_OUT:-/config/skald-terrain}"
export SKALD_TERRAIN_STATUS="$run/status"
export BEPINEX=true
export PRE_SERVER_RUN_HOOK=". /skald/hook.sh"
export SERVER_NAME="${SERVER_NAME:-skald-terrain}"
export WORLD_NAME="${WORLD_NAME:-skald-terrain}"
export SERVER_PASS="${SERVER_PASS:-skald-terrain-$RANDOM$RANDOM}"
export SERVER_PUBLIC=false CROSSPLAY=false BACKUPS=false RESTART_CRON="" UPDATE_CRON=""
# tini runs below this shell rather than as PID 1.
export TINI_SUBREAPER=1
# BepInEx's config directory is a link to /config/bepinex, which the image
# creates only when it first installs BepInEx: with the install cached on a
# volume and a fresh /config, BepInEx would fail to start.
mkdir -p /config/bepinex

/usr/local/sbin/bootstrap
code=70
if read -r c word detail <"$run/status" 2>/dev/null; then
    code=$c
    say "finished: $word $detail"
else
    say "the game exited without running the sampler (see the log above)"
fi
exit "$code"
