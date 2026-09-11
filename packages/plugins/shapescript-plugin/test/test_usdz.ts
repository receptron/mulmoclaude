// Coverage for the USDZ export added in 1.4.0: the pure serialiser the View's
// download button uses, and the `exportShapeScriptUsdz` tool, which reaches
// storage only through the generic gui-chat-protocol `files` capability — so
// an in-memory double is a complete host here, as in test_persistence.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileOps } from "gui-chat-protocol";

import * as THREE from "three";
import { sceneToUsdz, shapeScriptToUsdz, USDZ_MIME_TYPE } from "../src/export/usdz";
import { parseShapeScript } from "../src/shapescript/parser";
import { astToThreeJS } from "../src/shapescript/toThreeJS";
import { disposeObject3D } from "../src/shapescript/dispose";
import { executeExportShapeScriptUsdz, EXPORT_USDZ_SCHEMA, EXPORT_USDZ_TOOL_NAME, EXPORT_USDZ_TOOL_TIMEOUT_MS } from "../src/export/tool";
import { usdzArtifactPath } from "../src/core/paths";
import { DEFAULT_MAX_DURATION_MS } from "../src/shapescript/toThreeJS";

const CUBE = "cube { size 1 }";
const CSG = "difference {\n sphere {\n  size 2\n }\n cylinder {\n  size 1 3 1\n }\n}";

/** In-memory FileOps that keeps bytes as bytes — a `.usdz` is binary and a
 *  double that decoded it to text would hide a corrupted write. */
function memoryFiles(seed: Record<string, string> = {}): FileOps & { store: Map<string, Uint8Array<ArrayBufferLike>> } {
  const encoder = new TextEncoder();
  const store = new Map<string, Uint8Array<ArrayBufferLike>>(Object.entries(seed).map(([key, value]) => [key, encoder.encode(value)]));
  const missing = (name: string) => (): never => {
    throw new Error(`FileOps.${name} is not part of this double`);
  };
  return {
    store,
    read: async (rel: string) => {
      const value = store.get(rel);
      if (value === undefined) throw new Error(`ENOENT: ${rel}`);
      return new TextDecoder().decode(value);
    },
    write: async (rel: string, content: string | Uint8Array) => {
      store.set(rel, typeof content === "string" ? encoder.encode(content) : content);
    },
    exists: async (rel: string) => store.has(rel),
    unlink: async (rel: string) => void store.delete(rel),
    readBytes: missing("readBytes"),
    readDir: missing("readDir"),
    stat: missing("stat"),
  } as FileOps & { store: Map<string, Uint8Array<ArrayBufferLike>> };
}

/** The entries of a stored (uncompressed) zip — enough to see the archive's
 *  shape without a zip reader: every local header carries its filename and
 *  size, and USDZ forbids compression, so the data follows the header. */
function zipEntries(bytes: Uint8Array): { name: string; text: string }[] {
  const entries: { name: string; text: string }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 18, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)),
      text: decoder.decode(bytes.subarray(dataStart, dataStart + size)),
    });
    offset = dataStart + size;
  }
  return entries;
}

const zipEntryNames = (bytes: Uint8Array): string[] => zipEntries(bytes).map((entry) => entry.name);

describe("shapeScriptToUsdz", () => {
  it("serialises a model to a zip archive holding the USD stage", async () => {
    const bytes = await shapeScriptToUsdz(CUBE);
    assert.ok(bytes.byteLength > 0);
    const names = zipEntryNames(bytes);
    assert.equal(names[0], "model.usda");
    assert.ok(
      names.some((name) => name.startsWith("geometries/")),
      `no geometry entry in ${names.join(", ")}`,
    );
  });

  // A CSG result carries one material per operand, and the exporter inlines a
  // multi-material mesh into the stage instead of a geometries/ entry — either
  // way the stage must actually reference mesh data.
  it("exports a CSG result as mesh geometry in the stage", async () => {
    const [stage] = zipEntries(await shapeScriptToUsdz(CSG));
    assert.equal(stage?.name, "model.usda");
    assert.match(stage!.text, /def Mesh/);
  });

  it("reports ShapeScript errors rather than writing a broken file", async () => {
    await assert.rejects(shapeScriptToUsdz("cube {"), /RBRACE/);
  });
  it("gives vertex-coloured faces plain materials, which USD viewers shade with", async () => {
    // Coloured polygons carry vertex colours on a white material; the
    // exporter's `displayColor` is ignored by Quick Look, so each colour
    // becomes its own mesh and material.
    const script =
      "mesh {\n polygon {\n  color 1 0 0\n  point 0 0 0\n  point 1 0 0\n  point 0 1 0\n }\n polygon {\n  color 0 0 1\n  point 0 0 0\n  point 0 0 1\n  point 1 0 0\n }\n polygon {\n  color 1 0 0\n  point 0 0 0\n  point 0 1 0\n  point 0 0 1\n }\n}";
    const [stage] = zipEntries(await shapeScriptToUsdz(script));
    const diffuse = [...(stage?.text.matchAll(/diffuseColor = \(([^)]*)\)/g) ?? [])].map((m) => m[1]);
    assert.deepEqual(diffuse.sort(), ["0, 0, 1", "1, 0, 0"]);
    assert.equal((stage?.text.match(/def Material /g) ?? []).length, 2);
    // A plain-coloured shape is unchanged: one mesh, its own colour.
    const [cube] = zipEntries(await shapeScriptToUsdz("cube {\n color 0 1 0\n}"));
    assert.equal((cube?.text.match(/def Material /g) ?? []).length, 1);
    assert.match(cube?.text ?? "", /diffuseColor = \(0, 1, 0\)/);
    // A face whose vertices differ in colour (a geometry from elsewhere; a
    // polygon block gives all its points one colour) gets their mean.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
    const mixed = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true }));
    const [blend] = zipEntries(await sceneToUsdz(mixed));
    mixed.geometry.dispose();
    (mixed.material as THREE.Material).dispose();
    assert.equal((blend?.text.match(/def Material /g) ?? []).length, 1);
    const [r, g, b] = (/diffuseColor = \(([^)]*)\)/.exec(blend?.text ?? "")?.[1] ?? "").split(", ").map(Number);
    assert.ok(
      [r, g, b].every((c) => Math.abs((c ?? 0) - 1 / 3) < 1e-6),
      `blend ${r} ${g} ${b}`,
    );
    // A child of a vertex-coloured mesh is kept.
    const parent = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial({ vertexColors: true }));
    parent.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x00ff00 })));
    const [withChild] = zipEntries(await sceneToUsdz(parent));
    assert.equal((withChild?.text.match(/def Material /g) ?? []).length, 2);
    disposeObject3D(parent);
    // A hidden mesh stays hidden.
    const group = astToThreeJS(parseShapeScript("mesh {\n polygon {\n  color 1 0 0\n  point 0 0 0\n  point 1 0 0\n  point 0 1 0\n }\n}"));
    group.traverse((object) => void (object !== group && (object.visible = false)));
    const [hidden] = zipEntries(await sceneToUsdz(group));
    assert.equal((hidden?.text.match(/def Material /g) ?? []).length, 0);
    disposeObject3D(group);
  });

  it("names the MIME type AR Quick Look expects", () => {
    assert.equal(USDZ_MIME_TYPE, "model/vnd.usdz+zip");
  });
});

describe("usdzArtifactPath", () => {
  it("lands beside the .shape sources with the same collision rule", () => {
    const { relPath, filePath } = usdzArtifactPath("A Desk Lamp", new Date(1718765432101), "abcd1234");
    assert.equal(relPath, "shapes/a-desk-lamp-1718765432101-abcd1234.usdz");
    assert.equal(filePath, "artifacts/shapes/a-desk-lamp-1718765432101-abcd1234.usdz");
  });
});

describe("exportShapeScriptUsdz tool", () => {
  it("exposes its name on the constant and takes script XOR path", () => {
    assert.equal(EXPORT_USDZ_TOOL_NAME, "exportShapeScriptUsdz");
    assert.deepEqual(Object.keys(EXPORT_USDZ_SCHEMA.properties), ["script", "path", "title"]);
  });

  // The conversion may use its whole budget and the serialisation runs after
  // it, so a host transport sized to the conversion alone aborts a valid export.
  it("asks the host for more transport time than the conversion budget alone", () => {
    assert.ok(EXPORT_USDZ_TOOL_TIMEOUT_MS > DEFAULT_MAX_DURATION_MS);
  });

  it("writes an inline script's export under artifacts/shapes and names it", async () => {
    const artifacts = memoryFiles();
    const result = await executeExportShapeScriptUsdz({ files: { artifacts } }, { script: CUBE, title: "Tiny Cube" });
    assert.match(result.filePath, /^artifacts\/shapes\/tiny-cube-\d+-[0-9a-f]{8}\.usdz$/);
    assert.match(result.message, new RegExp(`Saved USDZ to ${result.filePath}`));
    const stored = artifacts.store.get(result.filePath.replace(/^artifacts\//, ""));
    assert.ok(stored, "nothing written");
    assert.equal(stored.byteLength, result.bytes);
    assert.equal(zipEntryNames(stored)[0], "model.usda");
  });

  it("exports an existing artifact and inherits its name", async () => {
    const artifacts = memoryFiles({ "shapes/lamp-1-aaaaaaaa.shape": CUBE });
    const result = await executeExportShapeScriptUsdz({ files: { artifacts } }, { path: "artifacts/shapes/lamp-1-aaaaaaaa.shape" });
    assert.match(result.filePath, /^artifacts\/shapes\/lamp-1-aaaaaaaa-\d+-[0-9a-f]{8}\.usdz$/);
  });

  it("reads a source outside artifacts/ through files.byPath", async () => {
    const artifacts = memoryFiles();
    const byPath = memoryFiles({ "models/lamp.shape": CUBE });
    const result = await executeExportShapeScriptUsdz({ files: { artifacts, byPath } }, { path: "models/lamp.shape" });
    assert.match(result.filePath, /^artifacts\/shapes\/lamp-\d+-[0-9a-f]{8}\.usdz$/);
    assert.equal(artifacts.store.size, 1);
  });

  it("refuses both, neither, a traversal path and a missing file", async () => {
    const artifacts = memoryFiles();
    const context = { files: { artifacts } };
    await assert.rejects(executeExportShapeScriptUsdz(context, { script: CUBE, path: "artifacts/shapes/x.shape" }), /not both/);
    await assert.rejects(executeExportShapeScriptUsdz(context, {}), /either `script`/);
    await assert.rejects(executeExportShapeScriptUsdz(context, { path: "artifacts/shapes/../secret.shape" }), /must name a \.shape/);
    await assert.rejects(executeExportShapeScriptUsdz(context, { path: "artifacts/shapes/missing.shape" }), /No ShapeScript exists/);
    assert.equal(artifacts.store.size, 0);
  });
});
