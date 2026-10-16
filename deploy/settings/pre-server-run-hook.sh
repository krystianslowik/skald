# PRE_SERVER_RUN_HOOK for the community Valheim image: reads the settings
# Skald writes to /settings/server.env. The image evals this inside its
# valheim-server script, right before it launches the game, so a supervisord
# restart of valheim-server picks up new settings without a container restart.
#
# The file is parsed, never sourced: only four keys are accepted, and values
# are plain assignments that the shell does not expand again.
#
# This file is the one source of the hook. The Compose and Kubernetes examples
# carry the last line verbatim in PRE_SERVER_RUN_HOOK (Compose doubles every
# $); after editing it, copy it over. The agent's tests (go test, also in CI)
# run pre-server-run-hook.test.sh and fail if a copy drifts. The line relies
# on the image's internal `info` function and `valheim_server_args` array, so
# check it again whenever the image tag changes.
skald_f=/settings/server.env; if [ -r "$skald_f" ]; then while IFS='=' read -r skald_k skald_v || [ -n "$skald_k" ]; do case "$skald_k" in SERVER_NAME) SERVER_NAME=$skald_v;; SERVER_PASS) SERVER_PASS=$skald_v;; SERVER_PUBLIC) SERVER_PUBLIC=$skald_v;; SERVER_ARGS) SERVER_ARGS=$skald_v;; esac; done < "$skald_f"; valheim_server_args=(-password "$SERVER_PASS"); if [ "$CROSSPLAY" = true ]; then valheim_server_args+=(-crossplay); fi; info "Skald settings applied"; fi
