#!/usr/bin/env bash
# release.sh — Create a kamori release
#
# Bumps package.json versions, commits, pushes, tags, and pushes the tag.
# Pushing the tag triggers release.yml which publishes to npm/PyPI/Docker.
#
# Usage:
#   ./scripts/release.sh <version> [--only <pkg,...>] [--dry-run]
#
#   version   patch | minor | major | x.y.z | x.y.z-pre.n
#   --only    comma-separated subset: sdk, mcp, ingest, cli  (default: all four)
#   --dry-run show plan without making changes
#
# Examples:
#   ./scripts/release.sh patch
#   ./scripts/release.sh minor --only mcp,sdk
#   ./scripts/release.sh 2.0.0
#   ./scripts/release.sh 1.0.0-rc.1 --only sdk

set -euo pipefail

# ─── colour helpers ───────────────────────────────────────────────────────────
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
die()    { red "error: $*" >&2; exit 1; }
step()   { echo ""; bold "$*"; }

usage() {
  grep '^#' "$0" | sed -n '/Usage:/,/^[^#]/p' | sed 's/^# \?//' | head -n -1
  exit 1
}

# ─── package lookup (bash 3 compatible) ───────────────────────────────────────
pkg_path() {
  case "$1" in
    sdk)    echo "packages/sdk" ;;
    mcp)    echo "packages/mcp" ;;
    ingest) echo "packages/ingest" ;;
    cli)    echo "packages/npx-kamori" ;;
    *)      die "unknown package '$1'. Valid: sdk, mcp, ingest, cli" ;;
  esac
}

pkg_npm() {
  case "$1" in
    sdk)    echo "@usekamori/sdk" ;;
    mcp)    echo "@usekamori/mcp" ;;
    ingest) echo "@usekamori/ingest" ;;
    cli)    echo "kamori" ;;
    *)      die "unknown package '$1'" ;;
  esac
}

ALL_PKGS="sdk mcp ingest cli"

# ─── parse args ───────────────────────────────────────────────────────────────
VERSION_ARG=""
ONLY=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)    ONLY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    -*)        die "unknown flag: $1" ;;
    *)
      [[ -n "$VERSION_ARG" ]] && die "unexpected argument: $1"
      VERSION_ARG="$1"; shift ;;
  esac
done

[[ -z "$VERSION_ARG" ]] && usage

# ─── resolve target packages ──────────────────────────────────────────────────
if [[ -z "$ONLY" ]]; then
  TARGETS="$ALL_PKGS"
else
  TARGETS="${ONLY//,/ }"
  for t in $TARGETS; do pkg_path "$t" > /dev/null; done  # validates each alias
fi

# ─── repo root ────────────────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repo"
cd "$REPO_ROOT"

# ─── pre-flight ───────────────────────────────────────────────────────────────
step "Pre-flight checks"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "must be on main (currently on '$BRANCH')"
green "  ✓ on main"

[[ -z "$(git status --porcelain)" ]] || die "working tree has uncommitted changes — commit or stash first"
green "  ✓ clean working tree"

git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[[ "$LOCAL" == "$REMOTE" ]] || die "local main is behind origin/main — run 'git pull' first"
green "  ✓ up to date with origin/main"

# ─── resolve new version ──────────────────────────────────────────────────────
FIRST="$(echo "$TARGETS" | awk '{print $1}')"
CURRENT="$(node -p "require('./"$(pkg_path "$FIRST")"/package.json').version")"

case "$VERSION_ARG" in
  patch|minor|major)
    NEW_VERSION="$(node -e "
      const [ma, mi, pa] = '${CURRENT}'.split('-')[0].split('.').map(Number);
      const t = '${VERSION_ARG}';
      if (t === 'major') process.stdout.write((ma+1)+'.0.0');
      else if (t === 'minor') process.stdout.write(ma+'.'+(mi+1)+'.0');
      else process.stdout.write(ma+'.'+mi+'.'+(pa+1));
    ")"
    ;;
  [0-9]*)
    NEW_VERSION="$VERSION_ARG"
    ;;
  *)
    die "invalid version '$VERSION_ARG'. Use patch|minor|major or explicit semver"
    ;;
esac

[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "could not compute a valid semver from '$VERSION_ARG'"

TAG="v${NEW_VERSION}"

# ─── check tag doesn't already exist ─────────────────────────────────────────
git tag -l "$TAG" | grep -q "$TAG" && die "tag $TAG already exists locally"
git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "$TAG" && die "tag $TAG already exists on remote"

# ─── show plan ────────────────────────────────────────────────────────────────
step "Release plan"
echo "  Tag:     $TAG"
echo "  Trigger: release.yml → test → publish npm + PyPI + Docker + GitHub Release"
echo "  Packages:"
for t in $TARGETS; do
  CUR="$(node -p "require('./"$(pkg_path "$t")"/package.json').version")"
  printf "    %-8s  %-22s  %s → %s\n" "$t" "$(pkg_npm "$t")" "$CUR" "$NEW_VERSION"
done

# Show skipped packages
SKIPPED=""
for t in $ALL_PKGS; do
  echo "$TARGETS" | grep -qw "$t" || SKIPPED="$SKIPPED $(pkg_npm "$t")"
done
if [[ -n "$SKIPPED" ]]; then
  echo ""
  echo "  Skipped (unchanged — publish-npm will skip these automatically):"
  for n in $SKIPPED; do printf "    %s\n" "$n"; done
fi
echo ""

if $DRY_RUN; then
  yellow "Dry-run — no changes made."
  exit 0
fi

read -r -p "Proceed? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { yellow "Aborted."; exit 0; }

# ─── bump package.json versions ───────────────────────────────────────────────
step "Bumping versions"
for t in $TARGETS; do
  PKG_FILE="$(pkg_path "$t")/package.json"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('${PKG_FILE}', 'utf8'));
    pkg.version = '${NEW_VERSION}';
    fs.writeFileSync('${PKG_FILE}', JSON.stringify(pkg, null, 2) + '\n');
  "
  green "  ✓ $(pkg_npm "$t") → $NEW_VERSION"
done

# ─── commit ───────────────────────────────────────────────────────────────────
step "Committing"
for t in $TARGETS; do git add "$(pkg_path "$t")/package.json"; done
git commit -m "chore: release $TAG"
green "  ✓ committed"

# ─── push main ────────────────────────────────────────────────────────────────
step "Pushing main"
git push origin main
green "  ✓ pushed"

# ─── tag + push ───────────────────────────────────────────────────────────────
step "Tagging $TAG"
git tag "$TAG"
git push origin "$TAG"
green "  ✓ tag pushed — release.yml is now running"

echo ""
bold "Done."
echo "  https://github.com/usekamori/kamori/actions"
echo ""
