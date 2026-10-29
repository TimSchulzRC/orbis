#!/bin/sh
# Starts the server in the container as the owner of /data, never as root. Docker creates a
# missing data folder as root; it then goes to OBTION_UID:OBTION_GID (default 1000:1000). An
# existing folder keeps its owner unless OBTION_UID/OBTION_GID name another one.
set -eu
if [ "$(id -u)" = 0 ]; then
  owner=$(stat -c '%u:%g' /data)
  if [ -n "${OBTION_UID:-}${OBTION_GID:-}" ]; then
    want=${OBTION_UID:-1000}:${OBTION_GID:-1000}
  elif [ "${owner%%:*}" != 0 ]; then
    want=$owner
  else
    want=1000:1000
  fi
  [ "$owner" = "$want" ] || chown -R "$want" /data
  exec setpriv --reuid "${want%%:*}" --regid "${want#*:}" --clear-groups "$@"
fi
exec "$@"
