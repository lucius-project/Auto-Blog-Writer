#!/bin/sh
# Nightly backup loop (runs inside the backup container).
#  - full pg_dump of the abw database (gzipped)
#  - tarball of the Octane sessions + .env (the two things GitHub deliberately
#    does NOT have — losing them means re-entering keys and re-doing logins)
#  - keeps 30 days, deletes older
set -u
while true; do
  STAMP=$(date +%Y%m%d-%H%M)
  echo "[backup] $STAMP starting"
  if pg_dump -h postgres -U abw abw | gzip > "/backups/db-$STAMP.sql.gz.tmp"; then
    mv "/backups/db-$STAMP.sql.gz.tmp" "/backups/db-$STAMP.sql.gz"
    echo "[backup] db-$STAMP.sql.gz ($(du -h /backups/db-$STAMP.sql.gz | cut -f1))"
  else
    rm -f "/backups/db-$STAMP.sql.gz.tmp"
    echo "[backup] DB DUMP FAILED"
  fi
  rm -rf /tmp/snap && mkdir -p /tmp/snap/secrets
  cp /host-env /tmp/snap/dot-env 2>/dev/null || true
  cp -r /host-secrets/. /tmp/snap/secrets/ 2>/dev/null || true
  if tar czf "/backups/secrets-$STAMP.tar.gz" -C /tmp/snap .; then
    echo "[backup] secrets-$STAMP.tar.gz ($(du -h /backups/secrets-$STAMP.tar.gz | cut -f1))"
  else
    echo "[backup] SECRETS BACKUP FAILED"
  fi
  rm -rf /tmp/snap
  find /backups -name "*.gz" -mtime +30 -delete
  echo "[backup] done — $(ls /backups | wc -l) files retained, next run in 24h"
  sleep 86400
done
