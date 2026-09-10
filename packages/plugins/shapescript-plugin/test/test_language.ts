import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { executePresentShapeScript, samples } from "../src/core/index";
import { parseShapeScript } from "../src/shapescript/parser";
import { astToThreeJS } from "../src/shapescript/toThreeJS";
import { disposeObject3D } from "../src/shapescript/dispose";

const context = {} as Parameters<typeof executePresentShapeScript>[0];
function withMesh(script: string, check: (mesh: THREE.Mesh) => void) {
  const group = astToThreeJS(parseShapeScript(script));
  try {
    const meshes: THREE.Mesh[] = [];
    group.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    assert.equal(meshes.length, 1);
    check(meshes[0]!);
  } finally {
    disposeObject3D(group);
  }
}
function volume(mesh: THREE.Mesh): number {
  const p = mesh.geometry.getAttribute("position"),
    index = mesh.geometry.index;
  let value = 0;
  for (let i = 0; i < (index?.count ?? p.count); i += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(p, index ? index.getX(i + j) : i + j));
    value += a!.dot(b!.cross(c!)) / 6;
  }
  return value;
}

describe("validation before presentation", () => {
  for (const [script, code, message] of [
    ["cube {", "PARSE_ERROR", /RBRACE/],
    ["cube { size missing }", "EVALUATION_ERROR", /Undefined variable/],
    ["difference { cube imaginaryShape }", "EVALUATION_ERROR", /Unknown shape/],
    ["for i in 1 to 100000000 { cube }", "LIMIT_EXCEEDED", /iterations/],
    ["cube { position (1 / 0) 0 0 }", "EVALUATION_ERROR", /finite/],
    ["loft { square }", "EVALUATION_ERROR", /two cross-sections/],
    ["/* unfinished", "PARSE_ERROR", /Unterminated block comment/],
    ["cube { size 1.2.3 }", "PARSE_ERROR", /Invalid number/],
    ["cube { size 1e999 }", "PARSE_ERROR", /Invalid number/],
    ["cube { size }", "PARSE_ERROR", /Unexpected token/],
    // A `}` with no block open. `parseNode()` answers null there (that is how a
    // block's loop stops) so nothing consumed it, and the top-level loop used to
    // spin on it forever — synchronously, taking the whole host process with it.
    ["cube { size 1 }\n}", "PARSE_ERROR", /line 2, column 1: Unexpected token: RBRACE/],
  ] as const) {
    it(`returns a diagnostic for ${script}`, async () => {
      const result = await executePresentShapeScript(context, { title: "Invalid", script });
      assert.ok("error" in result);
      assert.equal(result.error.code, code);
      assert.match(result.error.message, message);
      assert.equal(result.data, undefined);
      assert.deepEqual(result.jsonData, { error: result.error });
      if (code === "PARSE_ERROR") {
        assert.ok(result.error.line);
        assert.ok(result.error.column);
      }
    });
  }
  it("validates all shipped samples", async () => {
    for (const sample of samples) {
      const result = await executePresentShapeScript(context, sample.args as unknown as Parameters<typeof executePresentShapeScript>[1]);
      assert.ok(result.data, `${sample.name}: ${result.message}`);
    }
  });
  it("returns invalid arguments without throwing", async () => {
    for (const args of [null, {}, { title: "X", script: 4 }, { title: 42, script: "cube" }]) {
      const result = await executePresentShapeScript(context, args as Parameters<typeof executePresentShapeScript>[1]);
      assert.ok("error" in result);
      assert.equal(result.error.code, "INVALID_ARGUMENT");
    }
  });
});

describe("geometry builders", () => {
  it("lofts two squares into a capped solid of the expected volume", () => {
    withMesh("loft { square translate 0 0 2 square }", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 2) < 1e-5);
      mesh.geometry.computeBoundingBox();
      assert.equal(mesh.geometry.boundingBox?.max.z, 2);
    });
  });
  it("lofts different profiles and works inside a boolean", () => {
    withMesh("difference { loft { square translate 0 0 2 circle } cube }", (mesh) => {
      assert.ok(volume(mesh) > 0);
    });
  });
  it("forms a convex hull connecting separated cubes", () => {
    withMesh("hull { cube { position -1 0 0 } cube { position 1 0 0 } }", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 3) < 1e-5);
    });
  });
  it("stencil preserves volume and paints only intersecting surfaces", () => {
    withMesh("stencil { cube { color 1 0 0 } cube { position 0.5 0 0 color 0 1 0 } }", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 1) < 1e-5, `volume ${volume(mesh)}`);
      assert.ok(Array.isArray(mesh.material));
      const colors = new Set(
        mesh.geometry.groups.filter((g) => g.count > 0).map((g) => (mesh.material as THREE.MeshStandardMaterial[])[g.materialIndex ?? 0]!.color.getHexString()),
      );
      assert.ok(colors.has("ff0000"));
      assert.ok(colors.has("00ff00"));
      mesh.geometry.computeBoundingBox();
      assert.equal(mesh.geometry.boundingBox?.max.x, 0.5);
    });
  });
  it("keeps a state-only command as a CSG child, which produces no object", () => {
    // `color`, `translate`, `define` and friends convert to null — reading a
    // mesh flag off one used to throw a TypeError out of the CSG collector.
    for (const script of ["difference { cube color 1 0 0 sphere }", "difference { cube translate 0.5 0 0 sphere }", "union { detail 8 cube }"]) {
      withMesh(script, (mesh) => assert.ok(mesh.geometry.getAttribute("position")));
    }
  });
  it("refuses a volumeless path as a CSG operand instead of feeding it to the evaluator", () => {
    assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript("difference { cube path { point 0 0 point 1 0 point 0 1 } }"))), /no volume/);
  });
  it("refunds the vertex budget for builder operands that never enter the scene", () => {
    // Each `hull` builds its two spheres, charges them, then disposes them —
    // they never reach the scene, so their charge must not accumulate. The
    // budget here holds the 24,000 vertices this actually draws with room to
    // spare, but not the ~8,800 of discarded operands on top of them.
    const group = astToThreeJS(parseShapeScript("detail 20 for i in 1 to 10 { hull { sphere { position i 0 0 } sphere { position i 2 0 } } }"), {
      maxVertices: 30_000,
    });
    try {
      let vertices = 0;
      group.traverse((object) => {
        vertices += (object as THREE.Mesh).geometry?.getAttribute("position")?.count ?? 0;
      });
      assert.equal(vertices, 24_000);
    } finally {
      disposeObject3D(group);
    }
  });
  it("refuses a conversion that outruns the wall-clock budget", () => {
    assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript("detail 32 for i in 1 to 5000 { sphere }"), { maxDurationMs: 0 })), /longer than/);
  });
  it("refuses a lathe profile that samples to nothing", () => {
    for (const script of [
      "lathe path { translate 1e308 0 translate 1e308 0 point 1 0 point 1 1 }",
      "lathe path { point 0 0 point 0 1 point 0 2 }",
      "lathe path { point 1 0 point 1 0 }",
    ]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /overflow|axis of rotation|at least 2 points/, script);
    }
    withMesh("lathe path { point 0.5 0 curve 1.5 1 point 0.5 2 point 0 2 }", (mesh) => assert.ok(mesh.geometry.getAttribute("position").count > 0));
  });
  it("refuses a solid whose extent is zero in some dimension", () => {
    for (const script of [
      "sphere { size 0 }",
      "cube { size 0 }",
      "cube { size 1 1 0 }",
      "cylinder { height 0 }",
      "cone { size 0 }",
      "torus { innerRadius 0 }",
    ]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /nonzero size/, script);
    }
    // Flat by definition, and one zero radius makes a cylinder a cone.
    for (const script of ["square", "circle { size 0 }", "cylinder { radiusTop 0 }"]) {
      withMesh(script, (mesh) => assert.ok(mesh.geometry.getAttribute("position").count > 0));
    }
  });
  it("refuses a scope color that is not numeric, as the per-shape property already did", () => {
    assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript('color "bad" cube'))), /numeric color/);
    withMesh("color 1 0 0 cube", (mesh) => assert.equal((mesh.material as THREE.MeshStandardMaterial).color.getHexString(), "ff0000"));
  });
  it("refuses non-finite color channels, which THREE.Color accepts silently", () => {
    for (const script of ["cube { color (1e308 * 1e308) }", "color (1e308 * 1e308) cube", "cube { color (1e308 * 1e308) 0 0 }"]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /finite color/, script);
    }
    withMesh("color 0.5 cube", (mesh) => assert.ok((mesh.material as THREE.MeshStandardMaterial).color.equals(new THREE.Color(0.5, 0.5, 0.5))));
  });
  it("refuses a path whose accumulated transform overflows", () => {
    // Individually finite operands, but the path's frame accumulates: `NaN`
    // positions reach the geometry and every later comparison against them is false.
    for (const script of [
      "lathe path { translate 1e308 0 translate 1e308 0 point 1 0 point 1 1 }",
      "fill path { scale 1e308 1e308 scale 1e308 1e308 point 1 0 point 1 1 point 0 1 }",
      "extrude path { for i in 1 to 10 { translate 1e307 1e307 point 0 0 point 1 0 point 0 1 } }",
      "lathe path { rotate 1e308 rotate 1e308 point 1 0 point 1 1 }",
      "extrude path { point 1e308 0 point 1e308 1e308 point (0 - 1e308) 1e308 }",
    ]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /overflow/, script);
    }
  });
  it("refuses a degenerate inline path instead of presenting an empty mesh", () => {
    for (const script of [
      "fill path { point 0 0 }",
      "fill path { point 0 0 point 1 0 }",
      "extrude path { point 0 0 point 1 0 point 2 0 }",
      "path { point 0 0 }",
    ]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /encloses an area/, script);
    }
    withMesh("fill path { point 0 0 point 1 0 point 0 1 }", (mesh) => assert.ok(mesh.geometry.getAttribute("position").count >= 3));
  });
  it("lofts sections whose winding a mirroring transform reversed", () => {
    withMesh("loft { square translate 0 0 2 scale -1 1 1 square }", (mesh) => assert.ok(Math.abs(volume(mesh) - 2) < 1e-5, `volume ${volume(mesh)}`));
  });
  it("keeps nested builder transforms when used as CSG operands", () => {
    withMesh("union { group { translate 5 0 0 hull { cube cube { position 1 0 0 } } } }", (mesh) => {
      mesh.geometry.computeBoundingBox();
      const box = new THREE.Box3().setFromObject(mesh);
      assert.equal(box.min.x, 4.5);
      assert.equal(box.max.x, 6.5);
    });
  });
  it("supports a stencil result as another CSG operand", () => {
    withMesh("difference { stencil { cube cube { position 0.5 0 0 color 0 1 0 } } cube { position 0 0.5 0 } }", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 0.5) < 1e-5);
    });
  });
  it("extrudes a regular polygon", () => {
    // `size` is a diameter: a unit triangle has circumradius 0.5, so its area
    // is 3·√3/4 · 0.5² and the default extrusion depth is 1.
    withMesh("extrude { polygon { sides 3 } }", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - (3 * Math.sqrt(3)) / 16) < 1e-6);
    });
  });
  it("fills a planar primitive", () => {
    withMesh("fill { square }", (mesh) => {
      assert.ok(mesh.geometry.getAttribute("position").count >= 4);
    });
  });
  it("samples curved lathe profiles", () => {
    // The control point at x=2 bows the profile out past the end points at x=1.
    withMesh("lathe path { point 1 0 curve 2 1 point 1 2 point 0 2 }", (mesh) => {
      mesh.geometry.computeBoundingBox();
      assert.ok((mesh.geometry.boundingBox?.max.x ?? 0) > 1.1);
    });
  });
});

describe("expressions", () => {
  it("supports chained tuple/string access", () => {
    withMesh('define points ((2 3 4), (5 6 7))\ncube { position points[1].x points[0].y points.count size "abc".count }', (mesh) => {
      assert.deepEqual(mesh.position.toArray(), [5, 3, 2]);
    });
  });
  it("rejects unknown members and out-of-range indices", () => {
    for (const expression of ["(1 2 3).constructor", "(1 2 3)[3]", "(1 2 3)[-1]"]) {
      assert.throws(() => astToThreeJS(parseShapeScript(`cube { size ${expression} }`)), /Unknown member|out of range/);
    }
  });
  it("supports constants, numeric literals, tuple min/max and string functions", () => {
    withMesh("if true { cube { position +2 .5 1e-3 size max((1, 2, 3)) } }", (mesh) => {
      assert.deepEqual(mesh.position.toArray(), [2, 0.5, 0.001]);
    });
    withMesh('cube { size (tau / pi) position trim(" abc ").count join(("a", "b"), "").count 0 }', (mesh) => {
      assert.deepEqual(mesh.position.toArray(), [3, 2, 0]);
    });
  });
  it("uses inline path definitions and loops in builders", () => {
    // `rotate 0.5` is a quarter turn of the path's frame, so the four points
    // land on the axes at radius `edge`: a diamond of area 2.
    withMesh("extrude path { define edge 1 for i in 1 to 4 { point edge 0 rotate 0.5 } point edge 0 }", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 2) < 1e-5);
    });
  });
  it("distinguishes signed tuple components from binary arithmetic", () => {
    for (const vector of ["1 +2 3", "+1 +2 +3", "(1 +2 +3)", "1 (1 + 1) (1+2)"]) {
      withMesh(`cube { position ${vector} }`, (mesh) => assert.deepEqual(mesh.position.toArray(), [1, 2, 3]));
    }
    withMesh("cube { position -1 -2 -3 }", (mesh) => assert.deepEqual(mesh.position.toArray(), [-1, -2, -3]));
    withMesh("extrude path { point +0 +0 point +1 +0 point +0 +1 point -1 +0 }", (mesh) => assert.ok(Math.abs(volume(mesh) - 1) < 1e-5));
    withMesh("extrude path { point 0 0 point (1 + 2 * 3) 0 point 0 1 point -7 0 }", (mesh) => assert.ok(Math.abs(volume(mesh) - 7) < 1e-5));
  });
  it("evaluates `rnd` the same way twice, so validation and rendering agree", () => {
    // The server validates the script and the browser renders it from source;
    // an unseeded generator lets the two runs take different branches.
    const positions = [0, 1].map(() => {
      const group = astToThreeJS(parseShapeScript("for i in 1 to 5 { cube { position rnd rand() rnd } }"));
      try {
        const values: number[] = [];
        group.traverse((object) => values.push(...object.position.toArray()));
        return values;
      } finally {
        disposeObject3D(group);
      }
    });
    assert.deepEqual(positions[0], positions[1]);
    assert.ok(new Set(positions[0]).size > 3, "a seeded generator must still vary within one script");
  });
  it("short circuits boolean expressions", () => {
    withMesh("if 1 or missing { cube }", () => {});
    withMesh("if 0 and missing { sphere } else { cube }", () => {});
  });
});

// Upstream ShapeScript conventions (https://shapescript.info/mac/): half-turn
// rotations in roll/yaw/pitch order, diameters for curved primitives, absolute
// path coordinates with Bézier control points, and a scoped `seed` command.
// Every case here is a script that renders WRONG without any error if one of
// those slips back to the old present3D conventions.
function meshesOf(script: string): { group: THREE.Group; meshes: THREE.Mesh[] } {
  const group = astToThreeJS(parseShapeScript(script));
  const meshes: THREE.Mesh[] = [];
  group.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
  });
  return { group, meshes };
}
function extent(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
}
function near(actual: readonly number[], expected: readonly number[], tolerance = 1e-6): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - (expected[index] ?? Number.NaN)) < tolerance, `${actual} ≠ ${expected}`));
}
function upstreamRnd(seed: number): number {
  return ((seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
}

describe("upstream conventions", () => {
  it("treats size as a DIAMETER for curved primitives, so a bare sphere fits the unit cube", () => {
    withMesh("sphere", (mesh) => near(extent(mesh).toArray(), [1, 1, 1], 1e-3));
    withMesh("sphere { size 2 1 1 }", (mesh) => near(extent(mesh).toArray(), [2, 1, 1], 1e-3));
    withMesh("cylinder { size 1 3 }", (mesh) => near(extent(mesh).toArray(), [1, 3, 1], 1e-3));
    withMesh("cone { size 2 1 }", (mesh) => near(extent(mesh).toArray(), [2, 1, 2], 1e-3));
    withMesh("circle", (mesh) => near(extent(mesh).toArray(), [1, 1, 0], 1e-3));
    withMesh("torus", (mesh) => near(extent(mesh).toArray().slice(0, 2), [1, 1], 1e-3));
    withMesh("torus {\n size 2\n innerRadius 0.25\n}", (mesh) => near(extent(mesh).toArray(), [2, 2, 0.5], 1e-3));
    assert.throws(() => astToThreeJS(parseShapeScript("torus {\n size 1\n innerRadius 0.5\n}")), /no radius left/);
  });
  it("reads orientation as roll yaw pitch in half-turns, applied Z then Y then X", () => {
    // 0.5 half-turns = 90°: the 2-long side swings from X onto Z.
    withMesh("cube { orientation 0 0.5 0 size 2 1 1 }", (mesh) => near(extent(mesh).toArray(), [1, 1, 2], 1e-6));
    withMesh("cube { rotation 0.5 size 2 1 1 }", (mesh) => near(extent(mesh).toArray(), [1, 2, 1], 1e-6));
    // A lone value is a roll, not a uniform tuple like `size`.
    withMesh("cube { orientation 0.25 }", (mesh) => {
      const roll = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 4));
      assert.ok(Math.abs(mesh.quaternion.dot(roll)) > 1 - 1e-9);
    });
    // Angle-axis form: 0.5 about Y is the same rotation as yaw 0.5.
    const { group, meshes } = meshesOf("cube { orientation 0.5 0 1 0 }\ncube { orientation 0 0.5 0 }");
    try {
      assert.ok(Math.abs(meshes[0]!.quaternion.dot(meshes[1]!.quaternion)) > 1 - 1e-9);
    } finally {
      disposeObject3D(group);
    }
    assert.throws(() => astToThreeJS(parseShapeScript("cube { orientation 0.5 0 0 0 }")), /axis/);
    // An axis is a direction: huge or tiny components must not overflow or underflow it away.
    for (const magnitude of ["1e200", "1e-200"]) {
      withMesh(`cube { orientation 0.5 0 ${magnitude} 0 size 2 1 1 }`, (mesh) => near(extent(mesh).toArray(), [1, 1, 2], 1e-6));
    }
    assert.throws(() => astToThreeJS(parseShapeScript("cube { orientation 1 2 3 4 5 }")), /rotation/);
  });
  it("rotates clockwise for positive angles, like Euclid, and `rotate` is relative in half-turns", () => {
    // A quarter roll takes +X to -Y when viewed from the front; a quarter yaw takes +X to +Z.
    withMesh("rotate 0.5\ncube { position 1 0 0 }", (mesh) => near(mesh.position.toArray(), [0, -1, 0]));
    withMesh("rotate 0 0.5 0\ncube { position 1 0 0 }", (mesh) => near(mesh.position.toArray(), [0, 0, 1]));
    withMesh("rotate 0 0 0.5\ncube { position 0 1 0 }", (mesh) => near(mesh.position.toArray(), [0, 0, -1]));
    // Two quarter turns compose into a half turn.
    withMesh("rotate 0.5\nrotate 0.5\ncube { position 1 0 0 }", (mesh) => near(mesh.position.toArray(), [-1, 0, 0]));
    // `orientation` as a command is absolute: the second one replaces the first.
    withMesh("orientation 0.5\norientation 1\ncube { position 1 0 0 }", (mesh) => near(mesh.position.toArray(), [-1, 0, 0]));
  });
  it("places path points at absolute coordinates in the path's frame", () => {
    // A unit square, spelled the way the upstream docs do.
    withMesh("extrude path { point 0 0 point 1 0 point 1 1 point 0 1 point 0 0 }", (mesh) => assert.ok(Math.abs(volume(mesh) - 1) < 1e-6));
    // `translate` moves the frame, so the same square lands 5 units over.
    withMesh("fill path { translate 5 0 point 0 0 point 1 0 point 1 1 point 0 1 point 0 0 }", (mesh) => {
      mesh.geometry.computeBoundingBox();
      near([mesh.geometry.boundingBox!.min.x, mesh.geometry.boundingBox!.max.x], [5, 6]);
    });
    // `scale` scales the frame; a lone value is uniform and evaluated ONCE,
    // so `scale rnd` draws one number, not one per axis.
    withMesh("extrude path { scale 2 point 0 0 point 1 0 point 1 1 point 0 1 point 0 0 }", (mesh) => assert.ok(Math.abs(volume(mesh) - 4) < 1e-6));
    withMesh("extrude path { scale rnd point 0 0 point 1 0 point 1 1 point 0 1 point 0 0 }", (mesh) => {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      near([box.max.x, box.max.y], [upstreamRnd(0), upstreamRnd(0)]);
    });
  });
  it("treats `curve` as a Bézier control point, with implicit midpoints between consecutive controls", () => {
    // The octagon-of-controls idiom from the upstream docs draws a unit circle.
    const circle =
      "extrude path { curve -0.414 1 curve 0.414 1 curve 1 0.414 curve 1 -0.414 curve 0.414 -1 curve -0.414 -1 curve -1 -0.414 curve -1 0.414 curve -0.414 1 }";
    withMesh(circle, (mesh) => assert.ok(Math.abs(volume(mesh) - Math.PI) / Math.PI < 0.03, `${volume(mesh)}`));
    // The procedural semicircle from the upstream docs: half a unit disc once
    // filled, give or take the 4% that on-curve midpoints at cos(11.25°) cost.
    withMesh("extrude path { for 0 to 8 { curve 0 1 rotate 1 / 8 } }", (mesh) =>
      assert.ok(Math.abs(volume(mesh) - Math.PI / 2) / (Math.PI / 2) < 0.05, `${volume(mesh)}`),
    );
    // One control between two corners bows the edge out without passing through the control.
    withMesh("fill path { point -1 -1 curve 0 1 point 1 -1 point -1 -1 }", (mesh) => {
      mesh.geometry.computeBoundingBox();
      const top = mesh.geometry.boundingBox!.max.y;
      assert.ok(top > -0.5 && top < 0.5, `${top}`);
    });
  });
  it("seeds `rnd` with upstream's generator, scoped to the enclosing block", () => {
    withMesh("cube { position rnd 0 0 }", (mesh) => near([mesh.position.x], [upstreamRnd(0)]));
    withMesh("seed 57\ncube { position rnd 0 0 }", (mesh) => near([mesh.position.x], [upstreamRnd(57)]));
    // The group reseeds itself only; the outer `rnd` is still the first draw of the default sequence.
    const { group, meshes } = meshesOf("group { seed 57 cube { position rnd 0 0 } }\ncube { position rnd 0 0 }");
    try {
      near([meshes[0]!.position.x, meshes[1]!.position.x], [upstreamRnd(57), upstreamRnd(0)]);
    } finally {
      disposeObject3D(group);
    }
    // Without a reseed, a block advances the sequence it shares with its parent.
    const shared = meshesOf("group { cube { position rnd 0 0 } }\ncube { position rand() 0 0 }");
    try {
      near([shared.meshes[0]!.position.x, shared.meshes[1]!.position.x], [upstreamRnd(0), upstreamRnd(upstreamRnd(0) * 2 ** 32)]);
    } finally {
      disposeObject3D(shared.group);
    }
    assert.throws(() => astToThreeJS(parseShapeScript("seed (1e308 * 1e308)")), /finite/);
  });
});
