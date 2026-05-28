<p align="center">
  <img src="https://raw.githubusercontent.com/pykeko/PyKeko/main/PyKeko_avatar.png" alt="PyKeko" width="140" height="140" />
</p>

# Moorhen-PyKeko

The **brains** of [PyKeko](https://github.com/pykeko) — a fork of [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen), which is [Coot](https://www2.mrc-lmb.cam.ac.uk/personal/pemsley/coot/)'s C++ engine compiled to WebAssembly behind a TypeScript/React UI. This repo holds the web app source plus the WASM build, customized with PyKeko's extra C++ bindings, an in-page control bridge, a PyMOL command translator, a torsion editor, and Coot 0.9.x-style UX.

> 🐦 **New here?** Start at the **[PyKeko project page](https://github.com/pykeko)** — what the project is, the Coot→Moorhen→PyKeko heritage, install, and screenshots. *This README is the technical doc for the fork itself.*

| | |
|---|---|
| **Upstream** | [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen) (BSD-3-Clause) — preserved README: [MOORHEN-UPSTREAM-README.md](MOORHEN-UPSTREAM-README.md) |
| **Desktop wrapper** | [pykeko/PyKeko](https://github.com/pykeko/PyKeko) — builds `PyKeko.app` / `.dmg` from this tree |
| **Claude / MCP** | [pykeko/PyKekoMCP](https://github.com/pykeko/PyKekoMCP) |
| **Feature reference** | [README-MH.md](README-MH.md) — every added feature + the full keyboard-shortcut table |
| **Build & implementation notes** | [PROJECT-NOTES.md](PROJECT-NOTES.md) |

---

## What this repo is

The Moorhen source tree:

- **`baby-gru/`** — the TypeScript/React single-page app (UI, scene, state, command dispatch). This is what `npm` builds.
- **`wasm_src/`, `coot-patches/`, `moorhen_build.sh`, `VERSIONS`, `get_sources`** — the toolchain that fetches Coot/CCP4 sources and compiles them (plus PyKeko's C++ additions) to `moorhen.wasm`.

Two things consume it: the [PyKeko](https://github.com/pykeko/PyKeko) Electron wrapper (→ native macOS app), and a plain browser build (`cd baby-gru && npm start`).

## Architecture

How a Coot operation flows from a click to the screen:

```
 React UI (baby-gru/src)
      │  redux state, scene (WebGL)
      ▼
 MoorhenCommandCentre ──postMessage──▶ CootWorker  (Web Worker, pthreads)
                                          │
                                          ▼
                                       moorhen.wasm
                                       libcootapi + CCP4 · Clipper · MMDB ·
                                       GEMMI · RDKit · FFTW · GSL · Boost
```

The WASM is built from upstream C++ sources, fetched and patched at build time:

| Piece | Role |
|---|---|
| `get_sources` + `VERSIONS` | pin & fetch Coot/CCP4/etc. sources into `checkout/` |
| `coot-patches/apply.sh` | copy PyKeko's C++ into `checkout/coot-1.0/api/` and patch the headers |
| `coot-patches/*.cc` | new libcootapi methods — `get_ncs_ghost_matrix` (SSM NCS), `add_water_at_position` (single water), `set_phi_psi` (local backbone torsion) |
| `wasm_src/moorhen-wrappers.cc` + `CMakeLists.txt` | Embind bindings exposing those (and stock) methods to JS |
| `moorhen_build.sh` | emscripten build → `baby-gru/public/MoorhenAssets/wasm/{moorhen.js,moorhen.wasm}` |

**Control bridge** (how the desktop wrapper and Claude/MCP drive the app): `MoorhenControlBridge` (mounted in `MainContainer`) ↔ `window.MoorhenControlApi` ↔ `commandCentre`. The wrapper's token-authenticated HTTP server posts verbs here; `MoorhenControlApi` also exposes `runPymol(src)` / `runJs(src)`. See [PyKekoMCP](https://github.com/pykeko/PyKekoMCP).

> **Wire-protocol identifiers keep the Moorhen name on purpose** — `MoorhenControlBridge`, `window.MoorhenControlApi`, `MoorhenAssets/`, `moorhen-control:*` IPC channels, `~/.moorhen-mcp/control-*.json`, `MOORHEN_*` env vars, `moorhen_*` MCP tools. They flow between this repo, the wrapper, and PyKekoMCP; renaming any breaks the control channel.

## What the fork adds beyond upstream Moorhen

Summaries — full writeups, with the keyboard-shortcut table and conflict-resolution notes, in **[README-MH.md](README-MH.md)**:

- **PyMOL command-language translator** in *Interactive Scripting* (JS/PyMOL toggle); `.pml` files run directly. Selection algebra, representations, colours, measurements, settings. 62 unit tests. ([reference](docs/pymol-translator.md))
- **NCS ghosts** — overlay NCS-related chains transformed onto a master chain (`g`), via the C++ `get_ncs_ghost_matrix` + the existing instanced-bond path.
- **Residue torsion editor** — backbone φ/ψ (`set_phi_psi`, local move) + sidechain χ (rotate-around-bond) with a live Ramachandran plot, in the residue right-click menu.
- **Cyclers** — validation outliers (`n`), difference-map peaks (`p`), ligands (`l`), NCS mates (`o`), all keyboard-driven with toasts.
- **Single water at crosshairs** (`w`, `add_water_at_position`) and **drag-atoms** (`d`).
- **CLI / ligand-dictionary handling** — restraints `.cif` auto-attaches to loaded molecules instead of spawning a placeholder; consumed by the wrapper's command-line launch.
- **In-page control bridge / MCP surface** (above).
- **Coot 0.9-style defaults** — black background, bonds (not ribbons) default, hydrogens-when-present, shortcut-on-hovered-atom.

## Build from source

Short version (full new-machine setup — emsdk, brew deps, gotchas — in [PROJECT-NOTES.md](PROJECT-NOTES.md)):

```bash
git clone https://github.com/pykeko/Moorhen-PyKeko.git ~/Moorhen
cd ~/Moorhen
git remote add upstream https://github.com/moorhen-coot/Moorhen.git

./get_sources                 # fetch Coot/CCP4/... into checkout/ (per VERSIONS)
./coot-patches/apply.sh       # apply PyKeko's C++ additions

source ~/emsdk/emsdk_env.sh
export PATH=/opt/homebrew/bin:$PATH      # Homebrew node; anaconda/CCP4 node breaks the build
./moorhen_build.sh moorhen    # emscripten build → baby-gru/public/MoorhenAssets/wasm (~1 hr first time)

cd baby-gru && npm install && npm start  # browser dev server (http://localhost:5173)
```

The WASM artifacts and `checkout/`, `monomers/`, etc. are gitignored — they're built locally or copied from a `PyKeko.dmg` (see [PROJECT-NOTES.md](PROJECT-NOTES.md)). For the desktop `.app`, see [pykeko/PyKeko](https://github.com/pykeko/PyKeko).

## Tracking upstream

```bash
git fetch upstream
git merge upstream/main      # resolve conflicts, then push
```

## Branches & releases

| Branch | Use |
|---|---|
| `main` | default; basis for releases |
| `ncs-ghosts` | active working branch (the dist `.app` builds from this) |

Releases are tagged **`pk-vX.Y`** and ship `PyKeko.dmg` — see [Releases](https://github.com/pykeko/Moorhen-PyKeko/releases). End-user install/upgrade: [docs/install-mac.md](docs/install-mac.md).

## Documentation

- **[README-MH.md](README-MH.md)** — full feature reference + keyboard shortcuts
- **[PROJECT-NOTES.md](PROJECT-NOTES.md)** — build, new-machine setup, implementation writeups
- **[docs/install-mac.md](docs/install-mac.md)** — end-user install & upgrade
- **[docs/pymol-translator.md](docs/pymol-translator.md)** — PyMOL command reference
- **[MOORHEN-UPSTREAM-README.md](MOORHEN-UPSTREAM-README.md)** — upstream Moorhen's original README

## License

Fork of [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen), under upstream's **BSD-3-Clause** license (Copyright STFC) — see [COPYING](COPYING).
