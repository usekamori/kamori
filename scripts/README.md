kamori/scripts/release.sh — usage:

# Release all 4 packages (patch bump: 1.0.0 → 1.0.1)

./scripts/release.sh patch

# Bump only mcp and sdk by a minor version

./scripts/release.sh minor --only mcp,sdk

# Set an explicit version for everything

./scripts/release.sh 2.0.0

# Pre-release for sdk only

./scripts/release.sh 1.0.0-rc.1 --only sdk

# Preview without touching anything

./scripts/release.sh patch --dry-run

What it does, in order:

1. Pre-flight — asserts you're on main, tree is clean, up to date with remote
2. Computes the new version from the first target package's current version
3. Checks the tag doesn't already exist (locally and on remote)
4. Shows the plan (which packages bump, which are skipped)
5. Asks for confirmation
6. Writes new version into the selected package.json files
7. git commit -m "chore: release vX.Y.Z"
8. git push origin main
9. git tag vX.Y.Z && git push origin vX.Y.Z → fires release.yml

Packages not in --only are left at their current version — the publish-npm job's skip-if-published check handles them automatically.
