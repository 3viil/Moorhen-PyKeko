# Moorhen as a Coot Replacement: Project State

## Date: 2026-05-21

---

## The Production Setup (working)

Two GitHub repos backing the local workspace:

| Repo | Purpose | Local Path |
|------|---------|-----------|
| [3viil/MoorHenMH](https://github.com/3viil/MoorHenMH) | Fork of moorhen-coot/Moorhen with customizations | `~/Moorhen` (production), `~/Moorhen-dev` (dev) |
| [3viil/MoorhenWrapper](https://github.com/3viil/MoorhenWrapper) | Electron wrapper around vite dev server | `~/MoorhenWrapper`, `~/MoorhenWrapper-Dev` |

Two apps installed in `/Applications`:

| App | Source | Port |
|-----|--------|------|
| `MoorhenLocal.app` | `~/Moorhen/baby-gru/` (production) | 5173 |
| `MoorhenDev.app` | `~/Moorhen-dev/baby-gru/` (development) | 5174 |

---

## Background

Coot (the standard X-ray crystallography model-building tool) version 0.9.x is preferred by crystallographers but doesn't run on macOS Tahoe (XQuartz/GLX is broken). Coot 1.x is unloved due to UX changes.

**Moorhen** is the same Coot C++ engine compiled to WebAssembly with a modern React/WebGL frontend, developed by the same CCP4/MRC-LMB team. It runs natively in browsers and as an Electron app on Tahoe — no X11 needed.

This project customizes Moorhen with Coot 0.9.x-style keyboard shortcuts and UX defaults, then wraps the dev server in a desktop app for one-click launching.

---

## Customizations in MoorHenMH (fork of moorhen-coot/Moorhen)

### Files modified

```
baby-gru/src/components/managers/preferences/DefaultShortcuts.ts
baby-gru/src/components/managers/preferences/PreferencesList.ts
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
| `w` | Add waters | Batch auto-place by map density (not single-at-cursor like Coot) |
| `a` | Autofit rotamer | |
| `r` | Triple refine | Refine 3 residues (centered residue + 2 neighbors) |
| `e` | Flip peptide | |
| `t` | Add terminal residue | |
| `j` | Jiggle fit | 100 trials, 1.0Å range |
| `k` | Delete sidechain | Keeps backbone (N, CA, C, O, CB, H, HA) |
| `x` | Go to next ligand | |
| `z` | Autofit rotamer (alt) | Duplicate of `a` |
| `o` | NCS jump | Cycles through NCS-related chains at same residue number |
| `Shift+F` | Fill partial residue | |
| `Shift+H` | Refine active residue (single) | |
| `Shift+S` | Quick-save coordinates | |

### Conflict resolution (Moorhen defaults relocated)

| Key | Was (upstream) | Now |
|-----|----------------|-----|
| `a` | Measure arbitrary distances | Moved to `d` |
| `r` | Restore scene | Moved to `v` |
| `g` | Go to blob | Moved to `b` |
| `z` | Wiggle camera | Unbound |

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

# Reuse WASM from production build
cp -r ~/Moorhen/baby-gru/public/MoorhenAssets ~/Moorhen-dev/baby-gru/public/

# Build dev wrapper variant
mkdir ~/MoorhenWrapper-Dev
cd ~/MoorhenWrapper-Dev
# Copy main.js from MoorhenWrapper, but change MOORHEN_DIR to Moorhen-dev and port to 5174
# Copy package.json, change name to "MoorhenDev"
# Then: npm install && npx electron-forge package
# And install to /Applications
```

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

1. **No NCS ghosts yet** — the initial implementation was wrong (it just showed symmetry mates); proper implementation needs C++ WASM bindings for SSM superposition. See "Future work" below.

2. **`w` (add water)** isn't single-water-at-cursor like Coot — Moorhen's `add_waters` is a batch operation that fills all positive density peaks.

3. **64-bit WASM hangs in Electron wrapper** — wrapper forces 32-bit mode. Browser (Chrome) uses 64-bit fine.

4. **Window-narrow CSS** — Moorhen's left menu collapses if window is too narrow; resize wider if you can't see it.

### Workflow

1. **Mouse must be over the 3D canvas** for keyboard shortcuts to fire — that's how Moorhen's keyboard binding works (mouse enter/leave on canvas binds/unbinds document.onkeydown).

2. **Shortcuts need a map loaded** for refinement (`r`, `Shift+H`, `Shift+R`, `j`, `a`, etc.). View-only shortcuts (`h`, `b`, `o`) work without a map.

3. **First load is slow** — WASM module is ~20MB, data.tar.gz unpacking takes a few seconds.

---

## Future Work

### NCS Ghosts (planned)

What it should do: when viewing chain A, show ghost copies of chains B, C, D *transformed to overlay* chain A. This visualizes how well NCS copies match.

**Algorithm** (from Coot source `src/molecule-class-info-ncs.cc`):
1. Get NCS-related chains (`get_ncs_related_chains()` already in WASM)
2. For each copy chain, compute the **SSM superposition matrix** that maps it onto the master chain — **without moving atoms**
3. Generate a bond mesh for the copy chain's atoms
4. Apply the matrix to render as translucent overlay

**Required**:
- New C++ function in `molecules_container_t` that returns the SSM matrix (Coot has `find_ncs_matrix()` already — needs wrapping in `moorhen-wrappers.cc` and exposing via Emscripten)
- Per-chain rendering path in the WebGL pipeline (parallel to symmetry rendering)
- UI toggle in the molecule card

**Estimated effort**: 3-5 days for Phase 1 (works for whole molecules), 2-3 days more for proper per-chain with master selector.

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

~/MoorhenWrapper/                  # production wrapper
  main.js
  package.json
  out/MoorhenLocal-darwin-arm64/   # built .app

~/MoorhenWrapper-Dev/              # dev wrapper
  main.js                          # points to Moorhen-dev, port 5174
  package.json                     # name: "MoorhenDev"
  out/MoorhenDev-darwin-arm64/

~/emsdk/                           # Emscripten SDK

/Applications/
  MoorhenLocal.app                 # production
  MoorhenDev.app                   # development
```

### Wrapper key logic (main.js)

```javascript
const MOORHEN_DIR = path.join(os.homedir(), "Moorhen/baby-gru");  // or Moorhen-dev
const VITE_PORT = 5173;                                            // or 5174

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
