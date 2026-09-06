// Smoke coverage for the ported ShapeScript plugin: the tool's execute path,
// the parser, and the Three.js conversion. The renderer runs headless here —
// `astToThreeJS` builds geometry objects without touching a WebGL context.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TOOL_NAME, TOOL_DEFINITION, executePresentShapeScript } from "../src/core/index";
import { parseShapeScript } from "../src/shapescript/parser";
import { astToThreeJS, ShapeScriptLimitError } from "../src/shapescript/toThreeJS";
import { disposeScratch } from "../src/shapescript/dispose";
import * as THREE from "three";

const context = {} as Parameters<typeof executePresentShapeScript>[0];

describe("presentShapeScript tool", () => {
  it("exposes the renamed tool name on both the constant and the definition", () => {
    assert.equal(TOOL_NAME, "presentShapeScript");
    assert.equal(TOOL_DEFINITION.name, "presentShapeScript");
  });

  // `data` is the host's render-eligibility signal: MulmoClaude's MCP bridge
  // pushes a tool result into the session — the event the canvas renders the
  // View from — ONLY when the handler set it. Dropping it would leave the LLM
  // reporting success while the user sees no 3D view, with nothing logged.
  it("returns the script as tool data, which is what makes the View render", async () => {
    const script = "cube { size 1 }";
    const result = await executePresentShapeScript(context, { title: "Cube", script });
    assert.equal(result.title, "Cube");
    assert.notEqual(result.data, undefined);
    assert.equal(result.data.script, script);
  });

  it("carries data for every shape of script, including CSG and loops", async () => {
    const scripts = ["cube { size 1 }", "difference {\n  sphere { size 2 }\n  sphere { size 1.7 }\n}", "for i in 1 to 4 {\n  cube { position (i * 2) 0 0 }\n}"];
    for (const script of scripts) {
      const result = await executePresentShapeScript(context, { title: "T", script });
      assert.notEqual(result.data, undefined, `no data for: ${script}`);
      assert.equal(result.data.script, script);
    }
  });

  it("rejects an empty script", async () => {
    await assert.rejects(() => executePresentShapeScript(context, { title: "Empty", script: "   " }), /ShapeScript code is required/);
  });
});

describe("ShapeScript pipeline", () => {
  it("parses primitives with properties", () => {
    const nodes = parseShapeScript("cube { position 1 2 3 size 0.5 color (1 0 0) }");
    assert.equal(nodes.length, 1);
    const node = nodes[0];
    assert.equal(node?.type, "shape");
    assert.equal(node?.type === "shape" ? node.primitive : undefined, "cube");
  });

  it("unrolls a for loop into one node per iteration", () => {
    const group = astToThreeJS(parseShapeScript("for i in 1 to 4 {\n  cube { position (i * 2) 0 0 size 1 }\n}"));
    const meshes: string[] = [];
    group.traverse((object) => {
      if (object.type === "Mesh") meshes.push(object.type);
    });
    assert.equal(meshes.length, 4);
  });

  it("evaluates built-in functions inside expressions", () => {
    const nodes = parseShapeScript("define angle 0\ncube { position (cos(angle) * 3) 0 (sin(angle) * 3) }");
    assert.doesNotThrow(() => astToThreeJS(nodes));
  });

  it("builds a CSG difference", () => {
    const group = astToThreeJS(parseShapeScript("difference {\n  sphere { size 2 }\n  sphere { size 1.7 }\n}"));
    assert.ok(group.children.length > 0);
  });
});

// Review findings on #3052. Each of these parsed or ran WRONG before the fix,
// which is why they are asserted rather than left to the smoke cases above.
describe("ShapeScript robustness", () => {
  it("parses the unbraced switch form the tool definition advertises", () => {
    // Newlines used to be stripped before parsing, so `parseSwitch` never saw
    // the case boundary and swallowed each body as another case value until
    // "Expected RBRACE but got EOF".
    const nodes = parseShapeScript("define shape 2\nswitch shape {\ncase 1\n    cube\ncase 2\n    sphere\nelse\n    cone\n}");
    const sw = nodes.find((node) => node.type === "switch");
    assert.equal(sw?.type, "switch");
    assert.equal(sw?.type === "switch" ? sw.cases.length : 0, 2);
  });

  it("still parses an option-bearing custom shape definition", () => {
    // The other side of the newline change: `define <name> { option … }` bodies
    // are line-separated too.
    const nodes = parseShapeScript("define spiral {\n    option coils 3\n    option radius 0.5\n    cube { size radius }\n}\nspiral");
    assert.equal(nodes[0]?.type, "define");
  });

  it("refuses a runaway loop instead of exhausting memory", () => {
    assert.throws(() => astToThreeJS(parseShapeScript("for i in 1 to 100000000 {\n  cube { position i 0 0 }\n}")), ShapeScriptLimitError);
  });

  it("refuses a script that produces more objects than the budget", () => {
    assert.throws(
      () => astToThreeJS(parseShapeScript("for i in 1 to 100 {\n  for j in 1 to 100 {\n    cube { position i j 0 }\n  }\n}"), { maxNodes: 500 }),
      ShapeScriptLimitError,
    );
  });

  it("does not swallow a budget refusal inside a CSG block", () => {
    // `convertCSG` catches failures and falls back to a plain group — which
    // would rebuild exactly the runaway the budget just refused.
    assert.throws(
      () => astToThreeJS(parseShapeScript("difference {\n  for i in 1 to 100 {\n    cube { position i 0 0 }\n  }\n  sphere { size 1 }\n}"), { maxNodes: 20 }),
      ShapeScriptLimitError,
    );
  });

  it("reports an unterminated string instead of swallowing the rest of the file", () => {
    assert.throws(() => parseShapeScript('cube { name "unclosed\ncube { size 1 }'), /Unterminated string/);
  });

  it("refuses an inherited name rather than resolving it off Object.prototype", () => {
    // The built-ins live in an object literal, so `constructor` / `toString`
    // used to pass the truthiness check and return a value that quietly
    // coerced to `false` (or to a grey material) instead of raising. Either
    // refusal message is fine — what matters is that it refuses.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      assert.throws(
        () => astToThreeJS(parseShapeScript(`define x ${name}(1)\ncube { size x }`)),
        /Unknown function|Undefined variable/,
        `${name} was accepted`,
      );
    }
  });

  it("applies a scope-level color command to a shape that has none of its own", () => {
    const group = astToThreeJS(parseShapeScript("color 1 0 0\ncube { size 1 }"));
    const colors: string[] = [];
    group.traverse((object) => {
      const material = (object as { material?: { color?: { getHexString(): string } } }).material;
      if (material?.color) colors.push(material.color.getHexString());
    });
    assert.ok(colors.includes("ff0000"), `expected a red material, got ${colors.join(", ") || "none"}`);
  });

  it("applies a scope-level color command to a CSG model too", () => {
    // Entering a CSG block reset the block's colour along with its matrix. A
    // colour is not a coordinate, so `color 1 0 0` reached a plain `cube` but
    // not a `difference` beside it.
    const group = astToThreeJS(parseShapeScript("color 1 0 0\ndifference {\n  sphere { size 2 }\n  sphere { size 1.7 }\n}"));
    const colors: string[] = [];
    group.traverse((object) => {
      // A CSG result can carry an ARRAY of materials, one per operand.
      const { material } = object as { material?: unknown };
      for (const entry of Array.isArray(material) ? material : [material]) {
        const color = (entry as { color?: { getHexString(): string } } | undefined)?.color;
        if (color) colors.push(color.getHexString());
      }
    });
    assert.ok(colors.includes("ff0000"), `expected a red CSG result, got ${colors.join(", ") || "none"}`);
  });

  it("bounds a `for` inside a path, which never reaches the node budget", () => {
    // Path commands are expanded by `buildPath` / `convertLathe`, not by
    // `convertNode`, so `maxNodes` cannot see them — only the iteration cap can.
    assert.throws(
      () => astToThreeJS(parseShapeScript("extrude {\n  path {\n    for i in 1 to 10 {\n      point i 0\n    }\n  }\n}"), { maxLoopIterations: 3 }),
      ShapeScriptLimitError,
    );
  });

  it("bounds the `for … in values` form with the same iteration budget", () => {
    // The cap used to live only in the range expansion, and the node budget
    // counts what the BODY builds — so an empty body ran the whole list free.
    assert.throws(() => astToThreeJS(parseShapeScript("for i in (1 2 3 4) {\n}"), { maxLoopIterations: 2 }), ShapeScriptLimitError);
  });
});

// The CSG operands never enter the scene, so scene teardown cannot reclaim
// them — but `clone()` shares geometry and material with its source, and a
// one-operand CSG hands the operand back AS the result. Freeing by identity
// would therefore free what the survivor still draws with.
describe("disposeScratch", () => {
  function spyDispose(target: { dispose: () => void }): () => number {
    let calls = 0;
    target.dispose = () => {
      calls += 1;
    };
    return () => calls;
  }

  it("frees a discarded operand", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial();
    const discarded = new THREE.Mesh(geometry, material);
    const survivor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const geometryCalls = spyDispose(geometry);
    const materialCalls = spyDispose(material);

    disposeScratch([discarded], survivor);

    assert.equal(geometryCalls(), 1);
    assert.equal(materialCalls(), 1);
  });

  it("keeps resources the survivor shares with a discarded operand", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial();
    const survivor = new THREE.Mesh(geometry, material);
    // `clone()` shares both — this is what a CSG operand looks like.
    const discarded = survivor.clone();
    const geometryCalls = spyDispose(geometry);
    const materialCalls = spyDispose(material);

    disposeScratch([discarded], survivor);

    assert.equal(geometryCalls(), 0, "freed the geometry the survivor draws with");
    assert.equal(materialCalls(), 0, "freed the material the survivor draws with");
  });

  it("frees the operands when CSG fails and the fallback group is returned", () => {
    // The fallback rebuilds the children, so everything built before the
    // failure is unreachable — and it used to skip the cleanup entirely.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const abandoned = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    const fallback = new THREE.Group();
    fallback.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    const geometryCalls = spyDispose(geometry);

    disposeScratch([abandoned], fallback);

    assert.equal(geometryCalls(), 1);
  });

  it("frees what a refused CSG built before the budget rejected it", () => {
    // The rethrow path returns nothing, so every operand built before the
    // refusal is unreachable — and a rejected preview can be retried.
    const disposed: string[] = [];
    const original = THREE.BufferGeometry.prototype.dispose;
    THREE.BufferGeometry.prototype.dispose = function patched(this: THREE.BufferGeometry) {
      disposed.push(this.type);
    };
    try {
      // The FIRST child must succeed (so `scratch` holds something) and a later
      // one must trip the budget.
      assert.throws(
        () => astToThreeJS(parseShapeScript("difference {\n  sphere { size 2 }\n  for i in 1 to 50 {\n    cube { position i 0 0 }\n  }\n}"), { maxNodes: 6 }),
        ShapeScriptLimitError,
      );
    } finally {
      THREE.BufferGeometry.prototype.dispose = original;
    }
    assert.ok(disposed.length > 0, "the refused CSG freed nothing");
  });

  it("leaves a CSG result renderable after its operands are freed", () => {
    // End to end: the geometry the returned object carries must still have its
    // position attribute after `convertCSG` disposes the scratch.
    const group = astToThreeJS(parseShapeScript("difference {\n  sphere { size 2 }\n  sphere { size 1.7 }\n}"));
    let meshes = 0;
    group.traverse((object) => {
      // By `type`, not `instanceof`: the CSG result is a `Brush` from
      // three-bvh-csg, which resolves its own copy of three under tsx.
      if (object.type !== "Mesh") return;
      meshes += 1;
      const { geometry } = object as THREE.Mesh;
      assert.ok(geometry.getAttribute("position"), "result geometry lost its positions");
    });
    assert.ok(meshes > 0, "CSG produced no mesh");
  });
});
