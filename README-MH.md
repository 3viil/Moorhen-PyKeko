<p align="center">
  <img src="https://raw.githubusercontent.com/pykeko/PyKeko/main/PyKeko_icon.png" alt="PyKeko" width="120" height="120" />
</p>

# Moorhen-PyKeko — Customized Moorhen Fork

A personal fork of [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen) that adds several substantive features on top of upstream Moorhen, plus Coot 0.9.x-style keyboard shortcuts and UX defaults. Packaged as the **[PyKeko](https://github.com/pykeko/PyKeko)** desktop app.

**Upstream**: [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen)
**This fork**: [pykeko/Moorhen-PyKeko](https://github.com/pykeko/Moorhen-PyKeko)
**Desktop wrapper**: [pykeko/PyKeko](https://github.com/pykeko/PyKeko)
**Claude/MCP server**: [pykeko/PyKekoMCP](https://github.com/pykeko/PyKekoMCP)
**Full project notes**: [PROJECT-NOTES.md](PROJECT-NOTES.md)

---

## Major additions vs upstream

The biggest features the fork adds — each has its own implementation notes in [PROJECT-NOTES.md](PROJECT-NOTES.md#implemented-features-beyond-upstream).

### 1. PyMOL command translator in Interactive Scripting

The **Interactive scripting…** modal has a JavaScript / PyMOL dropdown. PyMOL mode runs a substantial subset of PyMOL commands against the live Moorhen scene — paste a `.pml` script, hit Run, see it execute. `.pml` files dropped into **Load and execute script…** auto-route to the PyMOL runner.

Coverage:

- **Load / view**: `fetch`, `load`, `delete`, `enable`/`disable`, `zoom`, `orient`, `center`, `set_view`
- **Representation**: `show` / `hide` / `as` for cartoon, sticks, lines, spheres, surface (find-or-create; no duplicate reps)
- **Colour**: `color`, `bg_color`, `spectrum b` with ~50 named PyMOL colours plus `#RRGGBB` / `0xRRGGBB`
- **Full selection algebra**: `chain X+Y`, `resi A-B+C-D`, `name CA+CB`, macros (`polymer.protein`, `solvent`, `hetatm`, `backbone`, `sidechain`, `metals`, `ions`, `lig`), topology ops (`byres`, `bychain`, `byobject`, `bound_to`, `extend N`, `bymolecule`), distance ops (`within N of`, `near_to`, `beyond`, `gap`, `contact`, postfix `around N` and `X within N of Y`), reducers (`first`, `last`), property comparisons (`b > 30`, `q < 0.5`), and named selections via `select`
- **Measurements**: `distance` draws a real labelled dashed line in the viewport (plus snackbar toast and console log)
- **Screenshots**: `png` (and `ray` falls back to `png` — no software ray-tracer in Moorhen)
- **Settings**: `set transparency`, `ray_shadow`, `ambient`, `specular`, `rocking`, `fog_start`/`_end`, `ray_trace_mode`, `draw_axes`/`_crosshairs`/`_scale_bar`, …

Anything unsupported (`iterate`, `alter`, `cmd.do`, movie commands, etc.) warns to the console with the line number and continues. Full reference at [`docs/pymol-translator.md`](docs/pymol-translator.md); 62 pure-JS unit tests in `baby-gru/tests/__tests__/pymol*.test.js` (run with `npx jest --testPathPatterns pymol --selectProjects api-utils`).

### 2. NCS Ghosts

Visualize non-crystallographic symmetry by overlaying every NCS-related chain *transformed onto* a chosen master chain — translucent, color-cycled, computed in C++ via SSM alignment.

- **`g` shortcut** — toggles ghosts on the chain under the cursor (fastest entry point)
- **NCS Ghosts accordion** in the per-molecule card — chain selector + opacity slider, stays open
- Adds a new C++ binding `get_ncs_ghost_matrix(imol, master, copy)` exposed via Embind
- Built on instanced bond rendering via the existing `symmetryMatrices` path — no shader changes

### 3. Claude control surface (PyKekoMCP)

[PyKekoMCP](https://github.com/pykeko/PyKekoMCP) is a Model Context Protocol server that drives a running PyKeko/PyKekoDev app from Claude (load coords/maps, navigate, refine, rotamer fit, flip peptide, add waters, delete, undo/redo, screenshot). The Electron wrapper (token-authenticated HTTP control server) and the in-page bridge (`MoorhenControlApi` / `MoorhenControlBridge`) are part of this fork.

`MoorhenControlApi` also exposes `runPymol(src)` and `runJs(src)`, used by [the autonomous CDP test loop](PROJECT-NOTES.md#autonomous-cdp-test-loop) — scripts can be driven from outside the app entirely.

### 4. Validation issue cycler (`n` / `Shift+N`)

Merged outlier list across three categories — Ramachandran (p<0.02), rotamer (p<0.02), and density-fit (worst residues by libcoot's `density_fit_analysis`). Each entry is tagged so the toast tells you which kind: `Issue 4/17 (rotamer): //A/123 PHE p=0.018`. Sorted by per-category-normalized badness so worst things come first; `Shift+N` reverses. Cache invalidates on edits.

### 5. Difference-map peak cycler (`p` / `Shift+P`)

Find the next signed difference-map peak above ±3σ. Sorted by |sigma|; toast announces e.g. `Peak 3/24: -5.2σ`. `Shift+P` walks backward through the same list. Cache invalidates on edits.

### 6. NCS jump (`o` / `Shift+O`)

Cycle forward (`o`) or backward (`Shift+O`) through NCS-related chains at the same residue number — useful to walk equivalent positions in an oligomer.

### 7. Drag atoms (`d`)

Equivalent to right-click → "Drag atoms" on the residue under the cursor: enters live-refinement-with-pull mode at the active refinement selection size. Accept/Reject snackbar appears for confirmation.

The selection size is read from `state.refinementSettings.refinementSelection` at press time. Three ways to change it:
- **UI**: top-bar **Preferences → Refinement settings... → Default refinement selection** dropdown (Single residue / Adjacent residues / Sphere).
- **Implicit**: residue-selection mode auto-toggles between SPHERE and TRIPLE.
- **Scripted** (in Interactive Scripting, JS mode): `dispatch(setRefinementSelection("HEPTUPLE"))`. QUINTUPLE/HEPTUPLE exist in the C++ backend but aren't exposed in the dropdown — script is the only way to set them.

### 8. Single water at crosshairs + refine (`w`)

Replaces upstream's batch `add_waters` on this key. Places a single HOH at the current view centre (auto-uses the molecule's solvent chain, creates one if absent), then single-residue refines the new water against the active map. Adds a C++ wrapper `add_water_at_position(imol, x, y, z)` that returns the new water's CID.

### 9. Ligand cycle (`l`)

Cycles through every ligand across every loaded molecule. Toast shows `<resName> <chain>/<resNum>`. Module-level cycle index advances on each press.

### 10. CIF ligand dictionary handling

Multiple fixes for how the app handles dropped or imported `.cif` ligand dictionaries:

- **Drop-detect**: when you drop a `.cif` file and molecules are already loaded, the file is sniffed for dictionary content (`data_comp_*` without `_atom_site`). If it's a dict, it gets attached to every loaded molecule as a monomer library instead of becoming its own placeholder "molecule" in the side panel.
- **Import Dictionary defaults**: the "Make monomer available to" dropdown now defaults to the first loaded molecule (was "Any molecule", which doesn't trigger a redraw of existing structures). "Create instance on read" now defaults to **off** — the typical workflow is teaching Moorhen about an unknown ligand that's already in the loaded structure, not loading a duplicate copy.
- **Toggle ref sync**: `createRef.current` was initialized once and never re-synced when the toggle changed; the checkbox visually toggled but had no effect on import. Now synced via `useEffect`.
- **Mark atoms dirty after dict load**: `addDict()` and `loadMissingMonomers()` now call `setAtomsDirty(true)` so the next redraw re-fetches bonds with the new dictionary applied — previously bonds for an unknown ligand stayed broken-looking until you forced a redraw manually.

---

## Keyboard shortcuts

Shortcuts only fire when the mouse cursor is over the 3D canvas (Moorhen convention). With "Use shortcut on hovered atom" enabled (the fork's default), they operate on whatever residue the mouse is hovering over.

| Key | Action | Notes |
|-----|--------|-------|
| `w` | Single water at crosshairs + refine | Replaces upstream batch `add_waters`; auto-uses solvent chain |
| `a` | Autofit rotamer | |
| `r` | Triple refine | Refine 3 residues (active + 2 neighbors) |
| `e` | Flip peptide | |
| `t` | Add terminal residue | |
| `j` | Jiggle fit | 100 trials, 1.0 Å range |
| `k` | Delete sidechain | Keeps backbone atoms |
| `d` | Drag atoms | Interactive pull-with-refinement at the active refinement selection size |
| `g` | Toggle NCS ghosts | Translucent NCS copies overlaid on the hovered chain |
| `l` | Go to next ligand (cycles) | Across all loaded molecules |
| `o` / `Shift+O` | Next / prev NCS-related chain | Same residue number, walk the NCS group |
| `p` / `Shift+P` | Next / prev difference-map peak | Above ±3σ, sorted by absolute sigma |
| `n` / `Shift+N` | Next / prev validation issue | Merged rama + rotamer + density-fit, toast labels which kind |
| `z` | Autofit rotamer (alt) | Duplicate of `a` |
| `Shift+F` | Fill partial residue | |
| `Shift+H` | Refine active residue (single) | |
| `Shift+L` | Label atom on click | |
| `Shift+R` | Sphere refine | 4Å sphere |
| `Shift+S` | Quick-save coordinates | |

### Conflict resolution (where upstream's defaults moved)

| Key | Was (upstream) | Now |
|-----|----------------|-----|
| `a` | Measure arbitrary distances | Unbound (was `dist_ang_2d`; `d` is now drag atoms) |
| `r` | Restore scene | Moved to `v` |
| `g` | Go to blob | Moved to `b` (`g` now toggles NCS ghosts) |
| `l` | Label atom on click | Moved to `Shift+L` |
| `z` | Wiggle camera | Unbound (`z` reused for autofit-rotamer alt) |

---

## Default preferences / UX behavior changes

| Setting | Upstream | This fork |
|---------|----------|-----------|
| Background colour | white | black |
| Default representation | Ribbons (CRs) | Bonds (CBs) |
| `showHs` (hydrogens) | shown | hidden |
| `shortcutOnHoveredAtom` | off (centre-of-view) | on (hovered atom) |

Behaviour changes:

- **Drop a `.cif` dictionary** while molecules are loaded → attaches the dictionary to existing molecules (refreshes their ligand bonds), instead of creating a new monomer molecule.
- **Import Ligand Dictionary** dialog:
  - "Create instance on read" toggle defaults to **off** (just adds the dictionary)
  - "Make monomer available to" defaults to the first loaded molecule (not "Any")
  - The toggle is now functional (previously the create-instance ref was hard-coded to true regardless of the checkbox)
- **Loading a ligand dictionary** marks atoms dirty so the next redraw re-fetches bonds with the new connectivity (previously bonds didn't refresh until other actions caused a re-fetch).

---

## Files modified / added

```
# Coot C++ patches (applied to checkout/coot-1.0)
coot-patches/molecules-container-ncs-ghost.cc                # new SSM-based NCS matrix
coot-patches/molecules-container-add-water-at-position.cc    # new single-water primitive
coot-patches/molecules-container.hh.patch                    # adds both declarations
coot-patches/apply.sh                                        # patch applicator

# WASM bindings
wasm_src/moorhen-wrappers.cc                                 # +get_ncs_ghost_matrix, +add_water_at_position
wasm_src/CMakeLists.txt                                      # +new .cc files

# PyMOL translator
baby-gru/src/utils/MoorhenPymolParser.ts                     # line/arg parser
baby-gru/src/utils/MoorhenPymolSelectionParser.ts            # selection-DSL parser
baby-gru/src/utils/MoorhenPymolFilter.ts                     # runtime atom-filter + bond approx
baby-gru/src/utils/MoorhenPymolTranslator.ts                 # command dispatcher
baby-gru/tests/__tests__/pymol{Parser,SelectionParser,Filter}.test.js  # 62 unit tests

# NCS ghosts, shortcuts, MCP bridge
baby-gru/src/utils/MoorhenMolecule.ts                        # +drawNcsGhosts/clearNcsGhosts/addWaterAtPosition
baby-gru/src/utils/MoorhenMoleculeRepresentation.ts
baby-gru/src/utils/MoorhenKeyboardPress.ts                   # all the new shortcut handlers
baby-gru/src/utils/MoorhenScriptAPI.ts                       # buildEnv() + exePymol()
baby-gru/src/api/MoorhenControlApi.ts                        # new — MCP-facing facade + runPymol/runJs
baby-gru/src/api/MoorhenControlBridge.tsx                    # new — wrapper IPC bridge
baby-gru/src/components/card/MoleculeCard/MoleculeCard.tsx                       # +NCS Ghosts accordion
baby-gru/src/components/card/MoleculeCard/MoleculeRepresentationSettingsCard.tsx # +NcsGhostsSettingsPanel
baby-gru/src/components/modal/MoorhenScriptModal.tsx         # +JS/PyMOL mode toggle
baby-gru/src/components/menu-item/LoadScript.tsx             # .pml file support
baby-gru/src/components/container/MainContainer.tsx          # +control bridge mount + debug exports
baby-gru/src/components/managers/preferences/DefaultShortcuts.ts                 # all new shortcut entries
baby-gru/src/components/managers/preferences/PreferencesList.ts                  # default-pref overrides

# Coot-style UX
baby-gru/src/components/menu-item/ImportLigandDictionary.tsx
baby-gru/src/utils/MoorhenFileLoading.ts                     # dict-attach drag-drop

# Electron-wrapper plumbing
baby-gru/src/InstanceManager/CommandCentre/CootWorker.ts     # 32-bit force signal
baby-gru/src/InstanceManager/CommandCentre/MoorhenCommandCentre.ts
baby-gru/src/utils/windowCootCCP4Loader.ts                   # 32-bit force signal
baby-gru/vite.config.mts

# Docs
docs/pymol-translator.md                                     # user-facing PyMOL reference
docs/pymol-translator-plan.md                                # implementation plan
README-MH.md
PROJECT-NOTES.md
```

---

## Pulling upstream changes

The fork tracks upstream `moorhen-coot/Moorhen`:

```bash
git fetch upstream
git merge upstream/main
# resolve any conflicts
git push origin main
```

---

## Building from scratch

See [PROJECT-NOTES.md](PROJECT-NOTES.md) for the full new-machine setup. The short version:

```bash
# Prerequisites
brew install ninja meson cmake autoconf automake pkg-config gh
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest

# Clone
git clone https://github.com/pykeko/Moorhen-PyKeko.git ~/Moorhen
cd ~/Moorhen
git remote add upstream https://github.com/moorhen-coot/Moorhen.git

# Apply the C++ patches into checkout/coot-1.0 before building
./coot-patches/apply.sh

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

For the desktop wrapper (single-click `.app`), see [pykeko/PyKeko](https://github.com/pykeko/PyKeko).
