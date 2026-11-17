import { definePluginMeta } from "../meta-types";

export const META = definePluginMeta({
  toolName: "presentBrep",
  apiNamespace: "brep",
  apiRoutes: {
    /** POST /api/brep — build a solid model from a replicad script and present it. */
    create: { method: "POST", path: "" },
  },
  mcpDispatch: "create",
  workspaceDirs: {
    /** Saved scripts with their exports beside them
     *  (`artifacts/brep/<slug>-<ms>-<token>.replicad.js`, `.step`, `.stl`, `.svg`). */
    brep: "artifacts/brep",
  },
});
