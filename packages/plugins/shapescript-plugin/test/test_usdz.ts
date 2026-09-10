// Coverage for the USDZ export added in 1.4.0: the pure serialiser the View's
// download button uses, and the `exportShapeScriptUsdz` tool, which reaches
// storage only through the generic gui-chat-protocol `files` capability — so
// an in-memory double is a complete host here, as in test_persistence.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileOps } from "gui-chat-protocol";

import { shapeScriptToUsdz, USDZ_MIME_TYPE } from "../src/export/usdz";
import { executeExportShapeScriptUsdz, EXPORT_USDZ_SCHEMA, EXPORT_USDZ_TOOL_NAME, EXPORT_USDZ_TOOL_TIMEOUT_MS } from "../src/export/tool";
import { usdzArtifactPath } from "../src/core/paths";
import { DEFAULT_MAX_DURATION_MS } from "../src/shapescript/toThreeJS";

const CUBE = "cube { size 1 }";
const CSG = "difference { sphere { size 2 } cylinder { size 1 3 1 } }";

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
