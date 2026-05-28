import { PlayArrowOutlined } from "@mui/icons-material";
import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/themes/prism-okaidia.css";
import { useSelector, useStore } from "react-redux";
import Editor from "react-simple-code-editor";
import { useCallback, useState } from "react";
import { useCommandCentre } from "../../InstanceManager";
import { moorhen } from "../../types/moorhen";
import { MoorhenScriptApi } from "../../utils/MoorhenScriptAPI";
import { modalKeys } from "../../utils/enums";
import { convertRemToPx, convertViewtoPx } from "../../utils/utils";
import { MoorhenButton, MoorhenSelect } from "../inputs";
import { MoorhenDraggableModalBase } from "../interface-base/ModalBase/DraggableModalBase";

type ScriptMode = "javascript" | "pymol";

const MODE_STORAGE_KEY = "moorhen.scripting.mode";

const loadInitialMode = (): ScriptMode => {
    // PyKeko default: PyMOL (crystallographers' lingua franca; the JS mode is opt-in).
    try {
        const v = localStorage.getItem(MODE_STORAGE_KEY);
        return v === "javascript" ? "javascript" : "pymol";
    } catch {
        return "pymol";
    }
};

export const MoorhenScriptModal = () => {
    const [code, setCode] = useState<string>("");
    const [mode, setMode] = useState<ScriptMode>(loadInitialMode);

    const width = useSelector((state: moorhen.State) => state.sceneSettings.width);
    const height = useSelector((state: moorhen.State) => state.sceneSettings.height);
    const molecules = useSelector((state: moorhen.State) => state.molecules.moleculeList);
    const maps = useSelector((state: moorhen.State) => state.maps);
    const store = useStore();
    const commandCentre = useCommandCentre();

    const handleModeChange = (evt: React.ChangeEvent<HTMLSelectElement>) => {
        const newMode = evt.target.value as ScriptMode;
        setMode(newMode);
        try { localStorage.setItem(MODE_STORAGE_KEY, newMode); } catch {}
    };

    const handleScriptExe = useCallback(async () => {
        try {
            const scriptApi = new MoorhenScriptApi(commandCentre, store as any, molecules, maps);
            if (mode === "pymol") {
                await scriptApi.exePymol(code);
            } else {
                await scriptApi.exe(code);
            }
        } catch (err) {
            console.error(err);
        }
    }, [code, mode, maps, molecules, store, commandCentre]);

    const highlight = useCallback((src: string) => {
        // Use Prism's JS highlighter for both modes. A PyMOL-specific tokenizer
        // is planned for a later phase; for now the editor stays readable.
        return Prism.highlight(src, Prism.languages.javascript, "javascript");
    }, []);

    return (
        <MoorhenDraggableModalBase
            modalId={modalKeys.SCRIPTING}
            left={width / 5}
            top={height / 6}
            headerTitle={`Interactive scripting (${mode === "pymol" ? "PyMOL" : "JavaScript"})`}
            minHeight={convertViewtoPx(10, height)}
            minWidth={convertRemToPx(37)}
            maxHeight={convertViewtoPx(60, height)}
            maxWidth={convertRemToPx(55)}
            body={
                <div style={{ width: "100%" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.25rem 0.5rem" }}>
                        <span style={{ fontSize: "0.9rem" }}>Language</span>
                        <MoorhenSelect value={mode} onChange={handleModeChange} style={{ minWidth: "10rem" }}>
                            <option value="javascript">JavaScript</option>
                            <option value="pymol">PyMOL</option>
                        </MoorhenSelect>
                    </div>
                    <div
                        style={{
                            display: "flex",
                            maxHeight: convertViewtoPx(60, height),
                            minHeight: convertViewtoPx(10, height),
                            overflowY: "auto",
                            backgroundColor: "#272822",
                            border: "1px solid #444",
                        }}
                    >
                        <div style={{ height: "100%", width: "100%" }}>
                            <Editor
                                value={code}
                                onValueChange={setCode}
                                highlight={highlight}
                                padding={10}
                                textareaClassName="moorhen-script-editor"
                                style={{
                                    fontFamily: '"Fira code", "Fira Mono", monospace',
                                    fontSize: 16,
                                    color: "#f8f8f2",
                                    caretColor: "#f8f8f2",
                                }}
                            />
                        </div>
                    </div>
                </div>
            }
            footer={
                <MoorhenButton variant="primary" onClick={handleScriptExe}>
                    <PlayArrowOutlined />
                </MoorhenButton>
            }
        />
    );
};
