<p align="center">
  <img src="https://raw.githubusercontent.com/3viil/PyKeko/main/PyKeko_icon.png" alt="PyKeko" width="100" height="100" />
</p>

# Moorhen as a Coot Replacement: Project State

## Date: 2026-05-21

---

## The Production Setup (working)

Two GitHub repos backing the local workspace:

| Repo | Purpose | Local Path |
|------|---------|-----------|
| [3viil/Moorhen-PyKeko](https://github.com/3viil/Moorhen-PyKeko) | Fork of moorhen-coot/Moorhen with customizations | `~/Moorhen` (production), `~/Moorhen-dev` (dev) |
| [3viil/PyKeko](https://github.com/3viil/PyKeko) | Electron wrapper around the vite dev server; one repo builds both the prod and dev apps | `~/PyKeko` |

Two apps installed in `/Applications`:

| App | Source | Port |
|-----|--------|------|
| `PyKeko.app` | `~/Moorhen/baby-gru/` (production) | 5173 |
| `PyKekoDev.app` | `~/Moorhen-dev/baby-gru/` (development) | 5174 |

---

## Background

Coot version 0.9.x, the ubiquitous model-building tool for X-ray crystallography, is preferred by crystallographers, but doesn't run on macOS Tahoe (which breaks XQuartz). Although Coot 1.x does run on MacOS, a number of UX changes make it less favored.

**Moorhen** is the same Coot C++ engine compiled to WebAssembly with a modern React/WebGL frontend, developed by the same CCP4/MRC-LMB team. It runs natively in browsers and as an Electron app on Tahoe — no XQuartz needed.

This project customizes Moorhen with Coot 0.9.x-style keyboard shortcuts and UX defaults, then wraps the dev server in a desktop app for one-click launching. It also adds several substantive features on top — those are described first.

---

## Major additions vs upstream

The biggest features added on top of upstream Moorhen. Each has a full implementation writeup further down in [Implemented features (beyond upstream)](#implemented-features-beyond-upstream). At a glance:

| Feature | What it does | Entry point |
|---------|--------------|-------------|
| **PyMOL command translator** | JS / PyMOL mode toggle in Interactive Scripting; runs `.pml` scripts against Moorhen with the full PyMOL selection algebra | Edit menu → Interactive scripting…, or `.pml` via Load and execute script… |
| **NCS Ghosts** | Translucent copies of NCS-related chains overlaid on a chosen master, computed in C++ via SSM | `g` shortcut, or the NCS Ghosts accordion in the molecule card |
| **Claude / PyKekoMCP** | MCP server drives the live app — load, navigate, refine, screenshot, plus `runPymol`/`runJs` for headless scripting | `claude mcp add moorhen -- node ~/PyKekoMCP/dist/server.js` |
| **Validation issue cycler** | Merged outlier list (Rama + rotamer + density-fit) with type tags | `n` / `Shift+N` |
| **Difference-map peak cycler** | Walk signed Fo–Fc peaks above ±3σ | `p` / `Shift+P` |
| **NCS jump** | Cycle to the same residue number on the next NCS-related chain | `o` / `Shift+O` |
| **Drag atoms** | Interactive pull-with-refinement at the active selection size | `d` |
| **Single water at crosshairs** | Place + single-residue refine; new C++ primitive | `w` (replaces upstream batch add_waters) |
| **Ligand cycle** | Walk every ligand across every molecule | `l` |
| **Autonomous CDP test loop** | Drive the app from Python via Chrome DevTools Protocol — write/edit/screenshot iteratively | `--remote-debugging-port=9222`; see [§ Autonomous CDP test loop](#autonomous-cdp-test-loop) |

After the headline features, the rest of this document covers the smaller Coot-style shortcut/UX customizations, then the Electron wrapper, build instructions, and troubleshooting.

---

## Customizations in Moorhen-PyKeko (fork of moorhen-coot/Moorhen)

### Files modified

```
baby-gru/src/components/managers/preferences/DefaultShortcuts.ts
baby-gru/src/components/managers/preferences/PreferencesList.ts
baby-gru/src/components/menu-item/ImportLigandDictionary.tsx
baby-gru/src/moorhen.ts
baby-gru/src/utils/MoorhenFileLoading.ts
baby-gru/src/utils/MoorhenKeyboardPress.ts
baby-gru/src/utils/MoorhenMolecule.ts
baby-gru/src/utils/MoorhenMoleculeRepresentation.ts
README-MH.md
```

### Keyboard shortcuts (Coot-style + this fork's additions)

| Key | Action | Notes |
|-----|--------|-------|
| `w` | Single water at crosshairs + refine | Replaces upstream batch `add_waters`; auto-uses solvent chain |
| `a` | Autofit rotamer | |
| `r` | Triple refine | Refine 3 residues (centered residue + 2 neighbors) |
| `e` | Flip peptide | |
| `t` | Add terminal residue | |
| `j` | Jiggle fit | 100 trials, 1.0 Å range |
| `k` | Delete sidechain | Keeps backbone (N, CA, C, O, CB, H, HA) |
| `d` | Drag atoms | Interactive pull-with-refinement at the active refinement selection size |
| `g` | Toggle NCS ghosts | Translucent NCS copies of the hovered chain |
| `l` | Go to next ligand (cycles) | Cycles through all ligands across all loaded molecules |
| `o` / `Shift+O` | Next / prev NCS-related chain | Same residue number, walks the NCS group |
| `p` / `Shift+P` | Next / prev difference-map peak | Above ±3σ, sorted by abs sigma |
| `n` / `Shift+N` | Next / prev validation issue | Merged rama + rotamer + density-fit, toast labels which kind |
| `z` | Autofit rotamer (alt) | Duplicate of `a` |
| `Shift+F` | Fill partial residue | |
| `Shift+H` | Refine active residue (single) | |
| `Shift+L` | Label atom on click | Was unmodified `l` |
| `Shift+S` | Quick-save coordinates | |

### Conflict resolution (Moorhen defaults relocated)

| Key | Was (upstream) | Now |
|-----|----------------|-----|
| `a` | Measure arbitrary distances | Unbound (`dist_ang_2d` keyPress="" in DEFAULT_SHORTCUTS) |
| `r` | Restore scene | Moved to `v` |
| `g` | Go to blob | Moved to `b` (`g` now toggles NCS ghosts) |
| `l` | Label atom on click | Moved to `Shift+L` |
| `d` | Measure arbitrary distances (`dist_ang_2d`) | Now drag atoms |
| `z` | Wiggle camera | Unbound (`z` reused for autofit-rotamer alt) |

### Other UX behavior changes

- **Drop a `.cif` dictionary** while molecules are loaded → attaches it to existing molecules (refreshes their ligand bonds) instead of creating a new monomer molecule
- **Import Ligand Dictionary** dialog:
  - "Create instance on read" toggle defaults to off (just adds the dictionary)
  - "Make monomer available to" defaults to the first loaded molecule (not "Any molecule")
  - The toggle is now functional — previously the create-instance ref was hard-coded to true regardless of the checkbox
- **Loading a dictionary** now marks atoms dirty so the next redraw re-fetches bonds with the new connectivity (previously bonds didn't refresh until other actions caused a re-fetch)

### Default preferences

| Setting | Was | Now |
|---------|-----|-----|
| Background color | white `[1,1,1,1]` | black `[0,0,0,1]` |
| Default representation | Ribbons (`CRs`) | Bonds (`CBs`) |
| `showHs` | true | false |
| `shortcutOnHoveredAtom` | false | true |

### Other source changes

- `moorhen.ts`: Added `MoorhenReduxStore` re-export for npm consumers, converted `MoorhenWebComponentAttributes` to type-only export (vite build requirement)

---

## The Electron Wrapper Strategy

### Why a wrapper instead of full Electron port

The official MoorhenElectron repo uses CRA (Create React App) to bundle a moorhen npm package consumer. This path has known problems:

1. **CRA treats `.cjs` files as static assets** — react-redux's production bundle becomes a file path string instead of a module
2. **Double-bundling** — moorhen.js UMD gets re-bundled by CRA's webpack
3. **react-redux version conflicts** — multiple React instances can result
4. **Path mismatches** — code expects `/MoorhenAssets/...` but npm package ships files at `/...` and `/baby-gru/...`

These issues are why the upstream MoorhenElectron repo only works when built by the CCP4 team's CI — building from source on macOS doesn't produce a working app.

### The wrapper approach

Instead of bundling Moorhen into Electron, the wrapper:

1. Launches a **vite dev server** invisibly from `~/Moorhen/baby-gru/`
2. Opens an Electron `BrowserWindow` pointed at `http://localhost:5173/`
3. Forces **32-bit WASM mode** (64-bit hangs in Electron's renderer for unclear reasons)
4. Cleans up vite on window close

This sidesteps all the CRA bundling complexity. Vite serves source files directly — no double-bundling, no CJS/ESM conflicts, no path mismatches.

### Critical fix: Force 32-bit WASM

The 64-bit WASM module (`moorhen64.wasm`) loads successfully in Electron but `createCoot64Module()` hangs during initialization (probably pthread/SharedArrayBuffer-related). The 32-bit module (`moorhen.wasm`) initializes cleanly.

The wrapper injects this JS into the page on `dom-ready`:

```javascript
const origValidate = WebAssembly.validate;
WebAssembly.validate = function(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (arr.length === 13 && arr[12] === 4) return false;  // memory64 probe
  return origValidate.call(this, bytes);
};
```

This makes Moorhen's WASM loader fall back to the 32-bit module.

### Critical fix: Disable Electron sandbox

WASM pthread workers need to spawn child workers. `sandbox: false` in `webPreferences` allows this.

---

## Build Instructions (from scratch on a new Mac)

### 1. Install prerequisites

```bash
# Homebrew tools
brew install ninja meson cmake autoconf automake pkg-config gh

# Emscripten SDK (needed only if rebuilding WASM)
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
```

**Critical Node.js gotcha**: CCP4 9 bundles Node v16 at `/Applications/ccp4-9/bin/node` which is too old. Anaconda may also override. Ensure Homebrew's `/opt/homebrew/bin` is first in `$PATH`:

```bash
echo 'export PATH=/opt/homebrew/bin:$PATH' >> ~/.zshrc
```

### 2. Authenticate with GitHub

```bash
gh auth login
# Choose: GitHub.com → HTTPS → web browser
```

Configure git identity:

```bash
git config --global user.name "Your Name"
git config --global user.email "your-username@users.noreply.github.com"
```

### 3. Clone the fork

```bash
git clone https://github.com/3viil/Moorhen-PyKeko.git ~/Moorhen
cd ~/Moorhen
git remote add upstream https://github.com/moorhen-coot/Moorhen.git
```

### 4. Build WASM (takes ~1 hour first time)

```bash
source ~/emsdk/emsdk_env.sh
export PATH=/opt/homebrew/bin:$PATH
cd ~/Moorhen
./moorhen_build.sh         # 32-bit (required)
./moorhen_build.sh --64bit # 64-bit (optional, not used by wrapper but safer to have)
```

This produces `baby-gru/public/MoorhenAssets/wasm/moorhen.wasm` etc.

**LhasaReact stub**: If the build hits a missing `LhasaReact` module, create a stub:

```bash
mkdir -p ~/Moorhen/baby-gru/src/LhasaReact/src
cat > ~/Moorhen/baby-gru/src/LhasaReact/src/Lhasa.tsx << 'EOF'
import React from "react";
export const LhasaComponent = (props: any) => {
    return React.createElement("div", null, "Lhasa not available");
};
EOF
```

### 5. Install baby-gru deps

```bash
cd ~/Moorhen/baby-gru
npm install
```

### 6. Build the wrapper app

```bash
cd ~
git clone https://github.com/3viil/PyKeko.git
cd PyKeko
npm install
npx electron-forge package
xattr -rc out/PyKeko-darwin-arm64/PyKeko.app
cp -r out/PyKeko-darwin-arm64/PyKeko.app /Applications/
```

### 7. Optional: dev workspace

```bash
git clone https://github.com/3viil/Moorhen-PyKeko.git ~/Moorhen-dev
cd ~/Moorhen-dev
git remote add upstream https://github.com/moorhen-coot/Moorhen.git
cd baby-gru && npm install

# Reuse the built WASM AND the build-generated LhasaReact from production.
# Both are gitignored, so a fresh clone lacks them; copying avoids a second ~1h WASM build.
cp -r ~/Moorhen/baby-gru/public/MoorhenAssets ~/Moorhen-dev/baby-gru/public/
cp -r ~/Moorhen/baby-gru/src/LhasaReact      ~/Moorhen-dev/baby-gru/src/

# Build the dev desktop app from the SAME wrapper repo (no separate copy needed):
cd ~/PyKeko
npm run package:dev
xattr -rc out/PyKekoDev-darwin-arm64/PyKekoDev.app
cp -r out/PyKekoDev-darwin-arm64/PyKekoDev.app /Applications/
```

> The wrapper bakes the variant (target tree + port) into `variant.json` at package
> time: `npm run package` → PyKeko (Moorhen, 5173) and `npm run package:dev`
> → PyKekoDev (Moorhen-dev, 5174), both from this one repo.

---

## Daily Use

### Production
```
open /Applications/PyKeko.app
```
- Uses `~/Moorhen/baby-gru/` (your stable, working customizations)

### Development
```
open /Applications/PyKekoDev.app
```
- Uses `~/Moorhen-dev/baby-gru/` (a separate clone for experimentation)
- Runs on port 5174 so it doesn't conflict with the production version

### Browser (no Electron)
Just run vite manually and open Chrome:
```bash
cd ~/Moorhen/baby-gru && npm start
open -a "Google Chrome" "http://localhost:5173/"
```

---

## Pulling upstream changes

The fork tracks upstream `moorhen-coot/Moorhen`:

```bash
cd ~/Moorhen
git fetch upstream
git merge upstream/main
# Resolve any conflicts
git push origin main
```

Then pull into the dev clone:
```bash
cd ~/Moorhen-dev
git pull origin main
```

---

## Dev workflow

For ongoing customizations:

1. Make changes in `~/Moorhen-dev/baby-gru/src/`
2. The PyKekoDev app picks them up on launch (vite serves source files directly with HMR)
3. When happy with changes, commit and push to GitHub:
   ```bash
   cd ~/Moorhen-dev
   git add -p  # interactively stage
   git commit -m "..."
   git push
   ```
4. Update production:
   ```bash
   cd ~/Moorhen
   git pull
   ```

---

## Known Issues / Limitations

### Functional

1. **`w` (add water)** isn't single-water-at-cursor like Coot — Moorhen's `add_waters` is a batch operation that fills all positive density peaks.

2. **64-bit WASM hangs in Electron wrapper** — wrapper forces 32-bit mode (via `MOORHEN_FORCE_32BIT` window flag + `?force32=1` worker URL query). Browser (Chrome) uses 64-bit fine.

3. **Window-narrow CSS** — Moorhen's left menu collapses if window is too narrow; resize wider if you can't see it.

### Workflow

1. **Mouse must be over the 3D canvas** for keyboard shortcuts to fire — that's how Moorhen's keyboard binding works (mouse enter/leave on canvas binds/unbinds document.onkeydown).

2. **Shortcuts need a map loaded** for refinement (`r`, `Shift+H`, `Shift+R`, `j`, `a`, etc.). View-only shortcuts (`h`, `b`, `o`) work without a map.

3. **First load is slow** — WASM module is ~20MB, data.tar.gz unpacking takes a few seconds.

---

## Implemented features (beyond upstream)

Ordered by impact / size of change. PyMOL translator and MCP integration are the largest; ligand / water / NCS-jump are smaller key-shortcut features that wrap existing libcoot capability.

### PyMOL command translator

The **Interactive Scripting** modal has a JavaScript / PyMOL dropdown (the mode persists in `localStorage` under `moorhen.scripting.mode`). The PyMOL runner is reachable from outside the modal too: `window.MoorhenControlApi.runPymol(src)` (added to the control API in this fork). User-facing reference: [`docs/pymol-translator.md`](docs/pymol-translator.md).

**Implementation layout** (all in `baby-gru/src/utils/`):

| File | Role |
|------|------|
| `MoorhenPymolParser.ts` | Line + arg parser. Strips `#`-style comments respecting quotes, joins `\`-continued lines, splits comma args while preserving commas inside parens or quotes. Returns `PymolCommand[]` with line numbers for error reporting. |
| `MoorhenPymolSelectionParser.ts` | Lexer + recursive-descent parser for PyMOL's selection DSL → AST. Handles atom predicates, macros, topology ops, distance ops, postfix `around N` and `X within N of Y`, digit-led idents (PDB ids), negative resids, multi-arg `+` lists. |
| `MoorhenPymolFilter.ts` | Runtime atom-filter for selections the CID-pure path can't express. Brute-force distance queries (no kd-tree — fast enough for ≤ 50k atoms). Distance-based covalent-bond approximation (covalent if d ≤ r₁ + r₂ + 0.4 Å) for `bound_to`/`extend`/`bymolecule`. `coalesceResidueCids` collapses contiguous runs of residues into ranges so the generated CID strings stay short. |
| `MoorhenPymolTranslator.ts` | Per-command handlers + dispatcher. Each handler reads the parsed `PymolCommand`, resolves any selection arg via the two-tier compiler, then calls Moorhen APIs (`molecule.show`/`hide` for find-or-create reps, `molecule.addColourRule` + `molecule.redraw` for colours, `dispatch(setBackgroundColor)` for bg, etc.). The `PymolRegistry` tracks object names (from `fetch`/`load`) and named selections (from `select <name>, <expr>`) for the duration of one script run; cross-run object names fall back to matching by `molecule.name`. |

**Two-tier selection compilation**:

1. **CID-pure fast path** (`compileSlots` in the translator): chain/resi/name predicates with and/or compile straight to one or more Moorhen CID strings (joined with `||`). No atom enumeration. Covers maybe 70 % of real selections cheaply.
2. **Runtime atom-filter** (`evaluateSelectionForMolecule` in the filter): everything else. `gemmiAtomsForCid("/*/*/*/*")` to get the atom list, then `evaluateNode` walks the AST applying per-atom predicates and set operations. Results are coalesced to residue granularity (per-atom CIDs are too granular for representations); the `||`-joined CID string goes into `addColourRule` or `addRepresentation`.

**Plumbing changes** to make this work:

- `MoorhenScriptApi.constructor` had a `this.store = store ? store : store` bug (always `undefined`) — fixed; `buildEnv()` extracted as a public method so JS and PyMOL modes share one env object. `molecules` / `maps` are now live getters off `store.getState()` rather than constructor-time snapshots.
- `MoorhenControlBridge.tsx` now passes `videoRecorderRef` and exposes `glRef` via `window.__moorhen_glRef__` so screenshot (png/ray) and persistent distance labels can reach the canvas / screen-recorder without going through React context.
- `MainContainer.tsx` exposes `__moorhen_molecules__`, `__moorhen_maps__`, `__moorhen_glRef__` on `window` for the same reason (and for the CDP test loop below).

**Lessons that turned into bug fixes** (each one cost an iteration):

- Moorhen's representation registry uses CIDs of the form `/*/*/*/*:*` (note the `:*` alt-loc suffix). `molecule.show(style, cid)` only does find-or-create when the cid matches exactly. The translator's `normalizeCidForMoorhen` adds the suffix for the wildcard case.
- Moorhen's colour rules use a short cid form (`//A`, `//A/5-10`) per `ModifyColourRulesCard.tsx`. Emitting the long `/*/A/*/*` form silently fails — the rule registers but doesn't match atoms.
- The PyMOL lexer's `+` list separator was being eaten by an over-eager "unary plus" hack (`+` followed by a digit). Removed; `+` is always a punct token. `chain A+B+C`, `resi 5+10+15+20`, `name CA+CB` all work.
- Number tokenisation was greedy on `-`, so `resi 1-10` lexed as one NaN number, the `1` got silently dropped, and the parser saw `-10`. Tightened: numbers are digits + optional `.digits` + optional `e[+-]digits`. The `-` between range endpoints is now a separate punct token.
- Single-letter chain ids (B, C, H, I, N, Q, R, S) clash with single-letter keyword names. The lexer stores the original-case spelling under `tok.original` and `parseStrList` prefers that in ident-list contexts; keywords still resolve lowercase.
- `add_colour_rule` is per-rep; calling `fetchIfDirtyAndDraw("CBs")` after adding a rule spawned a stray sticks rep alongside the cartoon. Switched to `molecule.redraw()` per affected molecule.
- `hide everything` originally only deleted `isCustom` reps and missed the default CBs from `fetchIfDirtyAndDraw`. Now removes every representation. `disable <name>` also needed to iterate `representation.hide()` (the Redux `visibleMolecules` flag alone isn't consulted by the WebGL renderer).
- Stale-molecule defensiveness: a molecule whose `gemmiStructure` has been `.delete()`'d (e.g. left in Redux from a prior session) throws "Cannot pass deleted object as a pointer of type Structure" the moment you touch atoms. The translator filters via `isLiveMolecule` before iterating. `fetch <id>` also drops any prior molecule with the same name (PyMOL semantics).
- `bg_color` (and any `setBackgroundColor` dispatch) auto-syncs to `defaultBackgroundColor` via `MainContainer.tsx:229-239`, which the preference persistence layer writes to `localStorage`. Test scripts that change `bg_color` *persist* it as the user's preference until they change it back.

**Tests**: 62 pure-JS unit tests in `baby-gru/tests/__tests__/pymol{Parser,SelectionParser,Filter}.test.js`. No WASM, no Redux — just feeds source strings and asserts AST/CID shapes. Run with:

```bash
cd baby-gru
npx jest --testPathPatterns pymol --selectProjects api-utils
```

### NCS Ghosts

**What you see**: pick a master chain (or hover over one and hit `g`); every NCS-related chain is rendered as a translucent, color-cycled bond mesh *transformed onto* that master, so a tight NCS oligomer collapses into a single visually overlaid set of bonds and you can see immediately where copies disagree.

**Pipeline (top → bottom)**:

1. **`o` shortcut handler** in `baby-gru/src/utils/MoorhenKeyboardPress.ts` — looks at `hoveredAtom` (falls back to `getCentreAtom`), grabs the chain id, and toggles `molecule.ncsGhostReps`. Toast tells you how many copies were drawn.
2. **NCS Ghosts accordion** in `baby-gru/src/components/card/MoleculeCard/MoleculeCard.tsx` → `NcsGhostsSettingsPanel` in `MoleculeRepresentationSettingsCard.tsx`. Chain dropdown + opacity slider; stays open (lives inside an accordion, not a popover, so click-away doesn't dismiss).
3. **`MoorhenMolecule.drawNcsGhosts(masterChain, opacity = 0.4)`** in `baby-gru/src/utils/MoorhenMolecule.ts`:
   1. `getNcsRelatedChains()` → array of NCS groups (already in upstream)
   2. For each copy chain in the master's group:
      - Call `getNcsGhostMatrix(masterChain, copy)` → 16 floats parsed from a space-separated string
      - **Layout fix**: SSM `TMatrix` is row-major; gl-matrix `mat4.invert` operates column-major; the renderer's `symmetryMatrices` path expects column-major. So we transpose row→col explicitly, no `mat4.invert` needed (we draw the *copy mesh as-is* with the copy→master transform; that's what puts the copy onto the master).
      - Build a fresh `MoleculeRepresentation("CBs", "//${copy}/*", commandCentre)`, call `draw()`, then on each emitted buffer set:
        - `buf.symmetryMatrices = [matrix]` ← drives the existing instanced renderer at line 5132 of `mgWebGL.tsx`
        - `buf.changeColourWithSymmetry = false` ← otherwise the symmetry pass draws everything gray
        - `buf.transparent = true` and walk `triangleColours` setting RGB to a palette pick and A to `opacity`
        - `buf.alphaChanged = true; buf.isDirty = true` then `buildBuffers(rep.buffers, store)` to actually upload the new alpha to GPU
   3. Push reps into `this.ncsGhostReps` so `clearNcsGhosts()` can take them down later.
4. **`molecules_container_t::get_ncs_ghost_matrix`** in `coot-patches/molecules-container-ncs-ghost.cc`:
   ```cpp
   ssm::Align *SSMAlign = new ssm::Align();
   int rc = SSMAlign->AlignSelectedMatch(asc.mol, asc.mol,
                                         ssm::PREC_Normal, ssm::CONNECT_Flexible,
                                         sel_copy /*moving*/, sel_master /*ref*/);
   ```
   Atoms are *not* mutated; only the 4×4 `TMatrix` is read out and serialized. Falls behind `#ifdef HAVE_SSMLIB`.
5. **Embind binding** at the bottom of the `class_<molecules_container_js, base<molecules_container_t>>` chain in `wasm_src/moorhen-wrappers.cc`:
   ```cpp
   .function("get_ncs_ghost_matrix", &molecules_container_t::get_ncs_ghost_matrix)
   ```

**Renderer reuse, not a new path**: NCS ghosts ride the same `symmetryMatrices` machinery that crystal symmetry already uses — `drawElementsInstanced` with a per-symmetry-pass uniform matrix, no shader work. The unconditional identity draw at line 5112 of `mgWebGL.tsx` means each ghost rep also draws once at the master's own position; that's invisible (translucent copy of a chain overlaid on itself) so we live with it.

**Why bonds work but `transformMatrix` didn't**: there is an older per-buffer `transformMatrix` slot that calls `drawTransformMatrix` (line 4904 of `mgWebGL.tsx`). That path uses plain `gl.drawElements` (not instanced) with the bond template's small index count, so for instanced CB rendering it produces `GL_INVALID_OPERATION: glDrawElements: Vertex buffer is not big enough`. Switching to `symmetryMatrices` was the fix.

**Known limitations / future work**:
- Ghosts regenerate from scratch on every chain change — could be cached per (molecule, master) tuple.
- One palette (orange/green/blue/pink/yellow/purple), no per-ghost color picker yet.
- Only fires for chains in the same NCS group as the master; cross-group "show me all the chains aligned onto X" would need looser matching.
- `get_ncs_ghost_matrix` returns "" silently on alignment failure; no UI for that yet.

### MCP control surface (Claude integration)

Three layers, each in its own repo:

| Layer | Lives in | Role |
|-------|----------|------|
| Renderer facade | `baby-gru/src/api/MoorhenControlApi.ts` (this fork) | `window.MoorhenControlApi.load/navigate/refine/...` — the actual scripted operations against the Redux store + `commandCentre` |
| Renderer bridge | `baby-gru/src/api/MoorhenControlBridge.tsx` (this fork) | React component mounted by `MainContainer`; listens to wrapper IPC (`ipcRenderer.on('moorhen-control:invoke')`), dispatches to the facade, responds via `moorhen-control:reply`. After scene-changing ops also dispatches `setRequestDrawScene(true)` because headless control has no mouse events to trigger a repaint. |
| Electron control server | `main.js` in [PyKeko](https://github.com/3viil/PyKeko) | Token-authenticated HTTP server on `127.0.0.1:<random>`, writes `{port, token, vitePort, title, pid}` to `~/.moorhen-mcp/control-<vitePort>.json`. Forwards POSTed `{token, verb, args}` to the renderer via IPC. Serves `screenshot` directly via `webContents.capturePage()`. |
| Stdio MCP server | [PyKekoMCP](https://github.com/3viil/PyKekoMCP) (separate repo) | `dist/server.js` is the actual MCP endpoint Claude talks to. Resolves the control file (default port 5173 = PyKeko, override with `MOORHEN_VITE_PORT=5174` for PyKekoDev), POSTs to the wrapper, returns text or image content. |

Registration:
```bash
claude mcp add moorhen -- node /Users/mhilgers/PyKekoMCP/dist/server.js
```

Available tools (14): `moorhen_get_state`, `load_coordinates`, `load_map`, `go_to_residue`, `refine`, `auto_fit_rotamer`, `flip_peptide`, `add_terminal_residue`, `add_waters`, `delete`, `set_active_map`, `undo`, `redo`, `screenshot`.

**To add a new tool**: extend `MoorhenControlApi` (renderer) → add a case in `MoorhenControlBridge`'s verb switch → expose it as a tool in `PyKekoMCP/src/server.ts`. The wrapper layer is generic and forwards anything.

**Why a control file instead of a known port**: each Moorhen app picks a random port to avoid collisions and writes both the port and a per-launch token. The MCP server reads that file to find a live app — supports running both PyKeko and PyKekoDev simultaneously (different vite ports → different control files).

### `n` — Next validation issue (merged)

Merges three categories into one cycle:
- **Ramachandran** (`ramachandran_analysis`): probability < 0.02 → outlier; badness = (1-p)*100
- **Rotamer** (`rotamer_analysis`): probability < 0.02 → outlier; badness = (1-p)*100
- **Density-fit** (`density_fit_analysis`, only if a map is loaded): take worst 30 by function_value, normalize against the worst as 100

Each entry carries a `type` tag (`rama` | `rotamer` | `density`) so the toast says `Issue 4/17 (rotamer): //A/123 PHE p=0.018`. Merged list sorted by per-category-normalized badness descending. Module-level cycle index; `Shift+N` reverses.

Clashes (the planned 4th category) need a fresh Embind value-object registration for `coot::plain_atom_overlap_t` + `coot::atom_spec_t` so the existing `get_atom_overlaps` API can be exposed to JS. Deferred.

### `p` — Next difference-map peak

Cycle through signed difference-map peaks above ±3σ. Uses already-bound `difference_map_peaks(imol_map, imol_protein, n_rmsd)`. Handler in `MoorhenKeyboardPress.ts`:
- Auto-finds the first map with `isDifference: true` from `state.maps`
- Caches the peaks list per `(model, map, editVer)` tuple in module scope — invalidated when edit-history depth changes so refines/adds don't show stale peaks
- Sorts by `|featureValue|` descending so the biggest |sigma| comes first
- `Shift+P` walks the same list backward (`(idx - 1 + len) % len`)
- Dispatches `setOrigin([-x, -y, -z])` to centre on the peak

### `o` — NCS jump

Cycle through NCS-related chains at the same residue number. Handler in `MoorhenKeyboardPress.ts`: takes the current centre atom (or hovered atom), looks up its chain in `getNcsRelatedChains()`, finds the next chain in the group, then dispatches a centre update for the same residue number on that chain. Useful for visually walking equivalent positions in an oligomer one tap at a time.

### `d` — Drag atoms (interactive refinement)

Equivalent to right-click → "Drag atoms" in the context menu. Mirrors `MoorhenDragAtomsButton.nonCootCommand`:
- Picks the chosen molecule + residue from `hoveredAtom` (or `get_active_atom` fallback when `visibleMolecules` is empty)
- Reads `state.refinementSettings.refinementSelection` (`SINGLE` / `TRIPLE` / `QUINTUPLE` / `HEPTUPLE` / `SPHERE`) and builds the fragment CID accordingly (`SPHERE` uses `getNeighborResiduesCids(cid, 6)`)
- Dispatches `setShownControl({ name: "acceptRejectDraggingAtoms", payload: { molNo, fragmentCid } })` and `setIsDraggingAtoms(true)`

The Accept/Reject snackbar handles the rest. `dist_ang_2d` was on `d` upstream; that shortcut is now empty-keyed in `DEFAULT_SHORTCUTS` (still in the keymap, just unbound).

**Where the selection size comes from**: the value lives in
`refinementSettings.refinementSelection` (Redux). Three ways to set it:

1. **UI** — top-bar **Preferences → Refinement settings... → Default refinement
   selection** opens a popover with a dropdown (Single residue / Adjacent
   residues / Sphere). Defined at `baby-gru/src/components/menu-system/subMenuConfig.tsx:780`,
   rendered by `RefinementSettings.tsx` which dispatches
   `setRefinementSelection(...)` on change.
2. **Implicit** — `MainContainer.tsx` auto-toggles between SPHERE and TRIPLE
   inside the residue-selection flow (shift-click range).
3. **Scripted** — `dispatch(setRefinementSelection("HEPTUPLE"))` from
   Interactive Scripting in JS mode. The action creator is exported through
   `MoorhenScriptApi`'s env. **QUINTUPLE / HEPTUPLE are valid in the C++
   backend but the UI dropdown does not list them** — they are scriptable
   only.

### `w` — Single water at crosshairs + refine

Replaces upstream's batch `add_waters` on the `w` shortcut. Pipeline:

1. **Handler** in `MoorhenKeyboardPress.ts`: reads `state.glRef.origin` (negated atom coord of the view centre), calls `targetMolecule.addWaterAtPosition(-ox, -oy, -oz)` → CID of the new water, then `refine_residues_using_atom_cid` in `SINGLE` mode against the active map.
2. **JS wrapper** `MoorhenMolecule.addWaterAtPosition(x, y, z)`: thin call to the new C++ binding; flips `setAtomsDirty(true)` so the next redraw refetches bonds.
3. **C++** `molecules_container_t::add_water_at_position` in `coot-patches/molecules-container-add-water-at-position.cc`: constructs a 1-element `coot::minimol::molecule` at (x,y,z) and calls `molecules[imol].insert_waters_into_molecule(water_mol, "HOH")` — which already handles solvent-chain selection, creating one if absent, and incrementing seqNum. Then scans the mmdb hierarchy for the highest-seqNum HOH in any solvent chain and returns its CID `/1/<chain>/<resno>`.

The refine step is one extra `cootCommand` call so we kept it. Adding it as `WHOLE_MOLECULE` mode would refine too much; we use `SINGLE` so only the new water moves to fit density.

### `l` — Go to next ligand (cycles)

Replaces upstream's `Shift+L` behavior. Handler iterates every `molecule.ligands` list across `molecules`, flattening to one stable list. A **module-level** `ligandCycleIdx` (in `MoorhenKeyboardPress.ts`) advances on each press so successive `l` presses walk through ligands deterministically — no Redux state, no per-component refs. Toast announces `<resName> <chain>/<resNum>` so you can tell where you landed.

This deliberately *cycles* (`(idx + 1) % total`) rather than jumping to the nearest, matching Coot's go-to-ligand UX.

### Space-jump robustness

`jump_next_residue` / `jump_previous_residue` used to bail when `state.molecules.visibleMolecules` was empty (`getCentreAtom` filters by `isVisible()`). The MCP `load_coordinates` flow doesn't dispatch `showMolecule`, so models loaded via Claude never landed in that list and space did nothing. Handler now falls back to `hoveredAtom.molecule ?? molecules[0]` and calls `get_active_atom` directly when `getCentreAtom` returns null.

### CIF ligand dictionary handling

Four related fixes:

1. **Drop-handler in `MoorhenContainer.tsx`**: when a `.cif` is dropped and `state.molecules.moleculeList.length > 0`, peek at the file (`text.includes("data_comp_") && !text.includes("_atom_site")`) — if it looks like a dictionary, route to `molecule.addDict(text)` on every loaded molecule instead of `createMoleculeFromFile()`. Falls back to the old molecule-creation path if no molecules are loaded yet.
2. **Import Dictionary dialog defaults** (`ImportLigandDictionary.tsx`):
   - "Make monomer available to" now defaults to `molecules[0]` if any are loaded (was `null` = "Any molecule", which doesn't trigger an actual redraw of the existing structures). Also sets `selectValueRef.current` to the same value so the default is the value `onOK` reads.
   - "Create instance on read" defaults to `false`. The 99% case is "I dropped a .cif into the side panel, please teach Moorhen about this ligand that's already in my structure" — not "load a separate copy of this ligand as its own molecule".
3. **`createRef.current` sync bug** (`ImportLigandDictionary.tsx`): the ref was initialized to `true` and the `setCreateInstance` setter never updated it. Toggling the checkbox visually flipped but `onOK` always saw `createRef.current === true` so it always created an instance. Added a `useEffect(() => { createRef.current = createInstance }, [createInstance])` to sync. The same pattern is in `SMILESToLigand.tsx` for consistency (though `SMILES → ligand` legitimately defaults to creating an instance — that path doesn't have a pre-existing structure to attach to).
4. **`setAtomsDirty(true)` after dict load** (`MoorhenMolecule.ts`): both `addDict()` and `loadMissingMonomers()` now invalidate the atom cache. Without this, the renderer reused the old bond list (drawn before the dict was known), so unknown ligands kept looking broken until the user manually forced a redraw.

These work together: drop a `.cif` for a ligand that's already in your structure → it gets attached to the right molecule by default → bonds redraw immediately → no zombie monomer "molecules" cluttering the side panel.

### Autonomous CDP test loop

For interactive iteration on the renderer (PyMOL translator, NCS ghosts, validation cycler, anything that needs eyes on the WebGL output), PyKekoDev can be driven over Chrome DevTools Protocol — no clicking through the UI, no paste-and-tell with the user.

**Launch the app with debug port + permissive origins**:

```bash
/Applications/PyKekoDev.app/Contents/MacOS/PyKekoDev \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  > /tmp/moorhendev.log 2>&1 &
```

The `--remote-allow-origins='*'` is required — without it the WebSocket connection is 403'd. Quote the `*` so zsh doesn't glob.

**The helper scripts** (live in `/tmp/` during a session, but each is ~30 lines and trivial to recreate):

| Script | What it does |
|--------|--------------|
| `cdp-eval.py "<JS>"` | `Runtime.evaluate { expression, returnByValue, awaitPromise }`. Prints the JSON result. |
| `cdp-inspect.py` | Same, but reads JS from stdin — better for heredocs with quotes. |
| `cdp-reload.py` | `Page.reload { ignoreCache: true }`. Use after editing files vite is HMR'ing into the renderer. |
| `cdp-console.py <seconds>` | Subscribes to `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded` for N seconds and prints each event with its level. |
| `cdp-pymol-shot.py [outfile]` | Reads a PyMOL script from stdin, calls `window.MoorhenControlApi.runPymol(src)`, sleeps 2.5 s for the render to settle, then `Page.captureScreenshot { format: "png" }` and writes the PNG. Default outfile `/tmp/pymol-shot.png`. |

**The pattern** (a complete script in <30 lines):

```python
import json, urllib.request, base64
from websocket import create_connection
pages = json.loads(urllib.request.urlopen('http://localhost:9222/json/list').read())
page = next(p for p in pages if p['type']=='page' and 'localhost:5174' in p.get('url',''))
ws = create_connection(page['webSocketDebuggerUrl'])
ws.send(json.dumps({"id":1,"method":"Runtime.evaluate",
                    "params":{"expression":"1+1","returnByValue":True,"awaitPromise":True}}))
print(json.loads(ws.recv())['result']['result']['value'])
ws.close()
```

**The loop in practice** (write code → see result without user):

1. Edit a `.ts` file. Vite HMR pushes the update.
2. `python3 /tmp/cdp-reload.py` to force a fresh module graph (vite HMR doesn't reliably re-import workers / dynamic imports).
3. `sleep 7` for cootModule to re-init.
4. `echo "<pymol script>" | python3 /tmp/cdp-pymol-shot.py /tmp/test.png`
5. `cat /tmp/test.png` via the Read tool — visual feedback.
6. If broken, capture the console: `python3 /tmp/cdp-console.py 10 > /tmp/cap.txt`, run again, `grep` the log.

This is what let Phase 3 of the PyMOL translator land in ~3 hours flat — every theory got a screenshot. The same setup will work for the NCS-ghost rendering pipeline, validation cyclers, drag-atoms mode, anything that's hard to verify by reading code.

**Cleanup hygiene**: the loop's `bg_color` calls *persist* (see the bg_color note above). End test scripts with `bg_color black` if you don't want to overwrite the user's preference. Alternatively, drive a private Electron user-data-dir so the persistence is in a throwaway location:

```bash
PyKekoDev --user-data-dir=/tmp/moorhen-test --remote-debugging-port=9222 --remote-allow-origins='*'
```

## Future Work

### Other potential improvements

- **NCS edit propagation**: when editing one NCS copy, optionally apply same
  changes to others (Coot 0.9.x had this)
- **Coot Python script translator**: convert common Coot `.py` scripts to
  Moorhen JS equivalents (similar shape to the PyMOL translator above, but
  Coot scripts use the `coot.` and `coot_redraw` style which is closer to the
  Moorhen JS API to begin with)
- **Clashes as a 4th category in the `n` cycler**: add Embind value-object
  registration for `coot::plain_atom_overlap_t` + `coot::atom_spec_t`, then
  expose `get_atom_overlaps` and merge with rama/rotamer/density-fit
- **Real bond list binding**: replace the planned distance-based covalent-bond
  approximation (used by both the PyMOL `bound_to`/`extend` operators and any
  future bond-graph-using features) with a libcoot binding
- **Validation report panel**: unified view of Ramachandran + rotamer +
  clashes + density fit
- **Real-space refine all** keyboard shortcut
- **Recent files list** in File menu
- **64-bit WASM build for this fork**: currently we only build 32-bit and the
  Electron wrapper forces it; building 64-bit would let the browser path use
  more memory for large complexes

---

## Architecture Reference

### File layout (current state)

```
~/Moorhen/                         # production source, branch: main
  baby-gru/
    src/                           # our modified TypeScript
    public/MoorhenAssets/wasm/     # built WASM
    dist/                          # built library bundle (when built)
  CCP4_WASM_BUILD/                 # WASM build artifacts
  install/                         # WASM install location
  checkout/                        # downloaded C++ source dependencies
  README-MH.md                     # fork-specific README

~/Moorhen-dev/                     # dev source, branch: main (own clone)
  (same structure)

~/PyKeko/                  # Electron wrapper — builds BOTH apps
  main.js                          # reads variant.json (target tree + port)
  forge.config.js                  # MOORHEN_VARIANT=prod|dev -> bakes variant.json
  package.json                     # scripts: package (prod), package:dev
  out/PyKeko-darwin-arm64/   # built prod .app  (npm run package)
  out/PyKekoDev-darwin-arm64/     # built dev  .app  (npm run package:dev)

~/emsdk/                           # Emscripten SDK

/Applications/
  PyKeko.app                 # production
  PyKekoDev.app                   # development
```

### Wrapper key logic (main.js)

```javascript
// Config comes from variant.json (baked by forge.config.js at package time),
// with env-var overrides for unpackaged runs; defaults are the production values:
const VARIANT = require("./variant.json");  // { moorhenSubdir, vitePort, logPath, title }
const MOORHEN_DIR = path.join(os.homedir(), VARIANT.moorhenSubdir);  // Moorhen or Moorhen-dev
const VITE_PORT = VARIANT.vitePort;                                  // 5173 (prod) / 5174 (dev)

// On launch: spawn vite, wait for it to be ready, open BrowserWindow
// On window close: kill vite child process

// BrowserWindow critical settings:
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  enableBlinkFeatures: "SharedArrayBuffer",
  sandbox: false,  // needed for WASM pthread workers
}

// On dom-ready: inject WebAssembly.validate override to force 32-bit
```

### WebAssembly.validate override (force 32-bit)

```javascript
const origValidate = WebAssembly.validate;
WebAssembly.validate = function(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Memory64 probe is exactly this 13-byte sequence:
  if (arr.length === 13 && arr[12] === 4) return false;
  return origValidate.call(this, bytes);
};
```

This makes Moorhen's `windowCootCCP4Loader.ts` fall back to the 32-bit module path.

---

## Troubleshooting

### "Moorhen is loading..." stuck

1. Check `/tmp/moorhen-wrapper.log` for errors
2. Verify vite is running: `curl -s http://localhost:5173/ -o /dev/null -w "%{http_code}"` should return 200
3. Check WASM files exist at `~/Moorhen/baby-gru/public/MoorhenAssets/wasm/`
4. Verify crossOriginIsolated by opening DevTools console: `crossOriginIsolated` should return `true`

### Keyboard shortcuts not firing

1. **Mouse must be over the 3D canvas** — this is how Moorhen binds keys
2. Press `h` to see the shortcut help overlay — verifies the handler is being reached
3. Refinement shortcuts need a map loaded (active map)
4. Reset preferences via Preferences menu if stored prefs are stale

### Background not black / shortcuts on hover not on

Your IndexedDB has stored old prefs. Either:
- Reset via Moorhen's Preferences menu (look for reset button)
- Clear Chrome's IndexedDB for the localhost:5173 origin

### Vite won't start

1. Check Node.js version: `node --version` must be >= 18
2. CCP4's old node may override Homebrew's: `which node` should be `/opt/homebrew/bin/node`
3. Add `export PATH=/opt/homebrew/bin:$PATH` to `~/.zshrc`

### Build fails

If `./moorhen_build.sh` fails:
- Check `emcc --version` works (Emscripten activated)
- Check `cmake --version`, `ninja --version`, `meson --version` all installed via Homebrew
- The build downloads sources on first run — needs internet
- Build cache is in `CCP4_WASM_BUILD/` — `rm -rf` if cache is corrupted

---

## Quick Reference: Daily Commands

```bash
# Open production Moorhen
open /Applications/PyKeko.app

# Open dev Moorhen
open /Applications/PyKekoDev.app

# Browser-only (no Electron)
cd ~/Moorhen/baby-gru && npm start
# then open http://localhost:5173/ in Chrome

# Pull upstream changes
cd ~/Moorhen
git fetch upstream && git merge upstream/main
git push origin main

# Sync dev with production
cd ~/Moorhen-dev && git pull

# Rebuild WASM after dependency upgrades
cd ~/Moorhen && source ~/emsdk/emsdk_env.sh
./moorhen_build.sh moorhen      # rebuild just moorhen target

# Rebuild wrapper after main.js changes
cd ~/PyKeko
npx electron-forge package
xattr -rc out/PyKeko-darwin-arm64/PyKeko.app
cp -r out/PyKeko-darwin-arm64/PyKeko.app /Applications/
```

---

## Useful URLs

- **Fork**: https://github.com/3viil/Moorhen-PyKeko
- **Wrapper**: https://github.com/3viil/PyKeko
- **Upstream Moorhen**: https://github.com/moorhen-coot/Moorhen
- **Upstream Electron** (broken from source, but provides pre-built releases): https://github.com/moorhen-coot/MoorhenElectron
- **Moorhen web app**: https://moorhen.org
- **Moorhen wiki**: https://moorhen-coot.github.io/wiki/
- **Coot source** (for algorithm reference): https://github.com/pemsley/coot
