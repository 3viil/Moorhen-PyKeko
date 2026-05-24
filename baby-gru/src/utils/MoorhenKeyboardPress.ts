import * as vec3 from 'gl-matrix/vec3';
import * as quat4 from 'gl-matrix/quat';
import { Dispatch } from "react";
import { AnyAction, Store } from "@reduxjs/toolkit";

import { quatToMat4, quat4Inverse } from '../WebGLgComponents/quatToMat4';
import { getDeviceScale } from '../WebGLgComponents/webGLUtils';
import { vec3Create } from '../WebGLgComponents/mgMaths';
import { moorhen } from "../types/moorhen";
import { libcootApi } from "../types/libcoot";
import { webGL } from "../types/mgWebGL";
import { setHoveredAtom } from "../store/hoveringStatesSlice";
import { changeMapRadius } from "../store/mapContourSettingsSlice";
import { triggerUpdate } from "../store/moleculeMapUpdateSlice";
import { Shortcut } from '../components/managers/preferences';
import { setOrigin, setZoom, setQuat, setShortCutHelp,setClipStart, setClipEnd, triggerClearLabels } from "../store/glRefSlice";
import { cidToSpec, getCentreAtom } from "./utils"
import { setShownControl, RootState, enqueueSnackbar  } from '@/store';
import { setIsDraggingAtoms } from "../store/generalStatesSlice";

// Module-level cycle index for go_to_ligand shortcut. Starts at -1 so first press goes to index 0.
let ligandCycleIdx = -1;
// Module-level state for next_diff_peak shortcut. Peaks refetched on each press;
// idx advances even if the model didn't change, so successive presses walk the list.
let diffPeakCycleIdx = -1;
let diffPeakCacheKey = "";
let diffPeakCache: Array<{ x: number; y: number; z: number; sigma: number }> = [];
// Module-level state for next_issue shortcut. Same idea — refetch when we've
// walked the whole list or model/map changed.
let issueCycleIdx = -1;
let issueCacheKey = "";
let issueCache: Array<{ cid: string; type: string; badness: number; label: string }> = [];

const apresEdit = (molecule: moorhen.Molecule, glRef: React.RefObject<webGL.MGWebGL>, dispatch: Dispatch<AnyAction>) => {
    molecule.setAtomsDirty(true)
    molecule.redraw()
    dispatch( setHoveredAtom({ molecule: null, cid: null,  atomInfo: null }) )
    dispatch( triggerUpdate(molecule.molNo) )
}


export const moorhenKeyPress = (
    event: KeyboardEvent, 
    collectedProps: {
        dispatch: Dispatch<AnyAction>;
        store: Store<RootState>;
        hoveredAtom: moorhen.HoveredAtom;
        commandCentre: React.RefObject<moorhen.CommandCentre>;
        activeMap: moorhen.Map;
        molecules: moorhen.Molecule[];
        glRef: React.RefObject<webGL.MGWebGL>;
        viewOnly: boolean;
        videoRecorderRef: React.RefObject<moorhen.ScreenRecorder>;
    }, 
    shortCuts: {[key: string]: Shortcut}, 
    showShortcutToast: boolean, 
    shortcutOnHoveredAtom: boolean
): boolean | Promise<boolean> => {
    
    const { 
        hoveredAtom, activeMap, commandCentre, glRef, molecules, 
        viewOnly, videoRecorderRef, dispatch, store
    } = collectedProps;


    const originState = store.getState().glRef.origin
    const zoom = store.getState().glRef.zoom
    const myQuat = store.getState().glRef.quat
    const fogStart = store.getState().glRef.fogStart
    const fogEnd = store.getState().glRef.fogEnd
    const clipStart = store.getState().glRef.clipStart
    const clipEnd = store.getState().glRef.clipEnd
    const width = store.getState().sceneSettings.width
    const height = store.getState().sceneSettings.height
    const cursorPosition = store.getState().glRef.cursorPosition
    const shortCutHelp = store.getState().glRef.shortCutHelp

    const getFrontAndBackPos = () : [number[], number[], number, number] =>  {
        const x = cursorPosition[0];
        const y = cursorPosition[1];
        const invQuat = quat4.create();
        quat4Inverse(myQuat, invQuat);
        const theMatrix = quatToMat4(invQuat);
        const ratio = width / height;
        const minX = (-24. * ratio * zoom);
        const maxX = (24. * ratio * zoom);
        const minY = (-24. * zoom);
        const maxY = (24. * zoom);
        const fracX = 1.0 * x / width
        const fracY = 1.0 * (y) / height
        const theX = minX + fracX * (maxX - minX);
        const theY = maxY - fracY * (maxY - minY);
        const frontPos = vec3Create([theX, theY, -clipStart]); // Maybe should be -clipStart
        const backPos = vec3Create([theX, theY, clipEnd]);
        vec3.transformMat4(frontPos, frontPos, theMatrix);
        vec3.transformMat4(backPos, backPos, theMatrix);
        vec3.subtract(frontPos, frontPos, originState);
        vec3.subtract(backPos, backPos, originState);
        return [frontPos, backPos, x*getDeviceScale(), y*getDeviceScale()];
    }

    const doAtomInfo = async (): Promise<boolean> => {
        if (hoveredAtom.molecule) {
            let chosenAtom: moorhen.ResidueSpec
            chosenAtom = cidToSpec(hoveredAtom.cid)
            const fragmentCid = chosenAtom.cid
            const chosenMolecule = hoveredAtom.molecule
            dispatch(setShownControl({ name: "atomInfo", payload: { molNo: chosenMolecule.molNo, fragmentCid } }))
            return false
        }
    }

    const doShortCut = async (cootCommand: string, formatArgs: (arg0: moorhen.Molecule, arg1: moorhen.ResidueSpec) => any[]): Promise<boolean> => {
        let chosenMolecule: moorhen.Molecule
        let chosenAtom: moorhen.ResidueSpec
        let residueCid: string
        
        if (!shortcutOnHoveredAtom) {
            [chosenMolecule, residueCid] = await getCentreAtom(molecules, commandCentre, store)
            if (typeof chosenMolecule === 'undefined' || !residueCid) {
                console.log('Cannot find atom in the centre of the view...')
                return true
            }
            chosenAtom = cidToSpec(residueCid)
        } else if (hoveredAtom.molecule) {
            chosenAtom = cidToSpec(hoveredAtom.cid)
            chosenMolecule = hoveredAtom.molecule
        }
        
        if (chosenAtom && chosenMolecule) {
            return commandCentre.current.cootCommand({
                returnType: "status",
                command: cootCommand,
                commandArgs: formatArgs(chosenMolecule, chosenAtom),
                changesMolecules: [chosenMolecule.molNo]
            }, true)
            .then(_ => {
                apresEdit(chosenMolecule, glRef, dispatch)
            })
            .then(_ => false)
            .catch(err => {
                console.log(err)
                return true
            })
        }
        return true
    }
    
    const modifiers: string[] = []
    const eventModifiersCodes: string[] = []

    if (event.shiftKey) {
        modifiers.push("<Shift>")
        eventModifiersCodes.push('shiftKey')
    }
    if (event.ctrlKey) {
        modifiers.push("<Ctrl>")
        eventModifiersCodes.push('ctrlKey')
    }
    if (event.metaKey) {
        modifiers.push("<Meta>")
        eventModifiersCodes.push('metaKey')
    }
    if (event.altKey) {
        modifiers.push("<Alt>")
        eventModifiersCodes.push('altKey')
    }
    if (event.key === " ") modifiers.push("<Space>")

    let action: null | string = null;

    for (const key of Object.keys(shortCuts)) {
        if (event.key && shortCuts[key].keyPress === event.key.toLowerCase() && shortCuts[key].modifiers.every(modifier => event[modifier]) && eventModifiersCodes.every(modifier => shortCuts[key].modifiers.includes(modifier))) {
            action = key
            break
        }
    }

    if (!action) {
        return true
    }

    if (action === 'sphere_refine' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}`, "SPHERE", 4000]
        }
        if (showShortcutToast) {
            dispatch(enqueueSnackbar({ message:"Sphere refine",  variant: "info"}))
        }
        return doShortCut('refine_residues_using_atom_cid', formatArgs)
    }

    else if ((action === 'undo' || action === 'redo') && !viewOnly) {
        const selectedMolNo = commandCentre.current.history.lastModifiedMolNo()
        const selectedMolecule = molecules.find(molecule => molecule.molNo === selectedMolNo)
        let promise: Promise<void>
        if(!selectedMolecule) {
            return true
        } else if (action === 'undo') {
            promise = selectedMolecule.undo()
        } else {
            promise = selectedMolecule.redo()
        }
        promise.then(_ => {
            dispatch( triggerUpdate(selectedMolecule.molNo) )
        })
        return false
    }

    else if (action === 'flip_peptide' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}/${chosenAtom.atom_name}`, '']
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Flip peptide",  variant: "info"}))
        return doShortCut('flipPeptide_cid', formatArgs)
    }

    else if (action === 'triple_refine' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}`, "TRIPLE", 4000]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Triple refine",  variant: "info"}))
        return doShortCut('refine_residues_using_atom_cid', formatArgs)
    }

    else if (action === 'auto_fit_rotamer' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [
                chosenMolecule.molNo,
                chosenAtom.chain_id,
                chosenAtom.res_no,
                chosenAtom.ins_code,
                chosenAtom.alt_conf,
                activeMap.molNo
            ]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Auto fit rotamer",  variant: "info"}))
        return doShortCut('auto_fit_rotamer', formatArgs)
    }

    else if (action === 'add_terminal_residue' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo,  `//${chosenAtom.chain_id}/${chosenAtom.res_no}`]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Add residue",  variant: "info"}))
        return doShortCut('add_terminal_residue_directly_using_cid', formatArgs)
    }

    else if (action === 'delete_residue' && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [
                chosenMolecule.molNo, 
                `/1/${chosenAtom.chain_id}/${chosenAtom.res_no}/*${chosenAtom.alt_conf === "" ? "" : ":" + chosenAtom.alt_conf}`, 
                'LITERAL'
            ]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Delete residue",  variant: "info"}))
        return doShortCut('delete_using_cid', formatArgs)
    }

    else if (action === 'eigen_flip' && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}`]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Eigen flip",  variant: "info"}))
        return doShortCut('eigen_flip_ligand', formatArgs)
    }

    else if (action === 'go_to_residue' && molecules.length > 0) {
        dispatch(setShownControl({ name: "goToResidue"}))
    }

    else if (action === 'toggle_ncs_ghosts') {
        (async () => {
            let chosenMolecule: moorhen.Molecule | undefined
            let chain: string | undefined
            if (hoveredAtom.molecule) {
                chosenMolecule = hoveredAtom.molecule
                chain = cidToSpec(hoveredAtom.cid).chain_id
            } else {
                const [mol, cid] = await getCentreAtom(molecules, commandCentre, store)
                if (mol && cid) {
                    chosenMolecule = mol
                    chain = cidToSpec(cid).chain_id
                }
            }
            if (!chosenMolecule || !chain) return
            if (chosenMolecule.ncsGhostReps?.length > 0) {
                chosenMolecule.clearNcsGhosts()
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "NCS ghosts cleared", variant: "info" }))
            } else {
                const n = await chosenMolecule.drawNcsGhosts(chain)
                if (showShortcutToast) dispatch(enqueueSnackbar({
                    message: n > 0 ? `NCS ghosts on chain ${chain}: ${n} copies` : `No NCS copies for chain ${chain}`,
                    variant: "info"
                }))
            }
        })().catch(err => console.warn("[g] toggle_ncs_ghosts failed:", err))
        return false
    }

    else if (action === 'go_to_blob' && activeMap && !viewOnly) {
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Go to blob",  variant: "info"}))
        const frontAndBack: [number[], number[], number, number] = getFrontAndBackPos()
        const goToBlobEvent = {
            back: [frontAndBack[0][0], frontAndBack[0][1], frontAndBack[0][2]],
            front: [frontAndBack[1][0], frontAndBack[1][1], frontAndBack[1][2]],
            windowX: frontAndBack[2],
            windowY: frontAndBack[3],
        };

        commandCentre.current.cootCommand({
            returnType: "float_array",
            command: "go_to_blob_array",
            commandArgs: [goToBlobEvent.front[0], goToBlobEvent.front[1], goToBlobEvent.front[2], goToBlobEvent.back[0], goToBlobEvent.back[1], goToBlobEvent.back[2], 0.5]
        }, false)
        .then(response => {
            const newOrigin = response.data.result.result;
            if (newOrigin.length === 3) {
                dispatch(setOrigin([-newOrigin[0], -newOrigin[1], -newOrigin[2]]))
            }
        })
    }

    else if (action === 'clear_labels') {
        dispatch(triggerClearLabels(true))
        molecules.forEach(molecule => molecule.clearBuffersOfStyle('residueSelection'))
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Clear labels",  variant: "info"}))
    }

    else if (action === 'move_up') {
        const invQuat = quat4.create();
        quat4Inverse(myQuat, invQuat);
        const theMatrix = quatToMat4(invQuat);
        const yshift = vec3Create([0, 4. / getDeviceScale(), 0]);
        vec3.transformMat4(yshift, yshift, theMatrix);
        const x = originState[0] + (yshift[0] / 8. * zoom)
        const y = originState[1] + (yshift[1] / 8. * zoom)
        const z = originState[2] + (yshift[2] / 8. * zoom)
        dispatch(setOrigin([x, y, z]))
    }

    else if (action === 'move_down') {
        const invQuat = quat4.create();
        quat4Inverse(myQuat, invQuat);
        const theMatrix = quatToMat4(invQuat);
        const yshift = vec3Create([0, -4. / getDeviceScale(), 0]);
        vec3.transformMat4(yshift, yshift, theMatrix);
        const x = originState[0] + (yshift[0] / 8. * zoom);
        const y = originState[1] + (yshift[1] / 8. * zoom);
        const z = originState[2] + (yshift[2] / 8. * zoom);
        dispatch(setOrigin([x, y, z]))
    }

    else if (action === 'move_left') {
        const invQuat = quat4.create();
        quat4Inverse(myQuat, invQuat);
        const theMatrix = quatToMat4(invQuat);
        const xshift = vec3Create([-4. / getDeviceScale(), 0, 0]);
        vec3.transformMat4(xshift, xshift, theMatrix);
        const x = originState[0] + (xshift[0] / 8. * zoom)
        const y = originState[1] + (xshift[1] / 8. * zoom)
        const z = originState[2] + (xshift[2] / 8. * zoom)
        dispatch(setOrigin([x, y, z]))
    }

    else if (action === 'move_right') {
        const invQuat = quat4.create();
        quat4Inverse(myQuat, invQuat);
        const theMatrix = quatToMat4(invQuat);
        const xshift = vec3Create([4. / getDeviceScale(), 0, 0]);
        vec3.transformMat4(xshift, xshift, theMatrix);
        const x = originState[0] + (xshift[0] / 8. * zoom)
        const y = originState[1] + (xshift[1] / 8. * zoom)
        const z = originState[2] + (xshift[2] / 8. * zoom)
        dispatch(setOrigin([x, y, z]))
    }

    else if (action === 'restore_scene') {
        const newQuat = quat4.create()
        quat4.set(newQuat, 0, 0, 0, -1)
        dispatch(setZoom(1.0))
        dispatch(setQuat(newQuat))
        dispatch(triggerClearLabels(true))
    }

    else if (action === 'increase_map_radius' || action === 'decrease_map_radius') {
        if (activeMap) {
            dispatch( changeMapRadius({ molNo: activeMap.molNo, factor: action === 'increase_map_radius' ? 2 : -2 }) )
        }
    }

    else if (action === 'take_screenshot') {
        dispatch(setShownControl({ name: "screenshot" }))
    }

    else if (action === 'show_shortcuts') {
        let showShortCutHelp: string[] = [];

        if(shortCutHelp.length===0){
            showShortCutHelp = Object.keys(shortCuts).filter(key => !viewOnly || shortCuts[key].viewOnly).map(key => {
                const modifiers = []
                if (shortCuts[key].modifiers.includes('shiftKey')) modifiers.push("<Shift>")
                if (shortCuts[key].modifiers.includes('ctrlKey')) modifiers.push("<Ctrl>")
                if (shortCuts[key].modifiers.includes('metaKey')) modifiers.push("<Meta>")
                if (shortCuts[key].modifiers.includes('altKey')) modifiers.push("<Alt>")
                if (shortCuts[key].keyPress === " ") modifiers.push("<Space>")
                return `${modifiers.join("-")} ${shortCuts[key].keyPress} ${shortCuts[key].label}`
            })
            showShortCutHelp.push(`<Shift><Alt> Translate View`)
            showShortCutHelp.push(`<Shift> Rotate View`)
            showShortCutHelp.push(`Double click go to blob`)
            showShortCutHelp.push(`<Ctrl><Scroll> Change active map contour lvl.`)
        } else  {
            showShortCutHelp = []
        }
        dispatch(setShortCutHelp(showShortCutHelp))
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:(showShortCutHelp.length>0) ? 'Show help' : 'Hide help',  variant: "info"}))
        return false
    }

    else if (action === 'jump_next_residue' || action === 'jump_previous_residue') {
        (async () => {
            let selectedMolecule: moorhen.Molecule | undefined
            let residueCid: string | undefined
            const [centreMol, centreCid] = await getCentreAtom(molecules, commandCentre, store)
            if (centreMol && centreCid) {
                selectedMolecule = centreMol
                residueCid = centreCid
            } else {
                // Fall back: any loaded molecule (visibleMolecules state may be empty
                // if the molecule was loaded via a path that didn't dispatch showMolecule,
                // e.g. the MCP load_coordinates flow)
                const fallbackMol = hoveredAtom.molecule ?? molecules[0]
                if (!fallbackMol) return
                const origin = store.getState().glRef.origin
                try {
                    const resp = await commandCentre.current.cootCommand({
                        returnType: "int_string_pair",
                        command: "get_active_atom",
                        commandArgs: [-origin[0], -origin[1], -origin[2], `${fallbackMol.molNo}`],
                    }, false) as moorhen.WorkerResponse<libcootApi.PairType<number, string>>
                    residueCid = resp.data?.result?.result?.second
                    selectedMolecule = fallbackMol
                } catch (e) { return }
            }
            if (!selectedMolecule || !residueCid) return

            const chosenAtom = cidToSpec(residueCid)
            const selectedSequence = selectedMolecule.sequences.find(sequence => sequence.chain === chosenAtom.chain_id)
            if (!selectedSequence) return
            const selectedResidueIndex = selectedSequence.sequence.findIndex(res => res.resNum === chosenAtom.res_no)
            if (selectedResidueIndex === -1) return
            let nextResNum: number
            if (action === 'jump_next_residue' && selectedResidueIndex !== selectedSequence.sequence.length - 1) {
                nextResNum = selectedSequence.sequence[selectedResidueIndex + 1].resNum
            } else if (action === 'jump_previous_residue' && selectedResidueIndex !== 0) {
                nextResNum = selectedSequence.sequence[selectedResidueIndex - 1].resNum
            } else {
                return
            }
            selectedMolecule.centreAndAlignViewOn(`/*/${chosenAtom.chain_id}/${nextResNum}-${nextResNum}/`, true)
        })().catch(err => console.log(err))
    }

    else if (action === 'decrease_front_clip') {
        dispatch(setClipStart(clipStart-0.5))
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Front clip down",  variant: "info"}))
        return false
    }

    else if (action === 'increase_front_clip') {
        dispatch(setClipStart(clipStart+0.5))
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Front clip up",  variant: "info"}))
        return false
    }

    else if (action === 'decrease_back_clip') {
        dispatch(setClipEnd(clipEnd-0.5))
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Back clip down",  variant: "info"}))
        return false
    }

    else if (action === 'increase_back_clip') {
        dispatch(setClipEnd(clipEnd+0.5))
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Back clip up",  variant: "info"}))
        return false
    }
    else if (action === 'show_atom_info') {
        return doAtomInfo()
    }

    else if (action === 'auto_fit_rotamer_coot' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, chosenAtom.chain_id, chosenAtom.res_no, chosenAtom.ins_code, chosenAtom.alt_conf, activeMap.molNo]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Autofit rotamer",  variant: "info"}))
        return doShortCut('auto_fit_rotamer', formatArgs)
    }

    else if (action === 'refine_residue' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}`, "SINGLE", 4000]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Refine residue",  variant: "info"}))
        return doShortCut('refine_residues_using_atom_cid', formatArgs)
    }

    else if (action === 'pepflip_coot' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}/${chosenAtom.atom_name}`, '']
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Flip peptide",  variant: "info"}))
        return doShortCut('flipPeptide_cid', formatArgs)
    }

    else if (action === 'add_terminal_residue_coot' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}`]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Add terminal residue",  variant: "info"}))
        return doShortCut('add_terminal_residue_directly_using_cid', formatArgs)
    }

    else if (action === 'drag_atoms' && activeMap && !viewOnly && molecules.length > 0) {
        (async () => {
            // Mirror MoorhenDragAtomsButton.nonCootCommand: pick the chosen molecule/residue,
            // build a fragment CID for the active refinement selection, then enter drag mode.
            let chosenMolecule: moorhen.Molecule | undefined
            let chosenAtom: moorhen.ResidueSpec | undefined
            if (hoveredAtom.molecule && hoveredAtom.cid) {
                chosenMolecule = hoveredAtom.molecule
                chosenAtom = cidToSpec(hoveredAtom.cid)
            } else {
                const [centreMol, centreCid] = await getCentreAtom(molecules, commandCentre, store)
                if (!centreMol || !centreCid) {
                    // Fallback: derive from active atom on molecules[0] regardless of visibleMolecules state
                    const fallbackMol = molecules[0]
                    if (!fallbackMol) return
                    const origin = store.getState().glRef.origin
                    const resp = await commandCentre.current.cootCommand({
                        returnType: "int_string_pair",
                        command: "get_active_atom",
                        commandArgs: [-origin[0], -origin[1], -origin[2], `${fallbackMol.molNo}`],
                    }, false) as moorhen.WorkerResponse<libcootApi.PairType<number, string>>
                    const fbCid = resp.data?.result?.result?.second
                    if (!fbCid) return
                    chosenMolecule = fallbackMol
                    chosenAtom = cidToSpec(fbCid)
                } else {
                    chosenMolecule = centreMol
                    chosenAtom = cidToSpec(centreCid)
                }
            }
            if (!chosenMolecule || !chosenAtom) return

            const refinementSelection = (store.getState() as any).refinementSettings?.refinementSelection ?? "SINGLE"
            const selectedSequence = chosenMolecule.sequences.find(s => s.chain === chosenAtom.chain_id)
            const selectedResidueIndex = selectedSequence
                ? selectedSequence.sequence.findIndex(r => r.resNum === chosenAtom.res_no)
                : -1
            const selectionType = selectedResidueIndex === -1 ? "SINGLE" : refinementSelection
            let start: number, stop: number
            let sphereResidueCids: string[] | undefined
            switch (selectionType) {
                case "SINGLE":
                    start = chosenAtom.res_no; stop = chosenAtom.res_no; break
                case "TRIPLE":
                    start = selectedResidueIndex > 0 ? selectedSequence.sequence[selectedResidueIndex - 1].resNum : chosenAtom.res_no
                    stop = selectedResidueIndex < selectedSequence.sequence.length - 1 ? selectedSequence.sequence[selectedResidueIndex + 1].resNum : chosenAtom.res_no
                    break
                case "QUINTUPLE":
                    start = selectedResidueIndex >= 2 ? selectedSequence.sequence[selectedResidueIndex - 2].resNum : chosenAtom.res_no
                    stop = selectedResidueIndex < selectedSequence.sequence.length - 2 ? selectedSequence.sequence[selectedResidueIndex + 2].resNum : chosenAtom.res_no
                    break
                case "HEPTUPLE":
                    start = selectedResidueIndex >= 3 ? selectedSequence.sequence[selectedResidueIndex - 3].resNum : chosenAtom.res_no
                    stop = selectedResidueIndex < selectedSequence.sequence.length - 3 ? selectedSequence.sequence[selectedResidueIndex + 3].resNum : chosenAtom.res_no
                    break
                case "SPHERE":
                    sphereResidueCids = await chosenMolecule.getNeighborResiduesCids(chosenAtom.cid, 6)
                    break
                default:
                    start = chosenAtom.res_no; stop = chosenAtom.res_no
            }
            const fragmentCid = selectionType === "SPHERE" && sphereResidueCids
                ? sphereResidueCids
                : [`//${chosenAtom.chain_id}/${start}-${stop}/*`]
            dispatch(setShownControl({ name: "acceptRejectDraggingAtoms", payload: { molNo: chosenMolecule.molNo, fragmentCid } }))
            dispatch(setHoveredAtom({ molecule: null, cid: null, atomInfo: null }))
            dispatch(setIsDraggingAtoms(true))
            if (showShortcutToast) dispatch(enqueueSnackbar({ message: `Drag atoms: ${selectionType}`, variant: "info" }))
        })()
        return false
    }

    else if (action === 'add_water' && activeMap && !viewOnly && molecules.length > 0) {
        // Single water at the view crosshairs + single-residue refine.
        // glRef.origin is the negated atom coordinate of the view centre.
        const [ox, oy, oz] = originState
        ;(async () => {
            // Prefer the molecule under the cursor / at the view centre, so
            // multi-molecule scenes drop water in the right place rather than
            // blindly using molecules[0].
            let targetMolecule: moorhen.Molecule | undefined
            if (hoveredAtom.molecule) {
                targetMolecule = hoveredAtom.molecule
            } else {
                const [centreMol] = await getCentreAtom(molecules, commandCentre, store)
                targetMolecule = centreMol ?? molecules[0]
            }
            if (!targetMolecule) return
            const cid = await targetMolecule.addWaterAtPosition(-ox, -oy, -oz)
            if (!cid) {
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "Add water failed", variant: "warning" }))
                return
            }
            let refined = true
            try {
                await commandCentre.current.cootCommand({
                    returnType: "status",
                    command: "refine_residues_using_atom_cid",
                    commandArgs: [targetMolecule.molNo, cid, "SINGLE", 4000],
                    changesMolecules: [targetMolecule.molNo],
                }, true)
            } catch (e) { refined = false; console.warn("refine after add_water failed:", e) }
            apresEdit(targetMolecule, glRef, dispatch)
            if (showShortcutToast) dispatch(enqueueSnackbar({
                message: refined ? `Added water ${cid} + refined` : `Added water ${cid} (refine failed)`,
                variant: refined ? "info" : "warning",
            }))
        })().catch(err => console.warn("[w] add_water failed:", err))
        return false
    }

    else if (action === 'delete_sidechain' && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [
                chosenMolecule.molNo,
                `/1/${chosenAtom.chain_id}/${chosenAtom.res_no}/!N,CA,C,O,CB,H,HA${chosenAtom.alt_conf === "" ? "" : ":" + chosenAtom.alt_conf}`,
                'LITERAL'
            ]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Delete sidechain",  variant: "info"}))
        return doShortCut('delete_using_cid', formatArgs)
    }

    else if (action === 'fill_partial' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, chosenAtom.chain_id, chosenAtom.res_no, chosenAtom.ins_code]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Fill partial residue",  variant: "info"}))
        return doShortCut('fill_partial_residue', formatArgs)
    }

    else if (action === 'jiggle_fit' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, `//${chosenAtom.chain_id}/${chosenAtom.res_no}`, activeMap.molNo, 100, 1.0]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Jiggle fit",  variant: "info"}))
        return doShortCut('fit_to_map_by_random_jiggle_using_cid', formatArgs)
    }

    else if (action === 'rotamers_dialog' && activeMap && !viewOnly) {
        const formatArgs = (chosenMolecule: moorhen.Molecule, chosenAtom: moorhen.ResidueSpec) => {
            return [chosenMolecule.molNo, chosenAtom.chain_id, chosenAtom.res_no, chosenAtom.ins_code, chosenAtom.alt_conf, activeMap.molNo]
        }
        if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Autofit rotamer",  variant: "info"}))
        return doShortCut('auto_fit_rotamer', formatArgs)
    }

    else if (action === 'quick_save' && !viewOnly) {
        if (molecules.length > 0) {
            molecules[0].downloadAtoms()
            if (showShortcutToast) dispatch(enqueueSnackbar({ message:"Saved coordinates",  variant: "info"}))
        }
        return false
    }

    else if ((action === 'ncs_jump' || action === 'ncs_jump_prev') && molecules.length > 0) {
        const step = action === 'ncs_jump' ? 1 : -1;
        (async () => {
            const targetMolecule = hoveredAtom.molecule ?? molecules[0];
            let currentChain: string | null = null;
            let currentResNo: number | null = null;
            if (hoveredAtom.molecule && hoveredAtom.cid) {
                const spec = cidToSpec(hoveredAtom.cid);
                currentChain = spec.chain_id;
                currentResNo = spec.res_no;
            } else {
                const [centreMol, centreCid] = await getCentreAtom(molecules, commandCentre, store);
                if (centreMol && centreCid) {
                    const spec = cidToSpec(centreCid);
                    currentChain = spec.chain_id;
                    currentResNo = spec.res_no;
                }
            }
            if (!currentChain || currentResNo === null) {
                console.log('NCS jump: no current chain/residue');
                return;
            }
            const ncsGroups = await targetMolecule.getNcsRelatedChains();
            const group = ncsGroups.find(g => g.includes(currentChain));
            if (!group || group.length < 2) {
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "No NCS-related chains found", variant: "info" }));
                return;
            }
            const idx = group.indexOf(currentChain);
            const nextChain = group[(idx + step + group.length) % group.length];
            const nextCid = `/*/${nextChain}/${currentResNo}-${currentResNo}/`;
            if (showShortcutToast) dispatch(enqueueSnackbar({ message: `NCS jump to chain ${nextChain}`, variant: "info" }));
            await targetMolecule.centreAndAlignViewOn(nextCid, true);
        })();
        return false;
    }

    else if (action === 'next_diff_peak' || action === 'prev_diff_peak') {
        const step = action === 'next_diff_peak' ? 1 : -1;
        (async () => {
            const maps = (store.getState() as any).maps as moorhen.Map[]
            const diffMap = Array.isArray(maps) ? maps.find(m => m.isDifference) : null
            if (!diffMap) {
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "No difference map loaded", variant: "warning" }))
                return
            }
            const targetMolecule = hoveredAtom.molecule ?? molecules[0]
            if (!targetMolecule) {
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "No molecule loaded", variant: "warning" }))
                return
            }
            // Include the edit-history length so caches invalidate when the
            // user refines / builds / rebuilds — otherwise we keep returning
            // stale peak positions from before the edit.
            const editVer = commandCentre.current?.history?.getEntriesForMolNo?.(targetMolecule.molNo)?.length ?? 0
            const cacheKey = `${targetMolecule.molNo}|${diffMap.molNo}|${editVer}`
            if (cacheKey !== diffPeakCacheKey || diffPeakCache.length === 0) {
                const resp = await commandCentre.current.cootCommand({
                    returnType: "interesting_places_data",
                    command: "difference_map_peaks",
                    commandArgs: [diffMap.molNo, targetMolecule.molNo, 3.0],
                }, false) as moorhen.WorkerResponse<libcootApi.InterestingPlaceDataJS[]>
                const places = resp.data.result.result ?? []
                diffPeakCache = places
                    .map(p => ({ x: p.coordX, y: p.coordY, z: p.coordZ, sigma: p.featureValue }))
                    .sort((a, b) => Math.abs(b.sigma) - Math.abs(a.sigma))
                diffPeakCacheKey = cacheKey
                diffPeakCycleIdx = -1
            }
            if (diffPeakCache.length === 0) {
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "No diff-map peaks above 3σ", variant: "info" }))
                return
            }
            diffPeakCycleIdx = (diffPeakCycleIdx + step + diffPeakCache.length) % diffPeakCache.length
            const peak = diffPeakCache[diffPeakCycleIdx]
            dispatch(setOrigin([-peak.x, -peak.y, -peak.z]))
            if (showShortcutToast) dispatch(enqueueSnackbar({
                message: `Peak ${diffPeakCycleIdx + 1}/${diffPeakCache.length}: ${peak.sigma.toFixed(1)}σ`,
                variant: "info",
            }))
        })()
        return false
    }

    else if (action === 'next_issue' || action === 'prev_issue') {
        const step = action === 'next_issue' ? 1 : -1;
        (async () => {
            const targetMolecule = hoveredAtom.molecule ?? molecules[0]
            if (!targetMolecule) {
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "No molecule loaded", variant: "warning" }))
                return
            }
            const mapMolNo = activeMap?.molNo ?? -1
            const editVer = commandCentre.current?.history?.getEntriesForMolNo?.(targetMolecule.molNo)?.length ?? 0
            const cacheKey = `${targetMolecule.molNo}|${mapMolNo}|${editVer}`
            if (cacheKey !== issueCacheKey || issueCache.length === 0) {
                const wrap = (cmd: string, args: any[]) => commandCentre.current.cootCommand({
                    returnType: "validation_data",
                    command: cmd,
                    commandArgs: args,
                }, false) as Promise<moorhen.WorkerResponse<libcootApi.ValidationInformationJS[]>>
                const promises: Promise<{ data: libcootApi.ValidationInformationJS[]; type: string }>[] = [
                    wrap("ramachandran_analysis", [targetMolecule.molNo]).then(r => ({ data: r.data.result.result ?? [], type: "rama" })),
                    wrap("rotamer_analysis",      [targetMolecule.molNo]).then(r => ({ data: r.data.result.result ?? [], type: "rotamer" })),
                ]
                if (mapMolNo >= 0) {
                    promises.push(wrap("density_fit_analysis", [targetMolecule.molNo, mapMolNo]).then(r => ({ data: r.data.result.result ?? [], type: "density" })))
                }
                const results = await Promise.all(promises)
                const merged: typeof issueCache = []
                for (const { data, type } of results) {
                    if (data.length === 0) continue
                    // Per-category badness normalization (worst → 100)
                    if (type === "rama" || type === "rotamer") {
                        // value is a probability; outliers have p<0.02
                        for (const r of data) {
                            if (r.value >= 0 && r.value < 0.02) {
                                merged.push({
                                    cid: `//${r.chainId}/${r.seqNum}`,
                                    type,
                                    badness: (1 - r.value) * 100,
                                    label: `${r.restype ?? ""} p=${r.value.toFixed(3)}`,
                                })
                            }
                        }
                    } else if (type === "density") {
                        // density_fit_analysis: function_value is a fit score; higher = worse
                        // Take the worst 30 as outliers, normalized to that range.
                        const sorted = [...data].filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 30)
                        if (sorted.length > 0) {
                            const worst = sorted[0].value
                            for (const r of sorted) {
                                merged.push({
                                    cid: `//${r.chainId}/${r.seqNum}`,
                                    type,
                                    badness: (r.value / worst) * 100,
                                    label: `${r.restype ?? ""} fit=${r.value.toFixed(2)}`,
                                })
                            }
                        }
                    }
                }
                merged.sort((a, b) => b.badness - a.badness)
                issueCache = merged
                issueCacheKey = cacheKey
                issueCycleIdx = -1
            }
            if (issueCache.length === 0) {
                if (showShortcutToast) dispatch(enqueueSnackbar({ message: "No validation issues found", variant: "info" }))
                return
            }
            issueCycleIdx = (issueCycleIdx + step + issueCache.length) % issueCache.length
            const issue = issueCache[issueCycleIdx]
            await targetMolecule.centreOn(issue.cid, true, true)
            if (showShortcutToast) dispatch(enqueueSnackbar({
                message: `Issue ${issueCycleIdx + 1}/${issueCache.length} (${issue.type}): ${issue.cid} ${issue.label}`,
                variant: "info",
            }))
        })()
        return false
    }

    else if (action === 'go_to_ligand') {
        // Collect all ligands across all loaded molecules
        const allLigands: { molecule: moorhen.Molecule; cid: string; label: string }[] = []
        molecules.forEach(m => {
            if (m.ligands) {
                m.ligands.forEach(l => {
                    allLigands.push({
                        molecule: m,
                        cid: l.cid,
                        label: `${m.name} ${l.resName} ${l.chainName}/${l.resNum}`,
                    })
                })
            }
        })
        if (allLigands.length === 0) {
            if (showShortcutToast) dispatch(enqueueSnackbar({ message: "No ligands found", variant: "info" }))
            return false
        }
        ligandCycleIdx = (ligandCycleIdx + 1) % allLigands.length
        const target = allLigands[ligandCycleIdx]
        target.molecule.centreOn(target.cid, true, true)
        if (showShortcutToast) dispatch(enqueueSnackbar({
            message: `Ligand ${ligandCycleIdx + 1}/${allLigands.length}: ${target.label}`,
            variant: "info",
        }))
        return false
    }

    return true
}
