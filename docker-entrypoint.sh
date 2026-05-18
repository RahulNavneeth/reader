#!/bin/sh
# Reader entrypoint.
#
# Handles the two big self-hosted EACCES traps:
#
#   1. Bind-mounted /data + /vault that exist on the host with a
#      different uid/gid than the in-container `reader` user. Linux
#      preserves the host's numeric ownership inside the container,
#      so writes fail with EPERM.
#
#   2. Volumes that don't exist yet, or were touched by root during
#      a `docker compose run` before the user fixed permissions.
#
# Solution: honor PUID / PGID env vars (the linuxserver.io convention
# every self-hosted user already knows), remap the reader user to
# those ids, then chown the data dirs before exec'ing the server.
#
# Skipped entirely when not running as root (e.g. Kubernetes with
# securityContext.runAsNonRoot=true).

set -e

PUID="${PUID:-10001}"
PGID="${PGID:-10001}"

if [ "$(id -u)" = "0" ]; then
  # Remap the reader user if PUID/PGID differ from the baked-in 10001.
  if [ "$(id -u reader)" != "$PUID" ] || [ "$(id -g reader)" != "$PGID" ]; then
    groupmod -o -g "$PGID" reader 2>/dev/null || true
    usermod  -o -u "$PUID" -g "$PGID" reader 2>/dev/null || true
  fi

  # Take ownership of the mounted volumes — only if they're not
  # already owned by reader, so we don't slow boot down on large
  # vaults that are already correct.
  for d in /data /vault; do
    if [ -d "$d" ] && [ "$(stat -c %u "$d" 2>/dev/null)" != "$PUID" ]; then
      chown -R "$PUID:$PGID" "$d" || echo "[entrypoint] couldn't chown $d (read-only mount?)" >&2
    fi
  done

  exec gosu reader:reader "$@"
fi

# Not root — Kubernetes-style or `docker run --user`. Just exec.
exec "$@"
