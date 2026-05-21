# MoorHenMH — Customized Moorhen Fork

A personal fork of [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen) with Coot 0.9.x-style keyboard shortcuts and UX defaults.

**Upstream**: [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen)
**This fork**: [3viil/MoorHenMH](https://github.com/3viil/MoorHenMH)

## What's different from upstream

### New keyboard shortcuts (Coot-style)

| Key | Action |
|-----|--------|
| `w` | Add waters |
| `a` | Autofit rotamer |
| `r` | Triple refine |
| `e` | Flip peptide |
| `t` | Add terminal residue |
| `j` | Jiggle fit |
| `k` | Delete sidechain |
| `x` | Go to next ligand |
| `z` | Autofit rotamer (alt) |
| `o` | NCS jump (cycle through NCS-related chains) |
| `Shift+F` | Fill partial residue |
| `Shift+H` | Refine active residue (single) |
| `Shift+S` | Quick-save coordinates |

### Conflict resolution (Moorhen defaults moved)

| Key | Was (upstream) | Now |
|-----|----------------|-----|
| `a` | Measure arbitrary distances | Moved to `d` |
| `r` | Restore scene | Moved to `v` |
| `g` | Go to blob | Moved to `b` |
| `z` | Wiggle camera | Unbound |

### Default preferences changed

- Background: **black** (was white)
- Initial representation: **bonds** (was ribbons)
- Hydrogens: **hidden** (was shown)
- Shortcut mode: **on hovered atom** (was center atom)

## Files modified

```
baby-gru/src/components/managers/preferences/DefaultShortcuts.ts
baby-gru/src/components/managers/preferences/PreferencesList.ts
baby-gru/src/moorhen.ts
baby-gru/src/utils/MoorhenFileLoading.ts
baby-gru/src/utils/MoorhenKeyboardPress.ts
baby-gru/src/utils/MoorhenMolecule.ts
baby-gru/src/utils/MoorhenMoleculeRepresentation.ts
```

## Pulling upstream changes

```bash
git fetch upstream
git merge upstream/main
# resolve any conflicts
git push origin main
```

## Building

See upstream [README.md](README.md) for build instructions. Briefly:

```bash
# One-time setup
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
brew install ninja meson cmake autoconf automake pkg-config

# Build WASM (takes ~1 hour first time)
source ~/emsdk/emsdk_env.sh
cd ~/MoorHenMH  # or wherever you cloned
./moorhen_build.sh
./moorhen_build.sh --64bit

# Run the dev server
cd baby-gru
npm install
npm start
# Open http://localhost:5173/ in Chrome
```

For desktop wrapper, see [3viil/MoorhenWrapper](https://github.com/3viil/MoorhenWrapper).
