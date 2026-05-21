#!/bin/bash
# Apply NCS ghost patches to the coot-1.0 checkout
# Run after `./moorhen_build.sh` has cloned coot but before building moorhen target

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COOT_DIR="$(dirname "$SCRIPT_DIR")/checkout/coot-1.0"

if [ ! -d "$COOT_DIR" ]; then
    echo "Error: coot-1.0 not found at $COOT_DIR"
    echo "Run ./moorhen_build.sh first (it will clone coot, then fail)"
    exit 1
fi

# Copy the new .cc file
cp "$SCRIPT_DIR/molecules-container-ncs-ghost.cc" "$COOT_DIR/api/"

# Apply the header patch
cd "$COOT_DIR"
if ! grep -q "get_ncs_ghost_matrix" api/molecules-container.hh; then
    git apply "$SCRIPT_DIR/molecules-container.hh.patch"
fi

# Commit so the build script's version check passes
git add api/
git -c user.email="build@local" -c user.name="Build" commit -m "Apply NCS ghost patches" --allow-empty > /dev/null
NEW_HASH=$(git rev-parse --short=10 HEAD)
git branch -f main HEAD

# Update VERSIONS to match
cd "$(dirname "$SCRIPT_DIR")"
sed -i.bak "s/coot_commit=\".*\"/coot_commit=\"$NEW_HASH\"/" VERSIONS
rm -f VERSIONS.bak

echo "Patches applied. coot_commit pinned to $NEW_HASH"
