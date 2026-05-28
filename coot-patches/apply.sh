#!/bin/bash
# Apply NCS ghost + single-water patches to the coot-1.0 checkout
# Run after `./moorhen_build.sh` has cloned coot but before building moorhen target

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COOT_DIR="$(dirname "$SCRIPT_DIR")/checkout/coot-1.0"

if [ ! -d "$COOT_DIR" ]; then
    echo "Error: coot-1.0 not found at $COOT_DIR"
    echo "Run ./moorhen_build.sh first (it will clone coot, then fail)"
    exit 1
fi

# Copy the new .cc files
cp "$SCRIPT_DIR/molecules-container-ncs-ghost.cc" "$COOT_DIR/api/"
cp "$SCRIPT_DIR/molecules-container-add-water-at-position.cc" "$COOT_DIR/api/"
cp "$SCRIPT_DIR/molecules-container-set-phi-psi.cc" "$COOT_DIR/api/"

# Apply the header patch (declares get_ncs_ghost_matrix + add_water_at_position)
cd "$COOT_DIR"
if ! grep -q "get_ncs_ghost_matrix" api/molecules-container.hh; then
    git apply "$SCRIPT_DIR/molecules-container.hh.patch"
fi

# Declare set_phi_psi just after add_water_at_position. Done by in-place insertion
# (not a git diff) so it's robust to upstream line drift in molecules-container.hh.
if ! grep -q "set_phi_psi" api/molecules-container.hh; then
    perl -i -pe 's/(std::string add_water_at_position\(int imol, float x, float y, float z\);)/$1\n   int set_phi_psi(int imol, const std::string \&residue_cid, double phi, double psi);/' api/molecules-container.hh
    grep -q "set_phi_psi" api/molecules-container.hh || { echo "ERROR: failed to insert set_phi_psi decl"; exit 1; }
fi

# Commit so the build script's version check passes. We commit ON the checked-out
# main branch, which advances main to this commit directly — no `git branch -f`
# needed (and it would fail anyway: git refuses to force-update a branch that's
# checked out in a worktree).
git add api/
git -c user.email="build@local" -c user.name="Build" commit -m "Apply PyKeko coot patches (NCS ghost, single-water, set_phi_psi)" --allow-empty > /dev/null
NEW_HASH=$(git rev-parse --short=10 HEAD)

# Update VERSIONS to match
cd "$(dirname "$SCRIPT_DIR")"
sed -i.bak "s/coot_commit=\".*\"/coot_commit=\"$NEW_HASH\"/" VERSIONS
rm -f VERSIONS.bak

echo "Patches applied. coot_commit pinned to $NEW_HASH"
