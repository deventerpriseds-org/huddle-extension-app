#!/bin/bash
# WHAT:          Starts (idempotently) a THROWAWAY local Postgres 16 with SSL on 127.0.0.1:54329, trust auth,
#                so the store layer's REAL SQL can be exercised from a CCR session.
# WHY:           The live Azure PG is unreachable from CCR (TCP 5432 blocked, no creds — see CLAUDE.md), so
#                SQL-shape claims (ORDER BY, CAS UPDATEs, ADD COLUMN backfills) were previously only ever
#                checked by mocks that re-implement the SQL in JS. The app's pg pool always requests SSL
#                (ssl:{rejectUnauthorized:false}), so the server must speak SSL — a self-signed cert is made.
# SUPERSEDES:    nothing.
# SUPERSEDED-BY: nothing -- current.
# EVIDENCE:      scripts/confirm-reask-db.test.ts runs against it (.claude/IMPL-confirm-ask-rotation.md).
# Usage:         bash scripts/local-pg-up.sh   then
#                LOCAL_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:54329/postgres bun scripts/confirm-reask-db.test.ts
# The data dir lives under /var/tmp because the postgres user must be able to traverse every parent dir.
set -e
D=/var/tmp/eds-reask-pg
BIN=/usr/lib/postgresql/16/bin
mkdir -p "$D"
chown postgres "$D"
if [ ! -f "$D/db/PG_VERSION" ]; then
  (cd /tmp && runuser -u postgres -- "$BIN/initdb" -D "$D/db" -A trust -U postgres >/dev/null)
  (cd "$D" && openssl req -new -x509 -days 30 -nodes -subj "/CN=localhost" -keyout server.key -out server.crt >/dev/null 2>&1)
  cp "$D/server.key" "$D/server.crt" "$D/db/"
  chown postgres "$D/db/server.key" "$D/db/server.crt"
  chmod 600 "$D/db/server.key"
fi
if ! (cd /tmp && runuser -u postgres -- "$BIN/pg_ctl" -D "$D/db" status >/dev/null 2>&1); then
  (cd /tmp && runuser -u postgres -- "$BIN/pg_ctl" -D "$D/db" -o "-p 54329 -k /tmp -c ssl=on -c listen_addresses=127.0.0.1" -l "$D/log.txt" -w start)
fi
psql "postgresql://postgres@127.0.0.1:54329/postgres?sslmode=require" -tAc "select 'local pg up: ' || version()"
