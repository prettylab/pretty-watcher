#!/usr/bin/env bash
# Publishes the package in the current folder to npm. Works for any package:
# name, version and checks come from its package.json.
#
#   bash scripts/publish.sh                 publish the version in package.json
#   bash scripts/publish.sh patch|minor|major|1.2.3   bump first, then publish
#   options: --dry-run      build and pack, publish nothing, change nothing
#            --tag <tag>    npm dist-tag (default: latest, "next" for prereleases)
#            --otp <code>   npm one-time password (2FA)
#            --no-git       no commit / tag after publishing
#            --allow-dirty  publish with uncommitted changes
#
# Steps: checks (node, npm login, git state, version not on npm yet) -> bump ->
# npm ci -> prepublishOnly (typecheck, tests, build) -> npm pack preview ->
# npm publish -> git commit "release vX" + tag vX.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; E=$'\033[31m'; C=$'\033[36m'; R=$'\033[0m'
else B=""; D=""; G=""; Y=""; E=""; C=""; R=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$C" "$*" "$R"; }
fail() { printf '%s✖ %s%s\n' "$E" "$*" "$R" >&2; exit 1; }

BUMP=""; DRY=0; TAG=""; OTP=""; GIT=1; DIRTY=0
while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major|prepatch|preminor|premajor|prerelease) BUMP="$1" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$1" ;;
    --dry-run) DRY=1 ;;
    --tag) TAG="${2:?--tag needs a value}"; shift ;;
    --otp) OTP="${2:?--otp needs a value}"; shift ;;
    --no-git) GIT=0 ;;
    --allow-dirty) DIRTY=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown argument: $1 (see --help)" ;;
  esac
  shift
done

command -v node >/dev/null || fail "node is required"
command -v npm >/dev/null || fail "npm is required"
[ -f package.json ] || fail "No package.json here"

pkg() { node -p "require('./package.json').$1 ?? ''"; }
NAME="$(pkg name)"
[ -n "$NAME" ] || fail "package.json has no name"
[ "$(pkg private)" != "true" ] || fail "$NAME is private"

say ""
say "  ${B}${NAME}${R} ${D}$(pkg version)${R}"

step "Checks"
if [ "$DRY" -eq 0 ]; then
  WHO="$(npm whoami 2>/dev/null)" || fail "Not logged in to npm - run: npm login"
  say "  npm user: $WHO"
fi
IN_GIT=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  IN_GIT=1
  if [ "$DIRTY" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
    git status --short
    fail "Uncommitted changes - commit them first, or pass --allow-dirty"
  fi
  say "  git: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
fi

if [ -n "$BUMP" ]; then
  step "Version: $BUMP"
  if [ "$DRY" -eq 1 ]; then
    cp package.json "${TMPDIR:-/tmp}/publish-package.json.$$"
    [ -f package-lock.json ] && cp package-lock.json "${TMPDIR:-/tmp}/publish-lock.json.$$"
    trap 'mv "${TMPDIR:-/tmp}/publish-package.json.$$" package.json; [ -f "${TMPDIR:-/tmp}/publish-lock.json.$$" ] && mv "${TMPDIR:-/tmp}/publish-lock.json.$$" package-lock.json' EXIT
  fi
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi
VERSION="$(pkg version)"
say "  publishing ${B}${NAME}@${VERSION}${R}"

if npm view "${NAME}@${VERSION}" version >/dev/null 2>&1; then
  fail "${NAME}@${VERSION} is already on npm - bump it: bash scripts/publish.sh patch"
fi
PUBLISHED="$(npm view "$NAME" version 2>/dev/null || true)"
say "  on npm now: ${PUBLISHED:-nothing yet}"

if [ -z "$TAG" ]; then
  case "$VERSION" in *-*) TAG="next" ;; *) TAG="latest" ;; esac
fi

step "Install"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

# prepublishOnly would also run inside npm publish; running it here first
# means a failing test stops the script before anything is uploaded.
if [ -n "$(pkg 'scripts?.prepublishOnly')" ]; then
  step "npm run prepublishOnly"
  npm run prepublishOnly
elif [ -n "$(pkg 'scripts?.build')" ]; then
  step "npm run build"
  npm run build
fi

step "Package contents"
npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | sed '$d'

if [ "$DRY" -eq 1 ]; then
  step "Dry run: nothing published"
  npm publish --dry-run --ignore-scripts --tag "$TAG" >/dev/null
  say "  ${G}✔${R} ${NAME}@${VERSION} would be published with tag ${TAG}"
  exit 0
fi

step "npm publish (tag ${TAG})"
ARGS=(publish --ignore-scripts --tag "$TAG")
[ -n "$OTP" ] && ARGS+=(--otp "$OTP")
[ "$(pkg 'publishConfig?.access')" ] || ARGS+=(--access public)
npm "${ARGS[@]}"

if [ "$GIT" -eq 1 ] && [ "$IN_GIT" -eq 1 ]; then
  step "Git"
  if [ -n "$BUMP" ]; then
    git add package.json
    [ -f package-lock.json ] && git add package-lock.json
    git commit -m "release v${VERSION}" >/dev/null && say "  committed release v${VERSION}"
  fi
  if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    say "  ${Y}!${R} tag v${VERSION} already exists"
  else
    git tag "v${VERSION}" && say "  tagged v${VERSION}"
  fi
  say "  ${D}push with: git push && git push --tags${R}"
fi

say ""
say "  ${G}✔${R} ${B}${NAME}@${VERSION}${R} published - npm install ${NAME}@${VERSION}"
