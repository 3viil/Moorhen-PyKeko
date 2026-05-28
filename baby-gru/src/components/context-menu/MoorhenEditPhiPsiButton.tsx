// Residue torsion editor — backbone φ/ψ plus sidechain χ in one panel (Coot's
// "Edit Backbone Torsion" + chi editing combined). Backbone uses the set_phi_psi
// patch (local edit: only the residue moves, the peptide bond to the neighbour
// stretches, refine after). Sidechain χ uses the already-bound rotate_around_bond
// (intra-residue). Current angles are read from ramachandran_validation (φ/ψ) and
// get_torsion (χ). Sits in the residue right-click menu with the other fitting tools.
import { useCallback, useEffect, useRef, useState } from "react";
import { ClickAwayListener } from "@mui/material";
import { useCommandCentre } from "../../InstanceManager";
import { moorhen } from "../../types/moorhen";
import { MoorhenSlider } from "../inputs";
import { MoorhenContextButtonBase, ContextButtonProps } from "./MoorhenContextButtonBase";

// Standard χ definitions (atom quads, by residue type). ALA/GLY have none.
const CHI_DEFS: { [key: string]: string[][] } = {
    ARG: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD"], ["CB", "CG", "CD", "NE"], ["CG", "CD", "NE", "CZ"]],
    ASN: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "OD1"]],
    ASP: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "OD1"]],
    CYS: [["N", "CA", "CB", "SG"]],
    GLN: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD"], ["CB", "CG", "CD", "OE1"]],
    GLU: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD"], ["CB", "CG", "CD", "OE1"]],
    HIS: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "ND1"]],
    ILE: [["N", "CA", "CB", "CG1"], ["CA", "CB", "CG1", "CD1"]],
    LEU: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD1"]],
    LYS: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD"], ["CB", "CG", "CD", "CE"], ["CG", "CD", "CE", "NZ"]],
    MET: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "SD"], ["CB", "CG", "SD", "CE"]],
    PHE: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD1"]],
    PRO: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD"]],
    SER: [["N", "CA", "CB", "OG"]],
    THR: [["N", "CA", "CB", "OG1"]],
    TRP: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD1"]],
    TYR: [["N", "CA", "CB", "CG"], ["CA", "CB", "CG", "CD1"]],
    VAL: [["N", "CA", "CB", "CG1"]],
};

// PDB-style 4-char atom-name padding (element starts at col 2 for these standard atoms).
const pad = (n: string): string =>
    n.length >= 4 ? n : n.length === 3 ? " " + n : n.length === 2 ? " " + n + " " : " " + n + "  ";

const TorsionEditorPanel = (props: {
    molecule: moorhen.Molecule;
    chosenAtom: moorhen.ResidueSpec;
    commandCentre: React.RefObject<moorhen.CommandCentre>;
    setShowOverlay: React.Dispatch<React.SetStateAction<boolean>>;
    urlPrefix: string;
}) => {
    const { molecule, chosenAtom, commandCentre, setShowOverlay, urlPrefix } = props;
    const cid = `//${chosenAtom.chain_id}/${chosenAtom.res_no}`;
    const resName = (chosenAtom.res_name || "").toUpperCase();
    const chiDefs = CHI_DEFS[resName] || [];
    // Live Ramachandran plot: reuse Moorhen's Richardson contour backgrounds + the same
    // (phi,psi)->canvas mapping as MoorhenRamachandran, plotting the residue's point so it
    // tracks the φ/ψ sliders in real time (as in Coot's Edit Backbone Torsion).
    const ramaBg = resName === "GLY" ? "rama2_gly.png" : resName === "PRO" ? "rama2_pro.png"
        : (resName === "ILE" || resName === "VAL") ? "rama2_ileval.png" : "rama2_non_gly_pro.png";
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const bgImgRef = useRef<HTMLImageElement | null>(null);
    const [phi, setPhi] = useState<number>(0);
    const [psi, setPsi] = useState<number>(0);
    const [chis, setChis] = useState<number[]>(() => chiDefs.map(() => 0));
    const [ready, setReady] = useState<boolean>(false);

    // Seed sliders with current angles: φ/ψ from ramachandran_validation, χ from get_torsion.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await commandCentre.current.cootCommand(
                    { command: "ramachandran_validation", commandArgs: [molecule.molNo], returnType: "validation_data" }, false);
                const raw: any = res?.data?.result?.result;
                const items: any[] = raw && typeof raw.size === "function"
                    ? Array.from({ length: raw.size() }, (_, i) => raw.get(i))
                    : (Array.isArray(raw) ? raw : []);
                for (const item of items) {
                    const pp = item?.phi_psi ?? item;
                    if (pp && pp.chain_id === chosenAtom.chain_id && pp.residue_number === chosenAtom.res_no) {
                        const f = typeof pp.phi === "function" ? pp.phi() : pp.phi;
                        const s = typeof pp.psi === "function" ? pp.psi() : pp.psi;
                        if (!cancelled && typeof f === "number") setPhi(Math.round(f));
                        if (!cancelled && typeof s === "number") setPsi(Math.round(s));
                        break;
                    }
                }
            } catch (e) { /* leave at 0 */ }

            const vals: number[] = [];
            for (const quad of chiDefs) {
                let v = 0;
                try {
                    const r = await commandCentre.current.cootCommand(
                        { command: "get_torsion", commandArgs: [molecule.molNo, cid, quad.map(pad)], returnType: "status" }, false);
                    const rr: any = r?.data?.result?.result;
                    const got = rr && typeof rr === "object" ? (rr.second ?? rr[1]) : (typeof rr === "number" ? rr : null);
                    if (typeof got === "number") v = Math.round(got);
                } catch (e) { /* leave at 0 */ }
                vals.push(v);
            }
            if (!cancelled) { setChis(vals); setReady(true); }
        })();
        return () => { cancelled = true; };
    }, []);

    // Draw the contour background (cached) + the residue's φ/ψ point.
    const drawRama = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        if (bgImgRef.current) ctx.drawImage(bgImgRef.current, 0, 0, W, H);
        const x = ((phi / 180) * 0.5 + 0.5) * W;
        const y = ((-psi / 180) * 0.5 + 0.5) * H;   // psi axis points up, same as MoorhenRamachandran
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, 2 * Math.PI);
        ctx.fillStyle = "#ff3b30";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
    }, [phi, psi]);

    useEffect(() => {
        const img = new Image();
        img.onload = () => { bgImgRef.current = img; drawRama(); };
        img.src = `${urlPrefix}/pixmaps/${ramaBg}`;
        return () => { img.onload = null; };
    }, [ramaBg, urlPrefix]);

    useEffect(() => { drawRama(); }, [phi, psi, drawRama]);

    const applyBackbone = useCallback(async (newPhi: number, newPsi: number) => {
        try {
            await commandCentre.current.cootCommand(
                { command: "set_phi_psi", commandArgs: [molecule.molNo, cid, newPhi, newPsi], returnType: "status", changesMolecules: [molecule.molNo] }, true);
            molecule.setAtomsDirty(true);
            await molecule.redraw();
        } catch (e) { console.warn("[EditTorsion] set_phi_psi failed", e); }
    }, [molecule, cid, commandCentre]);

    const applyChi = useCallback(async (i: number, value: number) => {
        const quad = chiDefs[i];
        try {
            await commandCentre.current.cootCommand(
                { command: "rotate_around_bond", commandArgs: [molecule.molNo, cid, pad(quad[0]), pad(quad[1]), pad(quad[2]), pad(quad[3]), value], returnType: "status", changesMolecules: [molecule.molNo] }, true);
            molecule.setAtomsDirty(true);
            await molecule.redraw();
        } catch (e) { console.warn("[EditTorsion] rotate_around_bond failed", e); }
    }, [molecule, cid, chiDefs]);

    return (
        <ClickAwayListener onClickAway={() => setShowOverlay(false)}>
            <div style={{ padding: "0.5rem", minWidth: "16rem" }}>
                <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Edit torsions — {resName} {cid}</div>
                <canvas ref={canvasRef} width={180} height={180}
                    style={{ width: "180px", height: "180px", display: "block", margin: "0 auto 0.4rem", border: "1px solid #555", borderRadius: "4px", background: "#fff" }} />
                <MoorhenSlider sliderTitle="φ (phi)" minVal={-180} maxVal={180} decimalPlaces={0} isDisabled={!ready}
                    showButtons={true} usePreciseInput={true} externalValue={phi}
                    setExternalValue={(v: number) => { setPhi(v); applyBackbone(v, psi); }} />
                <MoorhenSlider sliderTitle="ψ (psi)" minVal={-180} maxVal={180} decimalPlaces={0} isDisabled={!ready}
                    showButtons={true} usePreciseInput={true} externalValue={psi}
                    setExternalValue={(v: number) => { setPsi(v); applyBackbone(phi, v); }} />
                {chiDefs.map((_, i) => (
                    <MoorhenSlider key={i} sliderTitle={`χ${i + 1}`} minVal={-180} maxVal={180} decimalPlaces={0}
                        isDisabled={!ready} showButtons={true} usePreciseInput={true} externalValue={chis[i]}
                        setExternalValue={(v: number) => {
                            setChis(prev => { const next = [...prev]; next[i] = v; return next; });
                            applyChi(i, v);
                        }} />
                ))}
                <div style={{ fontSize: "0.75rem", opacity: 0.7, marginTop: "0.25rem" }}>
                    φ/ψ move the residue locally — refine the zone afterwards for a mid-chain edit.
                </div>
            </div>
        </ClickAwayListener>
    );
};

export const MoorhenEditPhiPsiButton = (props: ContextButtonProps) => {
    const commandCentre = useCommandCentre();

    const openEditor = useCallback(async (mol: moorhen.Molecule, atom: moorhen.ResidueSpec) => {
        props.setOverlayContents(
            <TorsionEditorPanel molecule={mol} chosenAtom={atom} commandCentre={commandCentre} setShowOverlay={props.setShowOverlay} urlPrefix={props.urlPrefix} />
        );
        setTimeout(() => props.setShowOverlay(true), 50);
    }, [props, commandCentre]);

    return (
        <MoorhenContextButtonBase
            icon={<span style={{ fontSize: "1.4rem", fontStyle: "italic", fontWeight: 700, color: "#4dabf7", lineHeight: 1 }}>φψχ</span>}
            toolTipLabel="Edit torsions (φ/ψ backbone + χ sidechain)"
            needsAtomData={true}
            nonCootCommand={openEditor}
            {...props}
        />
    );
};
