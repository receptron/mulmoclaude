import { definePluginMeta } from "../meta-types";

export const META = definePluginMeta({
  toolName: "presentShapeScript",
  apiNamespace: "shapescript",
  apiRoutes: {
    /** POST /api/shapescript — validate a ShapeScript source and present it. */
    create: { method: "POST", path: "" },
  },
  mcpDispatch: "create",
});
