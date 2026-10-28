#!/bin/sh
# Starts as root only to settle the data folder, then runs the server unprivileged as the
# folder's owner – so the files on the host keep the owner they had (a NAS user, a backup job).
# A folder Docker just created belongs to root: it is handed to the user bun (1000).
set -e
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data
  if [ "$(stat -c %u /data)" = 0 ]; then chown -R bun:bun /data; fi
  exec setpriv --reuid="$(stat -c %u /data)" --regid="$(stat -c %g /data)" --clear-groups -- "$@"
fi
exec "$@"
