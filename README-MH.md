# MoorHenMH — Customized Moorhen Fork

A personal fork of [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen) with Coot 0.9.x-style keyboard shortcuts, UX defaults, and a few features added beyond upstream.

**Upstream**: [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen)
**This fork**: [3viil/MoorHenMH](https://github.com/3viil/MoorHenMH)
**Desktop wrapper**: [3viil/MoorhenWrapper](https://github.com/3viil/MoorhenWrapper)
**Claude/MCP server**: [3viil/MoorhenMCP](https://github.com/3viil/MoorhenMCP)
**Full project notes**: [PROJECT-NOTES.md](PROJECT-NOTES.md)

## Headline additions vs upstream

### NCS Ghosts

Visualize non-crystallographic symmetry by overlaying every NCS-related chain *transformed onto* a chosen master chain — translucent, color-cycled, computed in C++ via SSM alignment.

- **`g` shortcut** — toggles ghosts on the chain under the cursor (most useful entry point)
- **NCS Ghosts accordion** in the per-molecule card — chain selector + opacity slider, stays open
- Adds a new C++ binding `get_ncs_ghost_matrix(imol, master, copy)` exposed via Embind
- Built on instanced bond rendering via the existing `symmetryMatrices` path — no shader changes

### `w` — Single water at crosshairs

Replaces upstream's batch `add_waters` on this key. Places a single HOH at the current view centre (auto-uses the molecule's solvent chain, creates one if absent), then single-residue refines the new water against the active map. Adds a C++ wrapper `add_water_at_position(imol, x, y, z)` that returns the new water's CID.

### `p` / `Shift+P` — Difference-map peak cycler

Find the next signed difference-map peak above ±3σ. Sorted by |sigma|; toast announces e.g. `Peak 3/24: -5.2σ`. `Shift+P` walks backward through the same list.

### `n` / `Shift+N` — Validation issue cycler

Merged outlier list across three categories — Ramachandran (p<0.02), rotamer (p<0.02), and density-fit (worst residues by libcoot's `density_fit_analysis`). Each entry is tagged so the toast tells you which kind: `Issue 4/17 (rotamer): //A/123 PHE p=0.018`. Sorted by per-category-normalized badness so worst things come first; `Shift+N` reverses.

### `d` — Drag atoms (interactive refinement)

Equivalent to right-click → "Drag atoms" on the residue under the cursor: enters live-refinement-with-pull mode at the active refinement selection size. Accept/Reject snackbar appears for confirmation.

The selection size is read from `state.refinementSettings.refinementSelection` at press time. Three ways to change it:
- **UI**: top-bar **Preferences → Refinement settings... → Default refinement selection** dropdown (Single residue / Adjacent residues / Sphere).
- **Implicit**: residue-selection mode auto-toggles between SPHERE and TRIPLE.
- **Scripted** (in Interactive Scripting, JS mode): `dispatch(setRefinementSelection("HEPTUPLE"))`. QUINTUPLE/HEPTUPLE exist in the C++ backend but aren't exposed in the dropdown — script is the only way to set them.

### `o` / `Shift+O` — NCS jump

Cycle forward (`o`) or backward (`Shift+O`) through NCS-related chains at the same residue number — useful to walk equivalent positions in an oligomer.

### `l` — Go to next ligand

Cycles through every ligand across every loaded molecule. Toast shows `<resName> <chain>/<resNum>`.

### PyMOL command translator in Interactive Scripting

The **Interactive scripting…** modal has a JavaScript / PyMOL dropdown. PyMOL mode runs a substantial subset of PyMOL commands against the live Moorhen scene — paste a `.pml` script, hit Run, see it execute. Tier coverage:

- **Load / view**: `fetch`, `load`, `delete`, `enable`/`disable`, `zoom`, `orient`, `center`, `set_view`
- **Representation**: `show` / `hide` / `as` for cartoon, sticks, lines, spheres, surface (find-or-create; no duplicate reps)
- **Colour**: `color`, `bg_color`, `spectrum b` with ~50 named PyMOL colours plus `#RRGGBB` / `0xRRGGBB`
- **Full selection algebra**: `chain X+Y`, `resi A-B+C-D`, `name CA+CB`, macros (`polymer.protein`, `solvent`, `hetatm`, `backbone`, `sidechain`, `metals`, `ions`, `lig`), topology ops (`byres`, `bychain`, `byobject`, `bound_to`, `extend N`, `bymolecule`), distance ops (`within N of`, `near_to`, `beyond`, `gap`, `contact`, postfix `around N` and `X within N of Y`), reducers (`first`, `last`), property comparisons (`b > 30`, `q < 0.5`), and named selections via `select`
- **Measurements**: `distance` with a real labelled dashed line in the viewport + snackbar toast + console log
- **Screenshots**: `png` (and `ray` falls back to `png` — no software ray-tracer in Moorhen)
- **Settings**: `set transparency`, `ray_shadow`, `ambient`, `specular`, `rocking`, `fog_start`/`_end`, `ray_trace_mode`, `draw_axes`/`_crosshairs`/`_scale_bar`, …

Anything unsupported (`iterate`, `alter`, `cmd.do`, movie commands, etc.) warns to the console with the line number and continues. .pml files dropped into **Load and execute script…** auto-route to the PyMOL runner.

Full reference at [`docs/pymol-translator.md`](docs/pymol-translator.md); implementation in [PROJECT-NOTES.md](PROJECT-NOTES.md#pymol-command-translator); 62 pure-JS unit tests in `baby-gru/tests/__tests__/pymol*.test.js` (run with `npx jest --testPathPatterns pymol --selectProjects api-utils`).

### Claude control via MCP

[MoorhenMCP](https://github.com/3viil/MoorhenMCP) is a Model Context Protocol server that drives a running MoorhenLocal/MoorhenDev app from Claude (load coords/maps, navigate, refine, rotamer fit, flip peptide, add waters, delete, undo/redo, screenshot). The Electron wrapper (token-authenticated HTTP control server) and the in-page bridge (`MoorhenControlApi` / `MoorhenControlBridge`) are part of this fork.

`MoorhenControlApi` also exposes `runPymol(src)` and `runJs(src)`, used by [the autonomous CDP test loop](PROJECT-NOTES.md#autonomous-cdp-test-loop) — scripts can be driven from outside the app entirely.

## What's different from upstream

### Keyboard shortcuts (Coot-style)

Shortcuts only fire when the mouse cursor is over the 3D canvas (Moorhen convention). With "Use shortcut on hovered atom" enabled (now the default), they operate on whatever residue the mouse is hovering over.

| Key | Action | Notes |
|-----|--------|-------|
| `w` | Single water at crosshairs + refine | Replaces upstream batch `add_waters`; auto-uses solvent chain |
| `a` | Autofit rotamer | |
| `r` | Triple refine | Refine 3 residues (active + 2 neighbors) |
| `e` | Flip peptide | |
| `t` | Add terminal residue | |
| `j` | Jiggle fit | 100 trials, 1.0 Å range |
| `k` | Delete sidechain | Keeps backbone atoms |
| `d` | Drag atoms | Interactive pull-with-refinement at the current refinement selection size |
| `l` | Go to next ligand (cycles) | Cycles through all ligands across all loaded molecules |
| `o` / `Shift+O` | Next / prev NCS-related chain | Same residue number, walk the NCS group |
| `g` | Toggle NCS ghosts | Translucent NCS copies overlaid on the hovered chain |
| `p` / `Shift+P` | Next / prev difference-map peak | Above ±3σ, sorted by absolute sigma |
| `n` / `Shift+N` | Next / prev validation issue | Merged rama + rotamer + density-fit, toast labels which kind |
| `z` | Autofit rotamer (alt) | Duplicate of `a` |
| `Shift+F` | Fill partial residue | |
| `Shift+H` | Refine active residue (single) | |
| `Shift+L` | Label atom on click | |
| `Shift+R` | Sphere refine (unchanged) | 4Å sphere |
| `Shift+S` | Quick-save coordinates | |

### Conflict resolution (Moorhen defaults relocated)

| Key | Was (upstream) | Now |
|-----|----------------|-----|
| `a` | Measure arbitrary distances | Unbound (was `dist_ang_2d`; `d` now drag atoms) |
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
