import { CameraAlt, CloseOutlined, Photo, PhotoOutlined } from "@mui/icons-material";
import { IconButton, Tooltip } from "@mui/material";
import { useDispatch, useSelector } from "react-redux";
import { useRef, useState } from "react";
import { useMoorhenInstance, usePersistentState } from "@/hooks";
import { RootState, setDrawCrosshairs, setHoveredAtom, setShownControl } from "@/store";
import { MoorhenButton, MoorhenTextInput } from "../../inputs";
import { MoorhenStack } from "../../interface-base";
import "./popup-controls.css";

export const Screenshot = () => {
    const molecules = useSelector((state: RootState) => state.molecules.moleculeList);
    const isDark = useSelector((state: RootState) => state.sceneSettings.isDark);
    const moorhenInstance = useMoorhenInstance();
    const videoRecorderRef = moorhenInstance.getVideoRecorderRef();
    const showCrosshairs = useSelector((state: RootState) => state.sceneSettings.drawCrosshairs);
    const canvasSize = useSelector((state: RootState) => state.glRef.canvasSize);
    const [pictureName, setPictureName] = usePersistentState("scrrenshot", "pictureName", "moorhen_screenshot", true);
    const [screenShotHovered, setScreenShotHovered] = useState<boolean>(false);

    const [doTransparentBackground, setDoTransparentBackground] = useState<boolean>(false);

    const doTransparentBackgroundRef = useRef<boolean>(false);

    // Tier-1 high-res export. Multiplier is relative to the on-screen view; the
    // render ceiling is ~4096 px on the long edge, so "Max" tops out there.
    const [scale, setScale] = useState<"1" | "2" | "max">("2");
    const [highQuality, setHighQuality] = useState<boolean>(true);

    const dispatch = useDispatch();

    const handleScreenShot = async () => {
        dispatch(setHoveredAtom({ molecule: null, cid: null, atomInfo: null }));
        dispatch(setDrawCrosshairs(false));
        molecules.forEach(molecule => molecule.clearBuffersOfStyle("hover"));
        const _pictureName = pictureName !== "" ? pictureName : "moorhen_screenshot";
        const canvasW = canvasSize?.[0] || 0;
        const targetW = scale === "max" ? 4096 : Math.min(4096, canvasW * (scale === "2" ? 2 : 1));
        await videoRecorderRef.current?.takeScreenShot(
            `${_pictureName}.png`,
            doTransparentBackgroundRef.current,
            { width: targetW || undefined, highQuality }
        );
        dispatch(setShownControl(null));
        dispatch(setDrawCrosshairs(showCrosshairs));
    };

    return (
        <MoorhenStack direction="column" align="normal" gap="0.5rem">
            <div className="moorhen_snackbar_screenshot-buttons">
                <MoorhenButton
                    onClick={handleScreenShot}
                    onMouseEnter={() => setScreenShotHovered(true)}
                    onMouseLeave={() => setScreenShotHovered(false)}
                    type="icon-only"
                    icon={screenShotHovered ? "MatSymShutter" : "MatSymPhotoCam"}
                    tooltip={"Take screenshot"}
                ></MoorhenButton>

                <MoorhenButton
                    type="icon-only"
                    icon={doTransparentBackground ? "MatSymBackgroudDots" : "MatSymBackgroudNoDots"}
                    onClick={() => {
                        doTransparentBackgroundRef.current = !doTransparentBackgroundRef.current;
                        setDoTransparentBackground(prev => !prev);
                    }}
                    tooltip={doTransparentBackground ? "Use opaque background" : "Use transparent background"}
                />

                <MoorhenButton onClick={() => dispatch(setShownControl(null))} type="icon-only" icon="MatSymClose" tooltip={"Close"} />
            </div>
            <MoorhenStack direction="row" align="center" gap="0.5rem">
                <label htmlFor="moorhen-screenshot-size" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>Size:</label>
                <select
                    id="moorhen-screenshot-size"
                    value={scale}
                    onChange={e => setScale(e.target.value as "1" | "2" | "max")}
                    style={{ fontSize: "0.8rem" }}
                >
                    <option value="1">1× (screen)</option>
                    <option value="2">2×</option>
                    <option value="max">Max (≈4096)</option>
                </select>
                <label style={{ fontSize: "0.8rem", whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}>
                    <input type="checkbox" checked={highQuality} onChange={e => setHighQuality(e.target.checked)} />
                    High quality
                </label>
            </MoorhenStack>
            <MoorhenTextInput label="Name: " text={pictureName} setText={setPictureName} style={{ width: "40%" }} />
        </MoorhenStack>
    );
};
