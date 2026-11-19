#!/usr/bin/env bash
# Pretty Server Manager update - run by `make update` (and by the agent).
# Backs up the project, downloads the newest release of its channel (or
# PRETTY_RELEASE=<id>) from the manager and unpacks it over the code.
# Data that is not in the repository (.env, storage, backups, the database)
# is left alone. `make update` rebuilds the stack afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=.pretty/manager.env
[ -f "$CONFIG" ] || { echo "✖ $CONFIG is missing - install from the manager or run npx pretty manager pair"; exit 1; }
get() { sed -n "s/^$1=//p" "$CONFIG" | tail -1; }

URL="$(get MANAGER_URL)"
CHANNEL="$(get CHANNEL)"; CHANNEL="${CHANNEL:-release}"
TOKEN="$(get AGENT_TOKEN)"; [ -n "$TOKEN" ] || TOKEN="$(get INSTALL_KEY)"
RELEASE="${PRETTY_RELEASE:-latest}"
[ -n "$URL" ] && [ -n "$TOKEN" ] || { echo "✖ $CONFIG has no MANAGER_URL / token"; exit 1; }

# Step markers for the agent; plain progress lines for people.
step() { if [ -n "${PRETTY_RELEASE:-}" ]; then echo "::step $1"; else echo "→ $1"; fi; }
current_id() { sed -n 's/^RELEASE_ID=//p' .pretty-release 2>/dev/null | tail -1; }
header() { sed -n "s/^$1: *//Ip" "$HEADERS" | tr -d '\r' | tail -1; }

if [ -z "${PRETTY_BACKUP_DONE:-}" ]; then
  step backup
  if grep -qsE '^backup:' Makefile scripts/make/*.mk; then
    make --no-print-directory backup
  fi
  mkdir -p .pretty/backups
  SNAPSHOT=".pretty/backups/$(date +%Y-%m-%d_%H-%M-%S)-code.tar.gz"
  tar -czf "$SNAPSHOT" --exclude=./node_modules --exclude=./.next --exclude=./backups \
    --exclude=./.pretty/backups --exclude=./storage --exclude=./docker/mariadb . \
    && echo "Code snapshot: $SNAPSHOT"
  ls -1t .pretty/backups/*-code.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
fi

step download
ARCHIVE="$(mktemp)"; HEADERS="$(mktemp)"
trap 'rm -f "$ARCHIVE" "$HEADERS"' EXIT

CODE="$(curl -sS -L -D "$HEADERS" -o "$ARCHIVE" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: pretty-update" \
  "$URL/api/releases/$RELEASE/download?channel=$CHANNEL")" || CODE=000
if [ "$CODE" != "200" ]; then
  echo "✖ Download failed (HTTP $CODE): $(head -c 300 "$ARCHIVE" 2>/dev/null)"
  exit 1
fi

ID="$(header x-release-id)"
VERSION="$(header x-release-version)"
COMMIT="$(header x-release-commit)"

if [ "$RELEASE" = "latest" ] && [ -n "$ID" ] && [ "$ID" = "$(current_id)" ]; then
  echo "Already on $VERSION (release $ID) - rebuilding only."
else
  echo "Release $VERSION (#$ID, ${COMMIT:0:7})"
  # Git checkouts move to the release commit; anything else is unpacked.
  if [ -d .git ] && [ -n "$COMMIT" ] && git fetch -q origin "$COMMIT" 2>/dev/null; then
    git -c advice.detachedHead=false checkout -q --detach "$COMMIT"
    printf 'RELEASE_ID=%s\nRELEASE_VERSION=%s\nRELEASE_COMMIT=%s\n' "$ID" "$VERSION" "$COMMIT" > .pretty-release
    echo "Checked out $COMMIT"
  else
    tar -xzf "$ARCHIVE" -C .
    echo "Unpacked into $(pwd)"
  fi
fi

step deploy
