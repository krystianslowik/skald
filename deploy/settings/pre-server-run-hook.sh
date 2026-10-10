# PRE_SERVER_RUN_HOOK for the community Valheim image: reads the settings
# Skald writes to /settings/server.env. The image evals this inside its
# valheim-server script, right before it launches the game, so a supervisord
# restart of valheim-server picks up new settings without a container restart.
#
# The file is parsed, never sourced: only four keys are accepted, and values
# are plain assignments that the shell does not expand again. Copy the last
# line verbatim into PRE_SERVER_RUN_HOOK (in Compose, double every $).
skald_f=/settings/server.env; if [ -r "$skald_f" ]; then while IFS='=' read -r skald_k skald_v || [ -n "$skald_k" ]; do case "$skald_k" in SERVER_NAME) SERVER_NAME=$skald_v;; SERVER_PASS) SERVER_PASS=$skald_v;; SERVER_PUBLIC) SERVER_PUBLIC=$skald_v;; SERVER_ARGS) SERVER_ARGS=$skald_v;; esac; done < "$skald_f"; valheim_server_args=(-password "$SERVER_PASS"); if [ "$CROSSPLAY" = true ]; then valheim_server_args+=(-crossplay); fi; info "Skald settings applied"; fi
