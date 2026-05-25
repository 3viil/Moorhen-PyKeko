# Claude context — `3viil/Moorhen-PyKeko`

A fork of upstream [`moorhen-coot/Moorhen`](https://github.com/moorhen-coot/Moorhen) (a Coot-based molecular graphics web app, WebAssembly) with PyKeko-specific customizations. The compiled wrapper that turns this into a desktop app lives at [`3viil/PyKeko`](https://github.com/3viil/PyKeko); the MCP server for Claude control lives at [`3viil/PyKekoMCP`](https://github.com/3viil/PyKekoMCP).

See [`3viil/PyKeko/CLAUDE.md`](https://github.com/3viil/PyKeko/blob/main/CLAUDE.md) for the full project family overview, naming conventions, and wire-protocol do-not-rename rules.

## What this fork adds beyond upstream Moorhen

Skim [`PROJECT-NOTES.md`](PROJECT-NOTES.md) for the implementation writeups, but at a glance:

- NCS ghost overlays
- PyMOL command translator (JS / PyMOL mode toggle in Interactive Scripting)
- MCP control surface (`MoorhenControlBridge`, `window.MoorhenControlApi`)
- Validation / peak / ligand cyclers
- Coot 0.9.x-style keyboard shortcuts and UX defaults
- 32-bit WASM enforcement in Electron renderer (see `PyKeko/preload.js`)

## Branches

| Branch | Use |
| --- | --- |
| `main` | Default; basis for releases and the dist build |
| `ncs-ghosts` | Active working branch with the user's customizations on top of main |

Local clones:
- `~/Moorhen` (currently on `ncs-ghosts`) — what `PyKeko.app` dist builds from (`forge.config.js` hard-codes `BABY_GRU = ~/Moorhen/baby-gru`)
- `~/Moorhen-dev` (currently on `main`) — what `PyKekoDev.app` runs against via vite, port 5174

`upstream` remote points at `moorhen-coot/Moorhen` for pulling in upstream changes.

## Build

This is normally built indirectly via `~/PyKeko`'s `npm run package` (which runs a vite build of `baby-gru/`). For direct work in here:

```bash
cd ~/Moorhen/baby-gru
npm install
npm run create-version
npm run transpile-ts-worker      # builds public/MoorhenAssets/wasm/CootWorker.js
npm run transpile-protobuf
npm run transpile-graphql-codegen
# Then either:
npx vite --config vite.config.mts         # dev server
# or build WASM via the cmake steps in PROJECT-NOTES.md
```

Known gotcha (the `~/bin/moorhen` shell launcher exists to work around this): running plain `npm start` triggers a prestart hook that recompiles `CootWorker.js`, which can desync from the WASM build and silently break the Coot command worker. Use `npx vite` directly to avoid the prestart, or rebuild WASM whenever `CootWorker.ts` is touched.

## Naming

- Refs to **upstream Moorhen** (project name, links to `moorhen-coot/*`, `moorhen.org`) — leave as "Moorhen"
- Refs to **this fork** — "Moorhen-PyKeko"
- Refs to the **packaged desktop app** — "PyKeko" / "PyKeko Dev"
- Wire-protocol identifiers (`MoorhenAssets/`, `MoorhenControlBridge`, etc.) — leave (see PyKeko/CLAUDE.md)

## Releases

Releases are tagged `pk-vX.Y` (e.g., [`pk-v0.1`](https://github.com/3viil/Moorhen-PyKeko/releases/tag/pk-v0.1)) and ship `PyKeko.dmg` as the asset, built from the matching `~/PyKeko` commit. Version source of truth: `~/PyKeko/package.json`; this fork's `baby-gru/package.json` carries upstream Moorhen's version (`1.0.0-alpha.1`) and shouldn't be edited as part of PyKeko's versioning.

## Branch-sync workflow

The user's working branch is `ncs-ghosts`. To propagate a doc/source change to `main` for inclusion in the next release:

```bash
git -C ~/Moorhen checkout main && git pull --ff-only
git -C ~/Moorhen cherry-pick <sha>
git -C ~/Moorhen push
git -C ~/Moorhen checkout ncs-ghosts
git -C ~/Moorhen-dev pull --ff-only
```

## Where to look

- [`README.md`](README.md) — top-level overview (includes upstream Moorhen's README below the PyKeko intro)
- [`README-MH.md`](README-MH.md) — features added on top of upstream
- [`PROJECT-NOTES.md`](PROJECT-NOTES.md) — implementation writeups, build steps, decisions
- [`docs/install-mac.md`](docs/install-mac.md) — end-user install guide
- [`docs/dmg-packaging-plan.md`](docs/dmg-packaging-plan.md) — the dist-variant design doc
- [`docs/pymol-translator.md`](docs/pymol-translator.md) — PyMOL command reference for the scripting modal
