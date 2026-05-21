# MoorHenMH — Customized Moorhen Fork

A personal fork of [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen) with Coot 0.9.x-style keyboard shortcuts and UX defaults.

**Upstream**: [moorhen-coot/Moorhen](https://github.com/moorhen-coot/Moorhen)
**This fork**: [3viil/MoorHenMH](https://github.com/3viil/MoorHenMH)
**Desktop wrapper**: [3viil/MoorhenWrapper](https://github.com/3viil/MoorhenWrapper)
**Full project notes**: [PROJECT-NOTES.md](PROJECT-NOTES.md)

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
| `g` | Go to blob | Moved to `b` |
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

## Files modified

```
baby-gru/src/components/managers/preferences/DefaultShortcuts.ts
baby-gru/src/components/managers/preferences/PreferencesList.ts
baby-gru/src/components/menu-item/ImportLigandDictionary.tsx
baby-gru/src/moorhen.ts
baby-gru/src/utils/MoorhenFileLoading.ts
baby-gru/src/utils/MoorhenKeyboardPress.ts
baby-gru/src/utils/MoorhenMolecule.ts
baby-gru/src/utils/MoorhenMoleculeRepresentation.ts
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
