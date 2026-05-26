<p align="center">
  <img src="https://raw.githubusercontent.com/pykeko/PyKeko/main/PyKeko_icon.png" alt="PyKeko" width="120" height="120" />
</p>

# Installing PyKeko on macOS Tahoe (15.x)

This is the install guide for the **distributable DMG** of Moorhen-PyKeko — the fork
of [Moorhen](https://github.com/moorhen-coot/Moorhen) with NCS ghosts, the
PyMOL-style scripting modal, the MCP control surface, validation/peak/ligand
cyclers, and the other additions described in
[README-MH.md](../README-MH.md).

The DMG is **unsigned**, so macOS will refuse to launch it on the first try
unless you take one of the steps below. This is not a Moorhen problem — it
applies to any app downloaded from the internet that does not pay Apple
$99/year for a Developer ID certificate.

---

## Requirements

- **macOS 15.x (Tahoe)** on Apple Silicon (M1 / M2 / M3 / M4).
  - Sequoia (macOS 14) might work but is not tested.
  - Intel Macs are not supported by this build — see [Other architectures](#other-architectures) below.
- **About 500 MB free disk space** (the app is ~250 MB on disk after install,
  plus another ~50 MB cache).
- No other dependencies. The app self-contains Electron, the WASM build of
  CCP4/Coot, and all monomer libraries.

---

## Install

### 1. Download the DMG

Visit the latest release on GitHub and download `PyKeko.dmg`:

**https://github.com/pykeko/Moorhen-PyKeko/releases/latest**

Or from the terminal:

```bash
gh release download --repo pykeko/Moorhen-PyKeko --pattern '*.dmg'
```

(`gh` downloads skip the macOS quarantine attribute that the browser sets, so
if you go this route you can **skip step 3 below**.)

### 2. Drag PyKeko.app to /Applications

Open the downloaded `PyKeko.dmg`. A Finder window opens showing `PyKeko.app`
and a shortcut to `/Applications`. Drag `PyKeko.app` onto the `Applications`
shortcut.

Then eject the DMG (right-click → Eject) and delete the downloaded `.dmg` —
the app is now installed.

### 3. **Bypass Gatekeeper** (one-time, only if downloaded via browser)

Because the app is unsigned, macOS refuses to launch it the first time. You
have two options:

#### Option A — Terminal (recommended, ~3 seconds)

Open Terminal (Spotlight: type "Terminal", hit return), then paste and run:

```bash
xattr -dr com.apple.quarantine /Applications/PyKeko.app
```

That's it. Now you can double-click `PyKeko.app` from `/Applications` (or
Spotlight) and it launches normally.

#### Option B — Right-click → Open (no terminal needed)

1. Open `/Applications` in Finder.
2. **Right-click** (or two-finger tap, or Ctrl-click) on `PyKeko.app`.
3. Pick **Open** from the context menu.
4. macOS shows a warning dialog: *"macOS cannot verify the developer of
   'Moorhen'…"*. Click **Open**.
5. The app launches. Future launches (from Dock, Spotlight, or double-click)
   work normally — you only do this once.

---

## Verifying it works

On first launch:

- A loading screen reading **"Moorhen is loading…"** appears for ~5 seconds
  while the WASM build of CCP4 initialises.
- Once loaded, you should see the empty 3D viewport with the top menu bar
  (File / Edit / Calculate / View / …) and the side panel.

To smoke-test, in the **File** menu pick **PDB → Fetch from PDBe**, type a PDB
ID (e.g. `4hhb` for haemoglobin) and click **Fetch**. The structure should
load and render as a cartoon.

If the app launches but the viewport is blank or you see "Moorhen is
loading…" forever, see [Troubleshooting](#troubleshooting) below.

---

## What's in the DMG

Everything Moorhen needs at runtime is inside the `.app` bundle. No external
installs required:

| Component | Bundled? | Size |
|-----------|----------|------|
| Electron + Chromium + Node | ✅ | ~330 MB |
| WASM build of CCP4 / Coot / MMDB / gemmi | ✅ | 41 MB |
| Monomer dictionaries | ✅ | 4.3 MB |
| Tutorial structures (built into File → Tutorials) | ✅ | 6.9 MB |
| MathJax, pixmaps, fonts, PWA service worker | ✅ | ~30 MB |
| **CCP4 install** | ❌ not needed |  |
| **Coot binary install** | ❌ not needed |  |
| **Node / npm on your machine** | ❌ not needed |  |
| **Internet, for local file work** | ❌ not needed |  |
| **Internet, for "Fetch from PDB"** | Required at fetch time | — |
| **Claude / MCP integration** | Separate install (see below) | — |

Final installed size: ~408 MB. The DMG itself is ~178 MB compressed.

The app is fully offline-capable for any structure file you have locally —
PDB, mmCIF, MTZ, CCP4 maps, ligand .cif dictionaries, etc. It only reaches the
network when you explicitly use **Fetch from PDB** / **Fetch from PDB-Redo** /
**Fetch from EBI**.

---

## What's included

All features listed in [README-MH.md](../README-MH.md) are present:

- **PyMOL-style scripting** in `Edit → Interactive Scripting` (toggle the
  language selector to **PyMOL**)
- **NCS ghost overlays** — press `g` while hovering over an NCS-related chain
- **Coot-style keyboard shortcuts** — `w` (water), `p` (next diff peak),
  `n` (next validation issue), `d` (drag atoms), `l` (cycle ligands),
  `o` (NCS jump), `g` (toggle NCS ghosts)
- **MCP control surface** — see [Claude integration](#claude-integration) below

See [`docs/pymol-translator.md`](pymol-translator.md) for the full PyMOL
command reference.

---

## Claude integration

The app exposes an MCP control surface on `127.0.0.1:42000` (with a
per-launch token in `~/.moorhen-mcp/control-<port>.json`). To wire it up to
Claude Code or Claude Desktop, separately install
[PyKekoMCP](https://github.com/pykeko/PyKekoMCP):

```bash
git clone https://github.com/pykeko/PyKekoMCP ~/PyKekoMCP
cd ~/PyKekoMCP
npm install
npm run build
claude mcp add moorhen -- node ~/PyKekoMCP/dist/server.js
```

The MCP bridge auto-discovers any running Moorhen variant (Moorhen, PyKeko,
PyKekoDev) via the control file. Use the standalone DMG by default; the
`MOORHEN_VITE_PORT` env var lets you pin to a specific instance if you have
more than one open.

---

## Troubleshooting

### "Moorhen is damaged and can't be opened"

You skipped step 3. Run:

```bash
xattr -dr com.apple.quarantine /Applications/PyKeko.app
```

### Window opens but renderer is blank / stuck on "Moorhen is loading…"

The most common cause is a corrupted Electron user-data cache from a previous
install. Clear it:

```bash
rm -rf "~/Library/Application Support/moorhen-wrapper"
```

Then relaunch the app.

### App launches but Claude / MCP can't see it

Confirm the control file exists:

```bash
ls ~/.moorhen-mcp/
# expected: one file like control-<port>.json
```

If the directory is empty, the app's control server failed to start. Check
`/tmp/moorhen-dist.log` for an error.

If the file is there but Claude can't connect, set the right port:

```bash
export MOORHEN_VITE_PORT=$(cat ~/.moorhen-mcp/control-*.json | python3 -c "import sys,json; print(json.load(sys.stdin)['vitePort'])")
```

…then restart Claude Code.

### Updating to a newer version

1. Quit the running Moorhen app (Cmd+Q).
2. Move the existing `/Applications/PyKeko.app` to Trash.
3. Re-do steps 1–3 above with the new DMG.

User preferences (background colour, default representation, shortcut
options) live in browser localStorage under
`~/Library/Application Support/moorhen-wrapper/Local Storage/` and survive
re-installs.

---

## Uninstall

```bash
rm -rf /Applications/PyKeko.app
rm -rf "~/Library/Application Support/moorhen-wrapper"
rm -rf "~/Library/Caches/moorhen-wrapper"
rm -rf ~/.moorhen-mcp
```

---

## Other architectures

The released DMG is **arm64-only**. If you need an Intel build, you'd have to
build from source — see [README-MH.md](../README-MH.md#building) for
instructions. An x86_64 binary would work technically (the WASM payload is
architecture-independent; only the Electron host changes) but no x86_64 build
is currently produced. If demand exists, opening an issue against the
[PyKeko](https://github.com/pykeko/PyKeko) repo is the right
place to request it.

---

## Build it yourself

If you'd rather not trust a random unsigned binary, you can produce the same
DMG from source:

```bash
# 1. Build the WASM (one-time, ~1 hour)
git clone --recursive https://github.com/pykeko/Moorhen-PyKeko ~/Moorhen
cd ~/Moorhen
# … follow the WASM build steps in README-MH.md …

# 2. Build the DMG
git clone https://github.com/pykeko/PyKeko ~/PyKeko
cd ~/PyKeko
git checkout dist-variant
npm install
MOORHEN_VARIANT=dist npm run make
# → out/make/PyKeko.dmg
```

The DMG you produce will be byte-different from the released one (build
timestamps, Electron version, etc.), but functionally identical.
