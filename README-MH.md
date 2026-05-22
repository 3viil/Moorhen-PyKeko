# MoorHenMH — Customized Moorhen Fork

A personal fork of [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen) with Coot 0.9.x-style keyboard shortcuts, UX defaults, and a few features added beyond upstream.

**Upstream**: [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen)
**This fork**: [3viil/MoorHenMH](https://github.com/3viil/MoorHenMH)
**Desktop wrapper**: [3viil/MoorhenWrapper](https://github.com/3viil/MoorhenWrapper)
**Claude/MCP server**: [3viil/MoorhenMCP](https://github.com/3viil/MoorhenMCP)
**Full project notes**: [PROJECT-NOTES.md](PROJECT-NOTES.md)

## Headline additions vs upstream

### NCS Ghosts (new)

Visualize non-crystallographic symmetry by overlaying every NCS-related chain *transformed onto* a chosen master chain — translucent, color-cycled, computed in C++ via SSM alignment.

- **`g` shortcut** — toggles ghosts on the chain under the cursor (most useful entry point)
- **NCS Ghosts accordion** in the per-molecule card — chain selector + opacity slider, stays open
- Adds a new C++ binding `get_ncs_ghost_matrix(imol, master, copy)` exposed via Embind
- Built on instanced bond rendering via the existing `symmetryMatrices` path — no shader changes

### `o` — NCS jump

Cycle through NCS-related chains at the same residue number. Useful to walk between equivalent positions in an oligomer.

### `l` — Go to next ligand

Cycles through every ligand across every loaded molecule. Toast shows `<resName> <chain>/<resNum>`.

### Claude control via MCP

[MoorhenMCP](https://github.com/3viil/MoorhenMCP) is a Model Context Protocol server that drives a running MoorhenLocal/MoorhenDev app from Claude (load coords/maps, navigate, refine, rotamer fit, flip peptide, add waters, delete, undo/redo, screenshot). The Electron wrapper (token-authenticated HTTP control server) and the in-page bridge (`MoorhenControlApi` / `MoorhenControlBridge`) are part of this fork.

## What's different from upstream

### Keyboard shortcuts (Coot-style)

Shortcuts only fire when the mouse cursor is over the 3D canvas (Moorhen convention). With "Use shortcut on hovered atom" enabled (now the default), they operate on whatever residue the mouse is hovering over.

| Key | Action | Notes |
|-----|--------|-------|
| `w` | Add waters | Batch auto-place by map density |
| `a` | Autofit rotamer | |
| `r` | Triple refine | Refine 3 residues (active + 2 neighbors) |
| `e` | Flip peptide | |
| `t` | Add terminal residue | |
| `j` | Jiggle fit | 100 trials, 1.0 Å range |
| `k` | Delete sidechain | Keeps backbone atoms |
| `l` | Go to next ligand (cycles) | Cycles through all ligands across all loaded molecules |
| `o` | NCS jump | Cycle through NCS-related chains at the same residue |
| `g` | Toggle NCS ghosts | Translucent NCS copies overlaid on the hovered chain |
| `z` | Autofit rotamer (alt) | Duplicate of `a` |
| `Shift+F` | Fill partial residue | |
| `Shift+H` | Refine active residue (single) | |
| `Shift+L` | Label atom on click | |
| `Shift+R` | Sphere refine (unchanged) | 4Å sphere |
| `Shift+S` | Quick-save coordinates | |

### Conflict resolution (Moorhen defaults relocated)

| Key | Was (upstream) | Now |
|-----|----------------|-----|
| `a` | Measure arbitrary distances | Moved to `d` |
| `r` | Restore scene | Moved to `v` |
| `g` | Go to blob | Moved to `b` (`g` now toggles NCS ghosts) |
| `l` | Label atom on click | Moved to `Shift+L` |
| `z` | Wiggle camera | Unbound |

### UX behavior changes

- **Background**: black (was white)
- **Default representation**: bonds (was ribbons)
- **Hydrogens**: hidden by default (was shown)
- **Shortcut mode**: on hovered atom (was center-of-view)
- **Drag-and-drop a `.cif` dictionary file** while molecules are loaded → attaches the dictionary to existing molecules (fixes their ligand bonds), instead of creating a new monomer molecule
- **Import Ligand Dictionary** dialog:
  - "Create instance on read" toggle defaults to **off**
  - "Make monomer available to" defaults to the first loaded molecule (not "Any")
  - Toggle is now functional (was always-on regardless of the checkbox)
- **Loading a ligand dictionary** marks atoms dirty so bonds refresh on next redraw (previously bonds didn't update until other actions triggered a refetch)

## Files modified / added

```
# Coot C++ patch (applied to checkout/coot-1.0)
coot-patches/molecules-container-ncs-ghost.cc        # new SSM-based NCS matrix
coot-patches/molecules-container.hh.patch
coot-patches/apply.sh

# WASM bindings
wasm_src/moorhen-wrappers.cc                          # +get_ncs_ghost_matrix binding
wasm_src/CMakeLists.txt                               # +molecules-container-ncs-ghost.cc

# Moorhen TS / React (Coot-style shortcuts, UX, NCS ghosts, MCP bridge)
baby-gru/src/components/managers/preferences/DefaultShortcuts.ts
baby-gru/src/components/managers/preferences/PreferencesList.ts
baby-gru/src/components/menu-item/ImportLigandDictionary.tsx
baby-gru/src/components/card/MoleculeCard/MoleculeCard.tsx                       # +NCS Ghosts accordion
baby-gru/src/components/card/MoleculeCard/MoleculeRepresentationSettingsCard.tsx # +NcsGhostsSettingsPanel
baby-gru/src/components/container/MainContainer.tsx                              # +control bridge mount
baby-gru/src/api/MoorhenControlApi.ts                                            # new — JS facade for MCP
baby-gru/src/api/MoorhenControlBridge.tsx                                        # new — wrapper IPC bridge
baby-gru/src/moorhen.ts
baby-gru/src/utils/MoorhenFileLoading.ts
baby-gru/src/utils/MoorhenKeyboardPress.ts
baby-gru/src/utils/MoorhenMolecule.ts                                            # +drawNcsGhosts/clearNcsGhosts
baby-gru/src/utils/MoorhenMoleculeRepresentation.ts
baby-gru/src/utils/windowCootCCP4Loader.ts                                       # 32-bit force signal
baby-gru/src/InstanceManager/CommandCentre/CootWorker.ts                         # 32-bit force signal
baby-gru/src/InstanceManager/CommandCentre/MoorhenCommandCentre.ts
baby-gru/vite.config.mts
```

## Pulling upstream changes

The fork tracks upstream `moorhen-coot/Moorhen`:

```bash
git fetch upstream
git merge upstream/main
# resolve any conflicts
git push origin main
```

## Building from scratch

See [PROJECT-NOTES.md](PROJECT-NOTES.md) for the full new-machine setup. The short version:

```bash
# Prerequisites
brew install ninja meson cmake autoconf automake pkg-config gh
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest

# Clone
git clone https://github.com/3viil/MoorHenMH.git ~/Moorhen
cd ~/Moorhen
git remote add upstream https://github.com/moorhen-coot/Moorhen.git

# Build WASM (takes ~1 hour first time)
source ~/emsdk/emsdk_env.sh
export PATH=/opt/homebrew/bin:$PATH
./moorhen_build.sh
./moorhen_build.sh --64bit

# Run the dev server
cd baby-gru
npm install
npm start
# Open http://localhost:5173/ in Chrome
```

For the desktop wrapper (single-click `.app`), see [3viil/MoorhenWrapper](https://github.com/3viil/MoorhenWrapper).
