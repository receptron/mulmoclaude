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
  const { root, dispose } = withPlainColours(object);
  try {
    const exporter = new USDZExporter();
    const buffer = await exporter.parseAsync(root, { quickLookCompatible: true });
    return new Uint8Array(buffer);
  } finally {
    dispose();
  }
}

/** Colour precision when grouping faces: three decimals tell colours apart
 *  without splitting one colour over float noise. */
const COLOUR_KEY_SCALE = 1000;

/** A copy of the tree in which every vertex-coloured mesh — a `mesh { }` of
 *  coloured polygons, a `minkowski` result — is split into one mesh per
 *  colour with that colour on a plain material. The exporter writes vertex
 *  colours as `displayColor`, but Quick Look and most USD viewers shade with
 *  the material's `diffuseColor`, which is white under vertex colours, so a
 *  coloured model came out white. Geometries and materials created here are
 *  released by `dispose`; the originals are shared and untouched. */
function withPlainColours(object: THREE.Object3D): { root: THREE.Object3D; dispose: () => void } {
  const root = object.clone();
  const created: { dispose(): void }[] = [];
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry.hasAttribute("color") && (mesh.material as THREE.Material & { vertexColors?: boolean }).vertexColors) meshes.push(mesh);
  });
  for (const mesh of meshes) {
    const replacement = new THREE.Group();
    replacement.name = mesh.name;
    replacement.position.copy(mesh.position);
    replacement.quaternion.copy(mesh.quaternion);
    replacement.scale.copy(mesh.scale);
    for (const part of splitByColour(mesh)) {
      created.push(part.geometry, part.material as THREE.Material);
      replacement.add(part);
    }
    mesh.parent?.add(replacement);
    mesh.parent?.remove(mesh);
  }
  return { root, dispose: () => created.forEach((item) => item.dispose()) };
}

/** One mesh per distinct vertex colour, each face going with its first
 *  vertex's colour (a polygon's vertices share one colour). */
function splitByColour(mesh: THREE.Mesh): THREE.Mesh[] {
  const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const colours = source.getAttribute("color");
  const groups = new Map<string, number[]>();
  for (let face = 0; face * 3 < colours.count; face++) {
    const key = [colours.getX(face * 3), colours.getY(face * 3), colours.getZ(face * 3)].map((c) => Math.round(c * COLOUR_KEY_SCALE)).join(",");
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(face);
  }
  const base = mesh.material as THREE.MeshStandardMaterial;
  const parts = [...groups.values()].map((faces) => {
    const geometry = facesOf(source, faces);
    const material = base.clone();
    material.vertexColors = false;
    material.color.copy(base.color).multiply(new THREE.Color(colours.getX(faces[0]! * 3), colours.getY(faces[0]! * 3), colours.getZ(faces[0]! * 3)));
    return new THREE.Mesh(geometry, material);
  });
  if (source !== mesh.geometry) source.dispose();
  return parts;
}

/** The listed faces of a non-indexed geometry, every attribute but colour. */
function facesOf(source: THREE.BufferGeometry, faces: readonly number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (name === "color") continue;
    const size = attribute.itemSize;
    const array = new Float32Array(faces.length * 3 * size);
    faces.forEach((face, i) => {
      for (let v = 0; v < 3; v++) for (let k = 0; k < size; k++) array[(i * 3 + v) * size + k] = attribute.getComponent(face * 3 + v, k);
    });
    geometry.setAttribute(name, new THREE.Float32BufferAttribute(array, size));
  }
  return geometry;
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
