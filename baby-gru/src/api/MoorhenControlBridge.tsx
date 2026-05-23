// @ts-nocheck
// MoorhenControlBridge — mounted inside MoorhenContainer so it can read the live
// instance via hooks. It builds the MoorhenControlApi, exposes it on window
// (handy for CDP/dev), and — when the Electron wrapper injected a control channel
// (window.__moorhenControl, from preload.js) — forwards invoke messages to it.
import { useEffect } from "react";
import { useStore, useDispatch } from "react-redux";
import { useCommandCentre, usePaths } from "../InstanceManager/hooks";
import { useMoorhenInstance } from "../InstanceManager/useMoorhenInstance";
import { createControlApi } from "./MoorhenControlApi";

export const MoorhenControlBridge = () => {
  const commandCentre = useCommandCentre();
  const store = useStore();
  const dispatch = useDispatch();
  const paths = usePaths();
  const instance = useMoorhenInstance();

  useEffect(() => {
    const api = createControlApi({
      commandCentre,
      store,
      dispatch,
      monomerLibraryPath: paths?.monomerLibraryPath || "./monomers",
      videoRecorderRef: instance?.getVideoRecorderRef?.() ?? null,
    });
    (window as any).MoorhenControlApi = api;

    // Wire the Electron wrapper transport if present (preload exposes __moorhenControl)
    let off: (() => void) | undefined;
    const ctrl = (window as any).__moorhenControl;
    if (ctrl && typeof ctrl.onInvoke === "function") {
      off = ctrl.onInvoke(async (msg: any) => {
        const { id, verb, args } = msg || {};
        try {
          const fn = (api as any)[verb];
          if (typeof fn !== "function") throw new Error("unknown control verb: " + verb);
          const result = await fn.apply(api, Array.isArray(args) ? args : []);
          ctrl.sendResult({ id, ok: true, result });
        } catch (e: any) {
          ctrl.sendResult({ id, ok: false, error: String(e?.message || e) });
        }
      });
      try { ctrl.ready && ctrl.ready(Object.keys(api)); } catch (e) {}
    }
    console.debug("[MoorhenControlBridge] ready; verbs:", Object.keys(api), "transport:", !!ctrl);

    return () => {
      if (typeof off === "function") off();
      if ((window as any).MoorhenControlApi === api) (window as any).MoorhenControlApi = undefined;
    };
  }, [commandCentre, store, dispatch, paths]);

  return null;
};
