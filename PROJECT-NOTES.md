# Moorhen as a Coot Replacement: Project State

## Date: 2026-05-21

---

## The Production Setup (working)

Two GitHub repos backing the local workspace:

| Repo | Purpose | Local Path |
|------|---------|-----------|
| [3viil/MoorHenMH](https://github.com/3viil/MoorHenMH) | Fork of moorhen-coot/Moorhen with customizations | `~/Moorhen` (production), `~/Moorhen-dev` (dev) |
| [3viil/MoorhenWrapper](https://github.com/3viil/MoorhenWrapper) | Electron wrapper around the vite dev server; one repo builds both the prod and dev apps | `~/MoorhenWrapper` |

Two apps installed in `/Applications`:

| App | Source | Port |
|-----|--------|------|
| `MoorhenLocal.app` | `~/Moorhen/baby-gru/` (production) | 5173 |
| `MoorhenDev.app` | `~/Moorhen-dev/baby-gru/` (development) | 5174 |

---

## Background

Coot version 0.9.x, the ubiquitous model-building tool for X-ray crystallography, is preferred by crystallographers, but doesn't run on macOS Tahoe (which breaks XQuartz). Although Coot 1.x does run on MacOS, a number of UX changes make it less favored.

**Moorhen** is the same Coot C++ engine compiled to WebAssembly with a modern React/WebGL frontend, developed by the same CCP4/MRC-LMB team. It runs natively in browsers and as an Electron app on Tahoe — no XQuartz needed.

This project customizes Moorhen with Coot 0.9.x-style keyboard shortcuts and UX defaults, then wraps the dev server in a desktop app for one-click launching.

---

## Customizations in MoorHenMH (fork of moorhen-coot/Moorhen)

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
README-MH.md (new)
```

### New keyboard shortcuts (Coot-style)

| Key | Action | Notes |
|-----|--------|-------|
| `w` | Add waters | Batch auto-place by map density (not single-at-cursor like Coot, needs to be fixed) |
| `a` | Autofit rotamer | |
| `r` | Triple refine | Refine 3 residues (centered residue + 2 neighbors) |
| `e` | Flip peptide | |
| `t` | Add terminal residue | |
| `j` | Jiggle fit | 100 trials, 1.0Å range |
| `k` | Delete sidechain | Keeps backbone (N, CA, C, O, CB, H, HA) |
| `l` | Go to next ligand (cycles) | Cycles through all ligands across all loaded molecules |
| `z` | Autofit rotamer (alt) | Duplicate of `a` |
| `o` | NCS jump | Cycles through NCS-related chains at same residue number |
| `Shift+F` | Fill partial residue | |
| `Shift+H` | Refine active residue (single) | |
| `Shift+L` | Label atom on click | Was unmodified `l` |
| `Shift+S` | Quick-save coordinates | |

### Conflict resolution (Moorhen defaults relocated)

| Key | Was (upstream) | Now |
|-----|----------------|-----|
| `a` | Measure arbitrary distances | Moved to `d` |
| `r` | Restore scene | Moved to `v` |
| `g` | Go to blob | Moved to `b` |
| `l` | Label atom on click | Moved to `Shift+L` |
| `z` | Wiggle camera | Unbound |

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
git clone https://github.com/3viil/MoorHenMH.git ~/Moorhen
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
git clone https://github.com/3viil/MoorhenWrapper.git
cd MoorhenWrapper
npm install
npx electron-forge package
xattr -rc out/MoorhenLocal-darwin-arm64/MoorhenLocal.app
cp -r out/MoorhenLocal-darwin-arm64/MoorhenLocal.app /Applications/
```

### 7. Optional: dev workspace

```bash
git clone https://github.com/3viil/MoorHenMH.git ~/Moorhen-dev
cd ~/Moorhen-dev
git remote add upstream https://github.com/moorhen-coot/Moorhen.git
cd baby-gru && npm install

# Reuse the built WASM AND the build-generated LhasaReact from production.
# Both are gitignored, so a fresh clone lacks them; copying avoids a second ~1h WASM build.
cp -r ~/Moorhen/baby-gru/public/MoorhenAssets ~/Moorhen-dev/baby-gru/public/
cp -r ~/Moorhen/baby-gru/src/LhasaReact      ~/Moorhen-dev/baby-gru/src/

# Build the dev desktop app from the SAME wrapper repo (no separate copy needed):
cd ~/MoorhenWrapper
npm run package:dev
xattr -rc out/MoorhenDev-darwin-arm64/MoorhenDev.app
cp -r out/MoorhenDev-darwin-arm64/MoorhenDev.app /Applications/
```

> The wrapper bakes the variant (target tree + port) into `variant.json` at package
> time: `npm run package` → MoorhenLocal (Moorhen, 5173) and `npm run package:dev`
> → MoorhenDev (Moorhen-dev, 5174), both from this one repo.

---

## Daily Use

### Production
```
open /Applications/MoorhenLocal.app
```
- Uses `~/Moorhen/baby-gru/` (your stable, working customizations)

### Development
```
open /Applications/MoorhenDev.app
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
2. The MoorhenDev app picks them up on launch (vite serves source files directly with HMR)
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

### NCS Ghosts

Show ghost copies of NCS-related chains *transformed onto* a chosen master chain — to verify how well NCS copies agree. Implemented as:

1. **C++**: `molecules_container_t::get_ncs_ghost_matrix(imol, master, copy)` in `coot-patches/molecules-container-ncs-ghost.cc` (added to `checkout/coot-1.0` and linked into libcoot). Uses SSM `AlignSelectedMatch` with `sel_copy` as moving, `sel_master` as reference, returns the resulting 4×4 `TMatrix` as a space-separated string (row-major).
2. **Embind**: `.function("get_ncs_ghost_matrix", &molecules_container_t::get_ncs_ghost_matrix)` in `moorhen-wrappers.cc` (inside the `molecules_container_js` class block).
3. **JS**: `MoorhenMolecule.getNcsGhostMatrix()` parses the string, `drawNcsGhosts(masterChain, opacity)` and `clearNcsGhosts()` manage the overlay lifecycle.
4. **Render**: each ghost is a fresh `CBs` `MoleculeRepresentation` for the copy chain, with `buf.symmetryMatrices = [matrix]` and `buf.changeColourWithSymmetry = false` so the existing instanced bond renderer draws it transformed without shader changes. Translucent + color-cycled per copy.
5. **UI**: `NcsGhostsSettingsPanel` accordion in the molecule card (chain picker + opacity slider). Keyboard shortcut `g` toggles ghosts on the hovered chain.

The above relies on `get_ncs_related_chains()` (already in WASM) to discover NCS groups.

### MCP control surface

`MoorhenControlApi.ts` and `MoorhenControlBridge.tsx` (in `baby-gru/src/api/`) expose `window.MoorhenControlApi` and bridge it to the Electron wrapper's IPC channel. The wrapper runs a token-authenticated HTTP server on `127.0.0.1:<random>`, writing `{port, token, vitePort}` to `~/.moorhen-mcp/control-<vitePort>.json`. The separate [MoorhenMCP](https://github.com/3viil/MoorhenMCP) repo provides the stdio MCP server that POSTs `{token, verb, args}` to that endpoint so Claude can drive a running MoorhenLocal/MoorhenDev.

## Future Work

### Other potential improvements

- **NCS edit propagation**: when editing one NCS copy, optionally apply same changes to others (Coot 0.9.x had this)
- **Coot Python script translator**: convert common Coot `.py` scripts to Moorhen JS equivalents
- **Validation report panel**: unified view of Ramachandran + rotamer + clashes + density fit
- **Real-space refine all** keyboard shortcut
- **Recent files list** in File menu

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

~/MoorhenWrapper/                  # Electron wrapper — builds BOTH apps
  main.js                          # reads variant.json (target tree + port)
  forge.config.js                  # MOORHEN_VARIANT=prod|dev -> bakes variant.json
  package.json                     # scripts: package (prod), package:dev
  out/MoorhenLocal-darwin-arm64/   # built prod .app  (npm run package)
  out/MoorhenDev-darwin-arm64/     # built dev  .app  (npm run package:dev)

~/emsdk/                           # Emscripten SDK

/Applications/
  MoorhenLocal.app                 # production
  MoorhenDev.app                   # development
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
open /Applications/MoorhenLocal.app

# Open dev Moorhen
open /Applications/MoorhenDev.app

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
cd ~/MoorhenWrapper
npx electron-forge package
xattr -rc out/MoorhenLocal-darwin-arm64/MoorhenLocal.app
cp -r out/MoorhenLocal-darwin-arm64/MoorhenLocal.app /Applications/
```

---

## Useful URLs

- **Fork**: https://github.com/3viil/MoorHenMH
- **Wrapper**: https://github.com/3viil/MoorhenWrapper
- **Upstream Moorhen**: https://github.com/moorhen-coot/Moorhen
- **Upstream Electron** (broken from source, but provides pre-built releases): https://github.com/moorhen-coot/MoorhenElectron
- **Moorhen web app**: https://moorhen.org
- **Moorhen wiki**: https://moorhen-coot.github.io/wiki/
- **Coot source** (for algorithm reference): https://github.com/pemsley/coot
