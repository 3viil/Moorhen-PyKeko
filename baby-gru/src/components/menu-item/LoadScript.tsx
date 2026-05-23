import { useRef } from "react";
import { useSelector, useStore } from "react-redux";
import { useCommandCentre } from "../../InstanceManager";
import { moorhen } from "../../types/moorhen";
import { MoorhenScriptApi } from "../../utils/MoorhenScriptAPI";
import { MoorhenButton, MoorhenFileInput } from "../inputs";

export const LoadScript = () => {
    const filesRef = useRef<null | HTMLInputElement>(null);
    const molecules = useSelector((state: moorhen.State) => state.molecules.moleculeList);
    const maps = useSelector((state: moorhen.State) => state.maps);
    const store = useStore();
    const commandCentre = useCommandCentre();

    const onCompleted = async () => {
        for (const file of filesRef.current.files) {
            const code = await file.text();
            const isPymol = file.name.toLowerCase().endsWith(".pml");
            try {
                const scriptApi = new MoorhenScriptApi(commandCentre, store as any, molecules, maps);
                if (isPymol) {
                    await scriptApi.exePymol(code);
                } else {
                    scriptApi.exe(code);
                }
            } catch (err) {
                console.error(err);
            }
        }
    };

    return (
        <>
            <MoorhenFileInput label="Load and execute script (.js or .pml)" ref={filesRef} multiple={false} accept=".js,.pml" />
            <MoorhenButton onClick={onCompleted}>OK</MoorhenButton>
        </>
    );
};
