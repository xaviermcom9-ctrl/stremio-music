#!/bin/sh
# Runs as root under tini: prepare volumes, then drop to PUID:PGID and exec the backend.
# If the container is started with `user:` (non-root), skip straight to the backend.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
umask "${UMASK:-022}"

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

case "$PUID$PGID" in *[!0-9]*) echo "PUID/PGID must be numeric" >&2; exit 1 ;; esac
if [ "$PUID" = "0" ]; then
  echo "warning: running as root (PUID=0) is not recommended" >&2
fi

# Our own state: fix ownership (recursively only when the top level is wrong, so big caches
# aren't walked on every start).
for d in /config /cache; do
  mkdir -p "$d"
  if [ "$(stat -c %u:%g "$d")" != "$PUID:$PGID" ]; then
    echo "setting ownership of $d to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$d"
  fi
done

# A bind-mount directory Docker just created is root-owned and empty: hand it over.
if [ -d /downloads ] && [ "$(stat -c %u /downloads)" = "0" ] && [ -z "$(ls -A /downloads)" ]; then
  chown "$PUID:$PGID" /downloads
fi

# Shared with Navidrome etc.: never chown recursively, only report.
for d in /music /downloads; do
  [ -d "$d" ] || continue
  if ! setpriv --reuid="$PUID" --regid="$PGID" --clear-groups test -w "$d"; then
    echo "warning: $d is not writable by $PUID:$PGID (downloads into it will fail)" >&2
  fi
done

export HOME=/config
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all "$@"
