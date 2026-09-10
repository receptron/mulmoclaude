// USDZ export of a ShapeScript model — the pure part, shared by the
// `exportShapeScriptUsdz` tool (server) and the View's "Download USDZ" button
// (browser). It is browser-safe on purpose: three's `USDZExporter` needs a
// canvas only to bake TEXTURES, and the converter emits untextured
// `MeshStandardMaterial`s with plain colours, so no `document` is touched on
// either side. That is what lets one function serve both hosts and both ends.

import * as THREE from "three";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import { parseShapeScript } from "../shapescript/parser";
import { astToThreeJS, type ConversionOptions } from "../shapescript/toThreeJS";
import { disposeObject3D } from "../shapescript/dispose";

/** The MIME type a `.usdz` is served / downloaded as (Apple's registration). */
export const USDZ_MIME_TYPE = "model/vnd.usdz+zip";

/** The extension a USDZ archive carries. */
export const USDZ_EXTENSION = ".usdz";

/** Serialise an already-built Three.js object tree to a USDZ archive.
 *
 *  `quickLookCompatible` lets Apple's AR Quick Look open the file, which is the
 *  main reason anyone wants USDZ; the flag costs nothing elsewhere. */
export async function sceneToUsdz(object: THREE.Object3D): Promise<Uint8Array<ArrayBuffer>> {
  const exporter = new USDZExporter();
  const buffer = await exporter.parseAsync(object, { quickLookCompatible: true });
  return new Uint8Array(buffer);
}

/** Parse, evaluate and export one ShapeScript source. Geometry is built the
 *  same way `presentShapeScript` validates it (same converter, same limits),
 *  solid rather than wireframe, and released once serialised — the CSG buffers
 *  are the expensive part and nothing keeps them after this. */
export async function shapeScriptToUsdz(script: string, options: Omit<ConversionOptions, "wireframe"> = {}): Promise<Uint8Array<ArrayBuffer>> {
  const group = astToThreeJS(parseShapeScript(script), { ...options, wireframe: false });
  try {
    return await sceneToUsdz(group);
  } finally {
    disposeObject3D(group);
  }
}
