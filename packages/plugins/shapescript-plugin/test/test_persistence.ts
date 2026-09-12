// Coverage for the artifacts persistence added in 1.1.0: the `script` XOR
// `path` tool contract, the `artifacts/shapes/**` path rules, and the View's
// load / save dispatch. Everything goes through the generic gui-chat-protocol
// `FileOps` capability, so an in-memory double is a complete host here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileOps } from "gui-chat-protocol";

import { executePresentShapeScript } from "../src/core/plugin";
import { executeShapeScriptDispatch } from "../src/core/dispatch";
import { isShapeScriptDispatchArgs } from "../src/core/contract";
import { isPresentableShapePath, isShapeArtifactPath, shapeArtifactPath, toArtifactsRelative } from "../src/core/paths";
import { astToThreeJS, DEFAULT_MAX_NODES, DEFAULT_MAX_VERTICES, DEFAULT_MAX_DURATION_MS } from "../src/shapescript/toThreeJS";
import { parseShapeScript } from "../src/shapescript/parser";
import { disposeObject3D } from "../src/shapescript/dispose";

/** In-memory FileOps. Only the four methods the plugin calls are real; the rest
 *  throw, so a future call site that needs them fails loudly in a test rather
 *  than silently reading `undefined`. */
function memoryFiles(seed: Record<string, string> = {}): FileOps & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  const missing = (name: string) => (): never => {
    throw new Error(`FileOps.${name} is not part of this double`);
  };
  return {
    store,
    read: async (rel: string) => {
      const value = store.get(rel);
      if (value === undefined) throw new Error(`ENOENT: ${rel}`);
      return value;
    },
    write: async (rel: string, content: string | Uint8Array) => {
      store.set(rel, typeof content === "string" ? content : new TextDecoder().decode(content));
    },
    exists: async (rel: string) => store.has(rel),
    unlink: async (rel: string) => void store.delete(rel),
    readBytes: missing("readBytes"),
    readDir: missing("readDir"),
    stat: missing("stat"),
  } as FileOps & { store: Map<string, string> };
}

const CUBE = "cube { size 1 }";

describe("shape artifact paths", () => {
  it("mints a flat, slugged, collision-suffixed path under artifacts/shapes", () => {
    const { relPath, filePath } = shapeArtifactPath("A Desk Lamp", new Date(1718765432101), "abcd1234");
    assert.equal(relPath, "shapes/a-desk-lamp-1718765432101-abcd1234.shape");
    assert.equal(filePath, "artifacts/shapes/a-desk-lamp-1718765432101-abcd1234.shape");
    // Flat, not YYYY/MM-partitioned — one directory the user can browse.
    assert.equal(relPath.split("/").length, 2);
  });

  it("falls back to a usable slug when the title contributes nothing", () => {
    const { relPath } = shapeArtifactPath("🙂", new Date(1718765432101), "abcd1234");
    assert.equal(relPath, "shapes/shape-1718765432101-abcd1234.shape");
  });

  // The timestamp alone does not separate two calls inside one millisecond, and
  // `write` overwrites unconditionally — the loser of that race would vanish.
  it("mints different paths for the same title at the same instant", () => {
    const when = new Date(1718765432101);
    const first = shapeArtifactPath("Lamp", when).relPath;
    const second = shapeArtifactPath("Lamp", when).relPath;
    assert.notEqual(first, second);
  });

  // The guard is the primary defence before a FileOps write: `path.join` does
  // not normalise traversal, so anything it lets through reaches disk.
  it("refuses traversal, the wrong extension, and paths outside the artifacts dir", () => {
    assert.equal(isShapeArtifactPath("artifacts/shapes/lamp.shape"), true);
    assert.equal(isShapeArtifactPath("artifacts/shapes/../../secrets.shape"), false);
    // Backslash traversal too: this guard is canonical-looking to a `/` split,
    // but `node:path` on Windows — and FileOps' own normalisation — read those
    // as separators and escape the directory (codex on #3056).
    assert.equal(isShapeArtifactPath("artifacts/shapes/..\\..\\secrets.shape"), false);
    assert.equal(isShapeArtifactPath("artifacts/shapes/..\\documents/x.shape"), false);
    assert.equal(isShapeArtifactPath("artifacts/shapes/lamp.md"), false);
    assert.equal(isShapeArtifactPath("artifacts/documents/lamp.shape"), false);
    assert.equal(isShapeArtifactPath("shapes/lamp.shape"), false);
  });

  it("strips only the artifacts root when converting to a FileOps path", () => {
    assert.equal(toArtifactsRelative("artifacts/shapes/lamp.shape"), "shapes/lamp.shape");
    assert.equal(toArtifactsRelative("models/lamp.shape"), "models/lamp.shape");
  });

  it("accepts any .shape for the `path` argument, artifact or not", () => {
    assert.equal(isPresentableShapePath("models/lamp.shape"), true);
    assert.equal(isPresentableShapePath("models/lamp.txt"), false);
    assert.equal(isPresentableShapePath("models/../lamp.shape"), false);
  });
});

describe("presentShapeScript persistence", () => {
  it("re-mints rather than overwriting when the path is already taken", async () => {
    // The first candidate is occupied, so the save must land somewhere else
    // instead of replacing a model that is already there.
    const artifacts = memoryFiles();
    const taken = new Set<string>();
    const realExists = artifacts.exists.bind(artifacts);
    let probes = 0;
    artifacts.exists = async (rel: string) => {
      probes += 1;
      if (probes === 1) {
        taken.add(rel);
        return true;
      }
      return realExists(rel);
    };
    const result = await executePresentShapeScript({ files: { artifacts } }, { title: "Lamp", script: CUBE });
    assert.ok(result.data?.filePath);
    assert.ok(!taken.has(toArtifactsRelative(result.data.filePath)), "wrote over the occupied path");
    assert.equal(artifacts.store.size, 1);
  });

  it("saves a new script and names the file it wrote", async () => {
    const artifacts = memoryFiles();
    const result = await executePresentShapeScript({ files: { artifacts } }, { title: "Cube", script: CUBE });
    assert.ok(result.data);
    const filePath = result.data.filePath;
    assert.ok(filePath?.startsWith("artifacts/shapes/"), `unexpected path: ${filePath}`);
    assert.equal(artifacts.store.get(toArtifactsRelative(filePath!)), CUBE);
    // The source travels in the result too, so the View renders without a round trip.
    assert.equal(result.data.script, CUBE);
  });

  // A host with no file layer (the pre-1.1 contract, and MulmoTerminal until it
  // ports) must keep working rather than failing on a missing capability.
  it("still returns a renderable result when the host has no file layer", async () => {
    const result = await executePresentShapeScript({}, { title: "Cube", script: CUBE });
    assert.ok(result.data);
    assert.equal(result.data.script, CUBE);
    assert.equal(result.data.filePath, undefined);
  });

  it("presents an existing file in place without rewriting it", async () => {
    const artifacts = memoryFiles({ "shapes/lamp.shape": CUBE });
    const result = await executePresentShapeScript({ files: { artifacts } }, { title: "Lamp", path: "artifacts/shapes/lamp.shape" });
    assert.ok(result.data);
    assert.equal(result.data.script, CUBE);
    assert.equal(result.data.filePath, "artifacts/shapes/lamp.shape");
    // Nothing new was minted — presenting is not saving.
    assert.equal(artifacts.store.size, 1);
  });

  it("reads a non-artifact path through the host's byPath capability", async () => {
    const artifacts = memoryFiles();
    const byPath = memoryFiles({ "models/lamp.shape": CUBE });
    const result = await executePresentShapeScript({ files: { artifacts, byPath } }, { title: "Lamp", path: "models/lamp.shape" });
    assert.ok(result.data);
    assert.equal(result.data.script, CUBE);
  });

  it("refuses a path the host cannot reach instead of inventing an empty model", async () => {
    const artifacts = memoryFiles();
    const result = await executePresentShapeScript({ files: { artifacts } }, { title: "Lamp", path: "models/lamp.shape" });
    assert.equal(result.data, undefined);
    assert.equal(result.error?.code, "INVALID_ARGUMENT");
  });

  it("reports a missing file rather than a parse error", async () => {
    const artifacts = memoryFiles();
    const result = await executePresentShapeScript({ files: { artifacts } }, { title: "Lamp", path: "artifacts/shapes/gone.shape" });
    assert.equal(result.data, undefined);
    assert.match(result.error?.message ?? "", /No ShapeScript exists at/);
  });

  // JSON Schema cannot say "exactly one of these", so the executor is the only
  // thing standing between an ambiguous call and one argument silently winning.
  it("rejects script and path together", async () => {
    const artifacts = memoryFiles({ "shapes/lamp.shape": CUBE });
    const result = await executePresentShapeScript({ files: { artifacts } }, { title: "Lamp", script: CUBE, path: "artifacts/shapes/lamp.shape" });
    assert.equal(result.data, undefined);
    assert.match(result.error?.message ?? "", /not both/);
  });

  it("does not save a script that fails to build", async () => {
    const artifacts = memoryFiles();
    const result = await executePresentShapeScript({ files: { artifacts } }, { title: "Broken", script: "cube { size missing }" });
    assert.equal(result.data, undefined);
    assert.equal(result.error?.code, "EVALUATION_ERROR");
    // The whole point of validating first: no half-written artifact is left behind.
    assert.equal(artifacts.store.size, 0);
  });
});

describe("shapescript dispatch", () => {
  it("round-trips the source the View edits", async () => {
    const artifacts = memoryFiles({ "shapes/lamp.shape": CUBE });
    const context = { files: { artifacts } };
    const loaded = await executeShapeScriptDispatch(context, { kind: "loadShape", path: "artifacts/shapes/lamp.shape" });
    assert.deepEqual(loaded, { script: CUBE });

    const next = "sphere { size 2 }";
    const saved = await executeShapeScriptDispatch(context, { kind: "saveShape", path: "artifacts/shapes/lamp.shape", script: next });
    assert.deepEqual(saved, { path: "artifacts/shapes/lamp.shape" });
    assert.equal(artifacts.store.get("shapes/lamp.shape"), next);
  });

  // `FileOps.write` creates what is missing, so without the existence check the
  // View's save channel could mint `.shape` files at caller-chosen paths — a
  // wider capability than editing the model on screen.
  it("refuses to create a file that does not exist", async () => {
    const artifacts = memoryFiles();
    await assert.rejects(
      () => executeShapeScriptDispatch({ files: { artifacts } }, { kind: "saveShape", path: "artifacts/shapes/new.shape", script: CUBE }),
      /No ShapeScript exists at/,
    );
    assert.equal(artifacts.store.size, 0);
  });

  it("refuses a traversal path before touching FileOps", async () => {
    const artifacts = memoryFiles();
    await assert.rejects(
      () => executeShapeScriptDispatch({ files: { artifacts } }, { kind: "saveShape", path: "artifacts/shapes/../x.shape", script: CUBE }),
      /must be an existing .shape file/,
    );
    assert.equal(artifacts.store.size, 0);
  });

  // Without the `script` check, `undefined` reaches `write` and blanks the file.
  it("rejects a save payload with no script", () => {
    assert.equal(isShapeScriptDispatchArgs({ kind: "saveShape", path: "artifacts/shapes/a.shape" }), false);
    assert.equal(isShapeScriptDispatchArgs({ kind: "saveShape", path: "artifacts/shapes/a.shape", script: "" }), true);
    assert.equal(isShapeScriptDispatchArgs({ kind: "loadShape", path: "artifacts/shapes/a.shape" }), true);
    assert.equal(isShapeScriptDispatchArgs({ kind: "nope", path: "a.shape" }), false);
    assert.equal(isShapeScriptDispatchArgs(null), false);
  });
});

describe("conversion budgets", () => {
  // The three ceilings have to agree about how big a model may be. They did
  // not: measured, a grid-shaped model was refused for object count at ~540k
  // vertices — a quarter of the vertex budget — so `maxNodes` decided the
  // answer for one shape of model and `maxVertices` for another.
  it("lets the vertex budget, not the object count, bound a grid-shaped model", () => {
    // 150x150 cubes: 22,500 objects, ~540k vertices. Inside every ceiling now.
    const group = astToThreeJS(parseShapeScript("for x in -75 to 74 {\n for z in -75 to 74 {\n  cube {\n   position x 0 z\n   size 0.8\n  }\n }\n}"));
    let vertices = 0;
    group.traverse((object) => {
      const geometry = (object as { geometry?: { attributes?: { position?: { count: number } } } }).geometry;
      vertices += geometry?.attributes?.position?.count ?? 0;
    });
    assert.ok(vertices > 500_000, `expected a heavy grid, got ${vertices} vertices`);
    assert.ok(vertices < DEFAULT_MAX_VERTICES);
    disposeObject3D(group);
  });

  // A tree is a cylinder wrapped in about ten statements — transform, colour,
  // `if`, `for`, `group`, the recursive call — so charging every statement
  // refused a 10k-cylinder tree at ~0.5M vertices, a tenth of the vertex
  // budget. Only objects count now.
  it("charges the object budget per object, not per statement", () => {
    const tree = (depth: number) =>
      "detail 8\ndefine branch {\n option depth 1\n cylinder {\n  size 0.1 1 0.1\n  position 0 0.5 0\n }\n if depth > 0 {\n  translate 0 1 0\n  for i in 1 to 3 {\n   rotate 0 i/3 0\n   group {\n    rotate 0.15 0 0\n    scale 0.7\n    color 0.4 0.3 0.2\n    branch { depth depth - 1 }\n   }\n  }\n }\n}\nbranch { depth " +
      depth +
      " }";
    // Depth 3 is 40 cylinders. A budget of 40 admits it and 39 refuses it, so
    // the count is exactly the cylinders and nothing else.
    disposeObject3D(astToThreeJS(parseShapeScript(tree(3)), { maxNodes: 40 }));
    assert.throws(() => astToThreeJS(parseShapeScript(tree(3)), { maxNodes: 39 }), /more than 39 objects/);
    // Depth 8: 9,841 cylinders, ~512k vertices. Inside every ceiling now.
    const group = astToThreeJS(parseShapeScript(tree(8)));
    let meshes = 0;
    group.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh) meshes += 1;
    });
    assert.equal(meshes, 9841);
    disposeObject3D(group);
  });

  it("charges a defined shape value each time it is placed by name", () => {
    // `ico` is a `customShape` node placing a value, not a `shape` statement:
    // it has to cost the same as writing the icosphere out each time. The
    // `define` builds the icosphere once too, so five placements cost six.
    const script = "define ico icosphere { size 1 }\nfor i in 1 to 5 {\n ico { position i 0 0 }\n}";
    disposeObject3D(astToThreeJS(parseShapeScript(script), { maxNodes: 6 }));
    assert.throws(() => astToThreeJS(parseShapeScript(script), { maxNodes: 5 }), /more than 5 objects/);
    // A `polygon { point … }` is a `shape` node that is placed as a value:
    // charged once, not twice.
    const polygons = "for i in 1 to 3 {\n polygon {\n  point 0 0 0\n  point 1 0 0\n  point 0 1 0\n }\n}";
    disposeObject3D(astToThreeJS(parseShapeScript(polygons), { maxNodes: 3 }));
    assert.throws(() => astToThreeJS(parseShapeScript(polygons), { maxNodes: 2 }), /more than 2 objects/);
    // A `mesh { }` block collects its children into one object, but each child
    // allocates geometry until the merge, so each is charged.
    assert.throws(() => astToThreeJS(parseShapeScript("mesh {\n cube\n cube\n}"), { maxNodes: 2 }), /more than 2 objects/);
  });

  // Pinned rather than asserted loosely: these are the numbers a script author
  // and the tool's error messages both reason about, so a change to them should
  // be a decision, not a side effect.
  it("keeps the documented ceilings", () => {
    assert.equal(DEFAULT_MAX_NODES, 100_000);
    assert.equal(DEFAULT_MAX_VERTICES, 5_000_000);
    assert.equal(DEFAULT_MAX_DURATION_MS, 30_000);
  });
});
