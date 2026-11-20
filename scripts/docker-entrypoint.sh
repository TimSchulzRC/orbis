#!/bin/sh
# Starts the server in the container as the owner of /data, never as root. Docker creates a
# missing data folder as root; it then goes to ORBIS_UID:ORBIS_GID (default 1000:1000). An
# existing folder keeps its owner unless ORBIS_UID/ORBIS_GID name another one. Whatever in it
# belongs to someone else or cannot be written (made on the host, e.g. in a NAS file manager) is
# handed over first, so the server never fails on its own data.
set -eu
if [ "$(id -u)" = 0 ]; then
  owner=$(stat -c '%u:%g' /data)
  if [ -n "${ORBIS_UID:-}${ORBIS_GID:-}" ]; then
    want=${ORBIS_UID:-1000}:${ORBIS_GID:-1000}
  elif [ "${owner%%:*}" != 0 ]; then
    want=$owner
  else
    want=1000:1000
  fi
  uid=${want%%:*}
  gid=${want#*:}
  writable() { setpriv --reuid "$uid" --regid "$gid" --clear-groups test -w /data; }
  if [ -n "$(find /data \( ! -user "$uid" -o ! -group "$gid" \) -print -quit)" ] || ! writable; then
    echo "[orbis] handing /data to $want" >&2
    chown -R "$want" /data
    chmod -R u+rwX /data
  fi
  writable || {
    echo "[orbis] $want cannot write /data; set ORBIS_UID/ORBIS_GID to a user that may" >&2
    exit 1
  }
  exec setpriv --reuid "$uid" --regid "$gid" --clear-groups "$@"
fi
exec "$@"
