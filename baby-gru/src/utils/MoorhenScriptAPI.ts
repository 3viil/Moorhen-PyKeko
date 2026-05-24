import type { Store } from "@reduxjs/toolkit";
import { moorhen } from "../types/moorhen"
import { webGL } from "../types/mgWebGL";
import { addMolecule, removeMolecule, showMolecule, hideMolecule } from "../store/moleculesSlice";
import { addMap } from "../store/mapsSlice";
import { setOrigin, setZoom, setQuat, setRequestDrawScene, setLightPosition, setAmbient, setSpecular, setDiffuse, setSpecularPower, setFogClipOffset, setFogStart, setFogEnd, setClipStart, setClipEnd, setActiveMolecule, setDraggableMolecule, setDisplayBuffers} from "../store/glRefSlice"
import { enqueueSnackbar } from "@/store"
import { addTextOverlay, addSvgPathOverlay, addFracPathOverlay, emptyOverlays} from "../store/overlaysSlice"
import { setDrawCrosshairs, setDrawScaleBar, setDrawMissingLoops, setDefaultBondSmoothness,
    setDoSSAO, setSsaoRadius, setSsaoBias, setResetClippingFogging, setClipCap, resetSceneSettings, setEdgeDetectNormalScale,
    setDoShadow, setDoSpin,setDepthBlurRadius, setBackgroundColor,
    setDepthBlurDepth, setDrawAxes, setEdgeDetectDepthScale,
    setDoEdgeDetect, setEdgeDetectDepthThreshold, setEdgeDetectNormalThreshold, setDrawEnvBOcc, setDoAnaglyphStereo,
    setDoCrossEyedStereo, setDoSideBySideStereo, setDoThreeWayView, setDoMultiView, setMultiViewRows, setMultiViewColumns,
    setSpecifyMultiViewRowsColumns, setThreeWayViewOrder} from "../store/sceneSettingsSlice"
import {setAnimateRefine, setEnableRefineAfterMod, setUseRamaRefinementRestraints, 
  setuseTorsionRefinementRestraints, setRefinementSelection, resetRefinementSettings } from "../store/refinementSettingsSlice"
import { MoleculeRepresentation } from "./MoorhenMoleculeRepresentation";
import { ColourRule } from "./MoorhenColourRule";
import { MoorhenMap } from "./MoorhenMap";
import { MoorhenMolecule } from "./MoorhenMolecule";
import { executePymolScript } from "./MoorhenPymolTranslator";

export class MoorhenScriptApi  {

    commandCentre: React.RefObject<moorhen.CommandCentre>;
    glRef: React.RefObject<webGL.MGWebGL>;
    store: Store;

    constructor(commandCentre: React.RefObject<moorhen.CommandCentre> = null, store: Store = null, molecules: moorhen.Molecule[] = null, maps: moorhen.Map[] = null) {
        this.store = store;
        this.commandCentre = commandCentre;
        // NB: store-backed reads are live (see buildEnv getters); the cached
        // fields are only used when callers explicitly passed an override list.
        this._moleculesOverride = molecules ?? null;
        this._mapsOverride = maps ?? null;
    }

    private _moleculesOverride: moorhen.Molecule[] | null;
    private _mapsOverride: moorhen.Map[] | null;

    get molecules(): moorhen.Molecule[] {
        if (this._moleculesOverride) return this._moleculesOverride;
        return this.store ? (this.store.getState() as any).molecules?.moleculeList ?? [] : [];
    }
    get maps(): moorhen.Map[] {
        if (this._mapsOverride) return this._mapsOverride;
        return this.store ? (this.store.getState() as any).maps ?? [] : [];
    }

    doRigidBodyFit = async (molNo: number, cidsString: string, mapNo: number) => {
        const selectedMolecule = this.molecules.find(molecule => molecule.molNo === molNo)
        if (typeof selectedMolecule !== 'undefined') {
            await selectedMolecule.rigidBodyFit(cidsString, mapNo)
        } else {
            console.log(`Unable to find molecule number ${molNo}`)
        }
    }

    doGenerateSelfRestraints = async (molNo: number, maxRadius: number) => {
        const selectedMolecule = this.molecules.find(molecule => molecule.molNo === molNo)
        if (typeof selectedMolecule !== 'undefined') {
            await selectedMolecule.generateSelfRestraints("//", maxRadius)
        } else {
            console.log(`Unable to find molecule number ${molNo}`)
        }
    }

    doRefineResiduesUsingAtomCid = async (molNo: number, cid: string, mode: string, ncyc: number) => {
        const selectedMolecule = this.molecules.find(molecule => molecule.molNo === molNo)
        if (typeof selectedMolecule !== 'undefined') {
            await selectedMolecule.refineResiduesUsingAtomCid(cid, mode, ncyc)
        } else {
            console.log(`Unable to find molecule number ${molNo}`)
        }
    }

    doClearExtraRestraints = async (molNo: number) => {
        const selectedMolecule = this.molecules.find(molecule => molecule.molNo === molNo)
        if (typeof selectedMolecule !== 'undefined') {
            await selectedMolecule.clearExtraRestraints()
        } else {
            console.log(`Unable to find molecule number ${molNo}`)
        }
    }

    setGemanMcclureAlpha = async (newValue: number) => {
        await this.commandCentre.current.cootCommand({
            returnType: "status",
            command: 'set_refinement_geman_mcclure_alpha',
            commandArgs: [newValue],
            changesMolecules: []
          }, true)
    }

    runCommand = async (command: string, ...args: any[]): Promise<void> => {
        await this.commandCentre.current.cootCommand({
            returnType: 'void',
            command: command,
            commandArgs: [...args]
          }, true)
          await this.redraw_molecules()
    }

    redraw_molecules = async () => {
        await Promise.all(this.molecules.map(molecule => {
            molecule.setAtomsDirty(true)
            return molecule.redraw()
          }))
    }

    /**
     * Build the env object exposed inside user scripts. Shared between the
     * JS-mode `exe()` and the PyMOL translator so both modes see the same
     * molecules / maps / dispatch / action-creator surface.
     */
    buildEnv(): Record<string, any> {
        const env = {
            molecules: this.molecules.reduce((obj, molecule) => {
                obj[molecule.molNo] = molecule
                return obj
            }, {}),
            maps: this.maps.reduce((obj, map) => {
                obj[map.molNo] = map
                return obj
            }, {}),
            glRef: this.glRef,
            commandCentre: this.commandCentre,
            MoorhenMolecule: MoorhenMolecule,
            MoorhenMap: MoorhenMap,
            MoorhenColourRule: ColourRule,
            MoorhenMoleculeRepresentation: MoleculeRepresentation,
            dispatch: (arg) => this.store.dispatch( arg ),
            addMolecule: addMolecule,
            removeMolecule: removeMolecule,
            showMolecule: showMolecule,
            hideMolecule: hideMolecule,
            addMap: addMap,
            run_command: this.runCommand,
            rigid_body_fit: this.doRigidBodyFit,
            generate_self_restraints: this.doGenerateSelfRestraints,
            clear_extra_restraints: this.doClearExtraRestraints,
            refine_residues_using_atom_cid: this.doRefineResiduesUsingAtomCid,
            set_refinement_geman_mcclure_alpha: this.setGemanMcclureAlpha,
            redraw_molecules: this.redraw_molecules,
            setOrigin: setOrigin,
            setZoom: setZoom,
            setQuat: setQuat,
            setRequestDrawScene: setRequestDrawScene,
            setLightPosition: setLightPosition,
            setAmbient: setAmbient,
            setSpecular: setSpecular,
            setDiffuse: setDiffuse,
            setSpecularPower: setSpecularPower,
            setFogClipOffset: setFogClipOffset,
            setFogStart: setFogStart,
            setFogEnd: setFogEnd,
            setClipStart: setClipStart,
            setClipEnd: setClipEnd,
            setActiveMolecule: setActiveMolecule,
            setDraggableMolecule: setDraggableMolecule,
            setDisplayBuffers: setDisplayBuffers,
            addTextOverlay: addTextOverlay,
            addSvgPathOverlay: addSvgPathOverlay,
            addFracPathOverlay: addFracPathOverlay,
            emptyOverlays: emptyOverlays,
            setDrawCrosshairs: setDrawCrosshairs,
            setDrawScaleBar: setDrawScaleBar,
            setDrawMissingLoops: setDrawMissingLoops,
            setDefaultBondSmoothness: setDefaultBondSmoothness,
            setDoSSAO: setDoSSAO,
            setSsaoRadius: setSsaoRadius,
            setSsaoBias: setSsaoBias,
            setResetClippingFogging: setResetClippingFogging,
            setClipCap: setClipCap,
            resetSceneSettings: resetSceneSettings,
            setEdgeDetectNormalScale: setEdgeDetectNormalScale,
            setDoShadow: setDoShadow,
            setDoSpin: setDoSpin,
            setDepthBlurRadius: setDepthBlurRadius,
            setBackgroundColor: setBackgroundColor,
            setDepthBlurDepth: setDepthBlurDepth,
            setDrawAxes: setDrawAxes,
            setEdgeDetectDepthScale: setEdgeDetectDepthScale,
            setDoEdgeDetect: setDoEdgeDetect,
            setEdgeDetectDepthThreshold: setEdgeDetectDepthThreshold,
            setEdgeDetectNormalThreshold: setEdgeDetectNormalThreshold,
            setDrawEnvBOcc: setDrawEnvBOcc,
            setDoAnaglyphStereo: setDoAnaglyphStereo,
            setDoCrossEyedStereo: setDoCrossEyedStereo,
            setDoSideBySideStereo: setDoSideBySideStereo,
            setDoThreeWayView: setDoThreeWayView,
            setDoMultiView: setDoMultiView,
            setMultiViewRows: setMultiViewRows,
            setMultiViewColumns: setMultiViewColumns,
            setSpecifyMultiViewRowsColumns: setSpecifyMultiViewRowsColumns,
            setThreeWayViewOrder: setThreeWayViewOrder,
            setAnimateRefine: setAnimateRefine,
            setEnableRefineAfterMod: setEnableRefineAfterMod,
            setUseRamaRefinementRestraints: setUseRamaRefinementRestraints,
            setuseTorsionRefinementRestraints: setuseTorsionRefinementRestraints,
            setRefinementSelection: setRefinementSelection,
            resetRefinementSettings: resetRefinementSettings,
            enqueueSnackbar: enqueueSnackbar,
            store: this.store,
        };
        return env;
    }

    /**
     * Execute a JavaScript script string against the Moorhen env.
     * The env is exposed via a `with()` block so users can write
     * `setOrigin([0,0,0])` instead of `env.setOrigin(...)`. The user code
     * may use top-level await — we wrap it in an async function so it
     * actually awaits.
     */
    async exe(src: string): Promise<unknown> {
        const env = this.buildEnv();
        const fn = new Function("with (this) { return (async () => { " + src + " })(); }");
        return fn.call(env);
    }

    /**
     * Execute a PyMOL script string. Parses line-by-line and dispatches
     * each command to the translator. Errors per line are surfaced as
     * console warnings; the rest of the script continues.
     */
    async exePymol(src: string): Promise<void> {
        const env = this.buildEnv();
        // Forward optional videoRecorderRef (set by MoorhenControlApi.runPymol)
        // so screenshot commands (png/ray) can grab the existing screen-capture pipeline.
        (env as any).videoRecorderRef = (this as any).videoRecorderRef ?? null;
        await executePymolScript(src, env, { commandCentre: this.commandCentre });
    }
}
