// @ts-nocheck
// MoorhenControlApi — a small, typed control surface over the live Moorhen app.
// Built by MoorhenControlBridge (which supplies the live commandCentre/store/dispatch),
// exposed as window.MoorhenControlApi and driven by the wrapper's control bridge.
// v1 (Phase 1): load/navigate/core-edits/state. Screenshots are handled by the
// Electron wrapper (webContents.capturePage), not here.
//
// NB headless control has no mouse events, so after anything that changes the scene we
// dispatch setRequestDrawScene to force MoorhenWebMG to repaint the WebGL canvas.
import { MoorhenMolecule } from "../utils/MoorhenMolecule";
import { MoorhenMap } from "../utils/MoorhenMap";
import { MoorhenScriptApi } from "../utils/MoorhenScriptAPI";
import { addMolecule, showMolecule } from "../store/moleculesSlice";
import { addMap } from "../store/mapsSlice";
import { setActiveMap } from "../store/generalStatesSlice";
import { triggerUpdate } from "../store/moleculeMapUpdateSlice";
import { setRequestDrawScene } from "../store/glRefSlice";

type Ctx = { commandCentre: any; store: any; dispatch: any; monomerLibraryPath: string; videoRecorderRef?: any };

const DEFAULT_MTZ_COLUMNS = {
  F: "FWT", PHI: "PHWT", Fobs: "FP", SigFobs: "SIGFP", FreeR: "FREE",
  isDifference: false, useWeight: false, calcStructFact: true,
};

function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function createControlApi(ctx: Ctx) {
  const { commandCentre, store, dispatch, monomerLibraryPath } = ctx;

  const getMolecules = () => store.getState().molecules.moleculeList || [];
  const getMaps = () => store.getState().maps || [];
  const getActiveMap = () => store.getState().generalStates.activeMap;
  const repaint = () => dispatch(setRequestDrawScene(true));

  const molByNo = (molNo?: number) => {
    const mols = getMolecules();
    if (molNo === undefined || molNo === null) {
      // Don't trust a stale active-molecule ref: only honour it if the
      // referenced molNo is still in the live list. Otherwise fall back to
      // the most recently loaded molecule. Returning a dangling MoorhenMolecule
      // here previously caused "Cannot pass deleted object" when downstream
      // code called gemmiStructure methods on it.
      const active = store.getState().glRef?.activeMolecule;
      if (active && active.molNo !== undefined) {
        const live = mols.find((m) => m.molNo === active.molNo);
        if (live) return live;
      }
      return mols[mols.length - 1];
    }
    return mols.find((m) => m.molNo === molNo);
  };
  const requireMol = (molNo?: number) => { const m = molByNo(molNo); if (!m) throw new Error("no molecule loaded"); return m; };
  const requireActiveMap = () => { const m = getActiveMap(); if (!m) throw new Error("no active map — load a map first"); return m; };

  // Re-fetch atoms, redraw representations, repaint the scene (post raw-cootCommand edit).
  const refresh = async (mol: any) => {
    mol.setAtomsDirty(true);
    await mol.redraw();
    dispatch(triggerUpdate(mol.molNo));
    repaint();
  };

  // Authoritative atom count straight from coot (mol.atomCount caches stale after edits).
  const liveAtomCount = async (mol: any) => {
    try {
      const r = await commandCentre.current.cootCommand({ returnType: "status", command: "get_number_of_atoms", commandArgs: [mol.molNo] }, false);
      const n = r?.data?.result?.result;
      return typeof n === "number" ? n : mol.atomCount;
    } catch (e) { return mol.atomCount; }
  };

  // Tolerant CID parse "/mdl/chain/resno(ins)/atom:alt" -> fields (for auto_fit_rotamer)
  const parseCid = (cid: string) => {
    const m = cid.match(/\/(?:\d*)\/([A-Za-z0-9]*)\/(-?\d+)([A-Za-z]?)(?:\/([^:]*))?(?::(.*))?/);
    return { chain: m ? m[1] : "", resNo: m ? parseInt(m[2], 10) : NaN, insCode: (m && m[3]) || "", altConf: (m && m[5]) || "" };
  };

  const coot = (command: string, commandArgs: any[], molNo: number, returnType = "status") =>
    commandCentre.current.cootCommand({ returnType, command, commandArgs, changesMolecules: [molNo] }, true);

  const api = {
    async getState() {
      const molecules = [];
      for (const m of getMolecules()) molecules.push({ molNo: m.molNo, name: m.name, atomCount: await liveAtomCount(m) });
      return {
        molecules,
        maps: getMaps().map((m) => ({ molNo: m.molNo, name: m.name, isDifference: m.isDifference })),
        activeMapMolNo: getActiveMap()?.molNo ?? null,
      };
    },

    async loadCoordsFromString(pdbString: string, name = "molecule") {
      const mol = new MoorhenMolecule(commandCentre, store, monomerLibraryPath);
      await mol.loadToCootFromString(pdbString, name);
      await mol.fetchIfDirtyAndDraw("CBs");
      dispatch(addMolecule(mol));
      // Keyboard shortcuts (space-jump, drag-atoms) and the eye-icon read
      // state.molecules.visibleMolecules; addMolecule alone doesn't flip it.
      dispatch(showMolecule(mol));
      await mol.centreOn("/*/*/*/*", false, true);
      repaint();
      return { molNo: mol.molNo, name: mol.name, atomCount: await liveAtomCount(mol) };
    },

    async loadCoordsFromURL(url: string, name = "molecule") {
      const mol = new MoorhenMolecule(commandCentre, store, monomerLibraryPath);
      await mol.loadToCootFromURL(url, name);
      await mol.fetchIfDirtyAndDraw("CBs");
      dispatch(addMolecule(mol));
      // Keyboard shortcuts (space-jump, drag-atoms) and the eye-icon read
      // state.molecules.visibleMolecules; addMolecule alone doesn't flip it.
      dispatch(showMolecule(mol));
      await mol.centreOn("/*/*/*/*", false, true);
      repaint();
      return { molNo: mol.molNo, name: mol.name, atomCount: await liveAtomCount(mol) };
    },

    async loadMapFromMtz(mtzBase64: string, name = "map", columns?: any) {
      const map = new MoorhenMap(commandCentre, store);
      await map.loadToCootFromMtzData(b64ToUint8(mtzBase64), name, { ...DEFAULT_MTZ_COLUMNS, ...(columns || {}) });
      dispatch(addMap(map));
      dispatch(setActiveMap(map));
      await map.setActive();
      await map.drawMapContour();
      repaint();
      return { molNo: map.molNo, name: map.name, isDifference: map.isDifference };
    },

    async loadMapFromCcp4(mapBase64: string, name = "map", isDifference = false) {
      const map = new MoorhenMap(commandCentre, store);
      await map.loadToCootFromMapData(b64ToUint8(mapBase64), name, isDifference);
      dispatch(addMap(map));
      dispatch(setActiveMap(map));
      await map.setActive();
      await map.drawMapContour();
      repaint();
      return { molNo: map.molNo, name: map.name, isDifference: map.isDifference };
    },

    // Batch-load a set of files (the CLI-launch path: `pykeko a.pdb b.mtz c.cif`).
    // fileSpecs: [{ name, dataBase64 }]. Loads in type order regardless of input order —
    // coordinates first, then restraints/dictionary CIFs (attached to the molecules just
    // loaded, NOT spawned as monomers), then maps. A .cif is classified by content
    // (data_comp_* without _atom_site) exactly as autoOpenFiles does.
    async loadFiles(fileSpecs: { name: string; dataBase64: string }[]) {
      const decoder = new TextDecoder();
      const isCoordExt = (n: string) => /\.(pdb|ent|cif|mmcif)$/i.test(n);
      const isMtz = (n: string) => /\.mtz$/i.test(n);
      const isMapExt = (n: string) => /\.(mrc|map|ccp4)(\.gz)?$/i.test(n);

      const coordFiles: { name: string; text: string }[] = [];
      const dictFiles: { name: string; text: string }[] = [];
      const mtzFiles: { name: string; bytes: Uint8Array }[] = [];
      const mapFiles: { name: string; base64: string }[] = [];

      for (const spec of fileSpecs) {
        if (isCoordExt(spec.name)) {
          const text = decoder.decode(b64ToUint8(spec.dataBase64));
          const isDict = /data_comp_\S/i.test(text) && !/_atom_site\.\s/.test(text);
          (isDict ? dictFiles : coordFiles).push({ name: spec.name, text });
        } else if (isMtz(spec.name)) {
          mtzFiles.push({ name: spec.name, bytes: b64ToUint8(spec.dataBase64) });
        } else if (isMapExt(spec.name)) {
          mapFiles.push({ name: spec.name, base64: spec.dataBase64 });
        }
        // unknown extensions (e.g. .pb sessions, .json) are not handled via the CLI path yet
      }

      const results: any[] = [];
      const preExisting = getMolecules();
      const loadedMols: any[] = [];

      // 1. Coordinates — each becomes a molecule
      for (const f of coordFiles) {
        const mol = new MoorhenMolecule(commandCentre, store, monomerLibraryPath);
        await mol.loadToCootFromString(f.text, f.name);
        if (mol.molNo === -1) { results.push({ file: f.name, type: "error", error: "could not read as coordinates" }); continue; }
        await mol.fetchIfDirtyAndDraw("CBs");
        dispatch(addMolecule(mol));
        dispatch(showMolecule(mol));
        loadedMols.push(mol);
        results.push({ file: f.name, type: "molecule", molNo: mol.molNo, atomCount: await liveAtomCount(mol) });
      }

      // 2. Restraints dictionaries — attach to molecules (existing + just-loaded), never a new molecule
      const targetMols = [...preExisting, ...loadedMols];
      for (const f of dictFiles) {
        if (targetMols.length === 0) {
          // Nothing to attach to — register globally so any later load can use it
          await commandCentre.current.cootCommand({ returnType: "status", command: "read_dictionary_string", commandArgs: [f.text, -999999], changesMolecules: [] }, false);
          results.push({ file: f.name, type: "dictionary", attachedTo: "global" });
        } else {
          for (const mol of targetMols) { await mol.addDict(f.text); await mol.redraw(); dispatch(triggerUpdate(mol.molNo)); }
          results.push({ file: f.name, type: "dictionary", attachedTo: targetMols.map((m) => m.molNo) });
        }
      }

      // 3. Maps — MTZ via auto-read (detects F/PHI + difference columns), CCP4/MRC direct
      for (const f of mtzFiles) {
        const file = new File([f.bytes], f.name);
        const newMaps = await MoorhenMap.autoReadMtz(file, commandCentre, store);
        for (let i = 0; i < newMaps.length; i++) {
          const m = newMaps[i];
          dispatch(addMap(m));
          await m.drawMapContour();
          if (i === 0) { dispatch(setActiveMap(m)); await m.setActive(); }
          results.push({ file: f.name, type: "map", molNo: m.molNo, isDifference: m.isDifference });
        }
        if (newMaps.length === 0) results.push({ file: f.name, type: "error", error: "no maps read from MTZ" });
      }
      for (const f of mapFiles) {
        const isDiff = /_fofc\.|_diff\./i.test(f.name);
        const r = await this.loadMapFromCcp4(f.base64, f.name, isDiff);
        results.push({ file: f.name, type: "map", molNo: r.molNo, isDifference: r.isDifference });
      }

      // Centre on the last coordinates loaded (maps centre themselves only when no molecule present)
      if (loadedMols.length > 0) await loadedMols[loadedMols.length - 1].centreOn("/*/*/*/*", false, true);
      repaint();
      return { loaded: results };
    },

    async setActiveMap(mapMolNo: number) {
      const map = getMaps().find((m) => m.molNo === mapMolNo);
      if (!map) throw new Error("map not found: " + mapMolNo);
      dispatch(setActiveMap(map));
      await map.setActive();
      return { activeMapMolNo: map.molNo };
    },

    async goToResidue(cid: string, molNo?: number) {
      const mol = requireMol(molNo);
      await mol.centreOn(cid, false, true);
      repaint();
      return { centeredOn: cid, molNo: mol.molNo };
    },

    async refine(cid: string, mode = "TRIPLE", molNo?: number) {
      const mol = requireMol(molNo);
      const map = requireActiveMap();
      await map.setActive();
      await mol.refineResiduesUsingAtomCid(cid, mode, 4000, true);
      dispatch(triggerUpdate(mol.molNo));
      repaint();
      return { refined: cid, mode, molNo: mol.molNo };
    },

    async autoFitRotamer(cid: string, molNo?: number) {
      const mol = requireMol(molNo);
      const map = requireActiveMap();
      const { chain, resNo, insCode, altConf } = parseCid(cid);
      await coot("auto_fit_rotamer", [mol.molNo, chain, resNo, insCode, altConf, map.molNo], mol.molNo);
      await refresh(mol);
      return { autoFitRotamer: cid, molNo: mol.molNo };
    },

    async flipPeptide(cid: string, molNo?: number) {
      const mol = requireMol(molNo);
      await coot("flipPeptide_cid", [mol.molNo, cid, ""], mol.molNo);
      await refresh(mol);
      return { flipped: cid, molNo: mol.molNo };
    },

    async addTerminalResidue(cid: string, molNo?: number) {
      const mol = requireMol(molNo);
      await coot("add_terminal_residue_directly_using_cid", [mol.molNo, cid], mol.molNo);
      await refresh(mol);
      return { addedTerminal: cid, molNo: mol.molNo };
    },

    async addWaters(molNo?: number) {
      const mol = requireMol(molNo);
      const map = requireActiveMap();
      await coot("add_waters", [mol.molNo, map.molNo, 2.6, 4.0], mol.molNo);
      await refresh(mol);
      return { addedWaters: true, molNo: mol.molNo };
    },

    async deleteCid(cid: string, molNo?: number) {
      const mol = requireMol(molNo);
      await coot("delete_using_cid", [mol.molNo, cid, "LITERAL"], mol.molNo);
      await refresh(mol);
      return { deleted: cid, molNo: mol.molNo };
    },

    async undo(molNo?: number) {
      const mol = requireMol(molNo);
      await mol.undo();
      dispatch(triggerUpdate(mol.molNo));
      repaint();
      return { undo: true, molNo: mol.molNo };
    },

    async redo(molNo?: number) {
      const mol = requireMol(molNo);
      await mol.redo();
      dispatch(triggerUpdate(mol.molNo));
      repaint();
      return { redo: true, molNo: mol.molNo };
    },

    async coot(command: string, commandArgs: any[] = [], molNo?: number, returnType = "status") {
      const mol = molByNo(molNo);
      const res = await commandCentre.current.cootCommand(
        { returnType, command, commandArgs, changesMolecules: mol ? [mol.molNo] : [] }, true);
      return { command, result: res?.data?.result?.result ?? null };
    },

    // Run a PyMOL or JS script through MoorhenScriptApi. Exposed primarily so
    // an autonomous CDP-based test loop can iterate on the translator without
    // poking the modal.
    async runPymol(script: string) {
      const api = new MoorhenScriptApi(commandCentre, store);
      // The translator reads videoRecorderRef off env when png/ray are invoked.
      (api as any).videoRecorderRef = ctx.videoRecorderRef;
      await api.exePymol(script);
      repaint();
      return { ok: true };
    },
    async runJs(script: string) {
      const api = new MoorhenScriptApi(commandCentre, store);
      await api.exe(script);
      repaint();
      return { ok: true };
    },
  };

  return api;
}

export type MoorhenControlApi = ReturnType<typeof createControlApi>;
