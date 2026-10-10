#!/usr/bin/env bash
# Tests pre-server-run-hook.sh the way the community image runs it: inside the
# valheim-server script, after its defaults built valheim_server_args, via
# eval. Run: bash deploy/settings/pre-server-run-hook.test.sh
set -u

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
hook=$(grep -v '^#' "$here/pre-server-run-hook.sh")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0

fail() {
    echo "FAIL: $*" >&2
    fails=$((fails + 1))
}

# run CROSSPLAY: prints the final server argv, one word per line, the way
# run_server builds it, after evaluating the hook against $tmp/server.env.
run() {
    (
        info() { echo "info: $*" >>"$tmp/info.log"; }
        # The image's defaults (env values the hook may override).
        SERVER_NAME="Env Name"
        SERVER_PASS="env-pass"
        SERVER_PUBLIC=1
        SERVER_ARGS="-modifier raids less"
        CROSSPLAY=$1
        valheim_server_args=(-password "$SERVER_PASS")
        if [ "$CROSSPLAY" = true ]; then valheim_server_args+=(-crossplay); fi
        PRE_SERVER_RUN_HOOK=${hook//\/settings\/server.env/$tmp/server.env}
        eval "$PRE_SERVER_RUN_HOOK"
        # shellcheck disable=SC2086
        printf '%s\n' -name "$SERVER_NAME" -public "$SERVER_PUBLIC" "${valheim_server_args[@]}" $SERVER_ARGS
        printf 'PATH=%s\n' "$PATH"
    )
}

expect() {
    local name=$1 want=$2 got=$3
    if [ "$got" != "$want" ]; then
        fail "$name"
        diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") >&2
    fi
}

# 1. Missing file: nothing changes, no confirmation line.
rm -f "$tmp/server.env" "$tmp/info.log"
got=$(run true)
expect "missing file" "$(printf '%s\n' -name "Env Name" -public 1 -password env-pass -crossplay -modifier raids less "PATH=$PATH")" "$got"
[ -e "$tmp/info.log" ] && fail "missing file: hook claimed it applied settings"

# 2. The four keys apply; anything else is ignored.
cat >"$tmp/server.env" <<ENV
SERVER_NAME=Ragnar's Hall of Fire
SERVER_PASS=ognisko-7
PATH=/nowhere
valheim_server_args=-password hijack
CROSSPLAY=false
SERVER_PUBLIC=0
SERVER_ARGS=-preset hard -modifier raids none -setkey nomap -saveinterval 900 -crossplay
ENV
got=$(run true)
expect "allow-list" "$(printf '%s\n' -name "Ragnar's Hall of Fire" -public 0 -password ognisko-7 -crossplay \
    -preset hard -modifier raids none -setkey nomap -saveinterval 900 -crossplay "PATH=$PATH")" "$got"
grep -q "info: Skald settings applied" "$tmp/info.log" || fail "allow-list: no confirmation line"

# 3. CROSSPLAY off: the rebuilt array has no -crossplay.
got=$(run false)
case "$got" in *$'\n-password\nognisko-7\n-preset'*) ;; *) fail "crossplay off: array not rebuilt as (-password pw)"; printf '%s\n' "$got" >&2 ;; esac

# 4. Nothing in a value or a key is executed or expanded.
cat >"$tmp/server.env" <<ENV
SERVER_NAME=Hall \$(touch $tmp/pwned-name) \`touch $tmp/pwned-tick\`
SERVER_PASS=a\$(touch $tmp/pwned-pass);\`id\`=b=
SERVER_PUBLIC=1;touch $tmp/pwned-public
SERVER_ARGS=-x \$(touch $tmp/pwned-args) ;touch
\$(touch $tmp/pwned-key)=1
ENV
got=$(run true)
for p in name tick pass public args key; do
    [ -e "$tmp/pwned-$p" ] && fail "injection: $p was executed"
done
expect "injection" "$(printf '%s\n' -name "Hall \$(touch $tmp/pwned-name) \`touch $tmp/pwned-tick\`" \
    -public "1;touch $tmp/pwned-public" -password "a\$(touch $tmp/pwned-pass);\`id\`=b=" -crossplay \
    -x "\$(touch" "$tmp/pwned-args)" ";touch" "PATH=$PATH")" "$got"

# 5. '=' inside a password survives, including at the end.
printf 'SERVER_PASS=a=b=\nSERVER_NAME=Eq Hall\n' >"$tmp/server.env"
got=$(run false)
expect "equals in value" "$(printf '%s\n' -name "Eq Hall" -public 1 -password a=b= -modifier raids less "PATH=$PATH")" "$got"

# 6. A last line without a newline is still read.
printf 'SERVER_NAME=No Newline\nSERVER_PASS=tail-pass' >"$tmp/server.env"
got=$(run false)
expect "no trailing newline" "$(printf '%s\n' -name "No Newline" -public 1 -password tail-pass -modifier raids less "PATH=$PATH")" "$got"

# 7. The hook has no $( ... ): Kubernetes would expand $(VAR) in an env value.
case "$hook" in *'$('*) fail "hook contains \$( which Kubernetes expands" ;; esac

if [ "$fails" -gt 0 ]; then
    echo "$fails failure(s)" >&2
    exit 1
fi
echo "pre-server-run-hook: all tests passed"
