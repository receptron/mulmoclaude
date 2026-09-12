import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { executePresentShapeScript, samples } from "../src/core/index";
import { parseShapeScript } from "../src/shapescript/parser";
import { astToThreeJS, sceneInfoOf } from "../src/shapescript/toThreeJS";
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
    ["difference {\n cube\n imaginaryShape\n}", "EVALUATION_ERROR", /Unknown shape/],
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
    withMesh("loft {\n square\n translate 0 0 2\n square\n}", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 2) < 1e-5);
      mesh.geometry.computeBoundingBox();
      assert.equal(mesh.geometry.boundingBox?.max.z, 2);
    });
  });
  it("lofts different profiles and works inside a boolean", () => {
    withMesh("difference {\n loft {\n  square\n  translate 0 0 2\n  circle\n }\n cube\n}", (mesh) => {
      assert.ok(volume(mesh) > 0);
    });
  });
  it("forms a convex hull connecting separated cubes", () => {
    withMesh("hull {\n cube {\n  position -1 0 0\n }\n cube {\n  position 1 0 0\n }\n}", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 3) < 1e-5);
    });
  });
  it("stencil preserves volume and paints only intersecting surfaces", () => {
    withMesh("stencil {\n cube {\n  color 1 0 0\n }\n cube {\n  position 0.5 0 0\n  color 0 1 0\n }\n}", (mesh) => {
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
    for (const script of [
      "difference {\n cube\n color 1 0 0\n sphere\n}",
      "difference {\n cube\n translate 0.5 0 0\n sphere\n}",
      "union {\n detail 8\n cube\n}",
    ]) {
      withMesh(script, (mesh) => assert.ok(mesh.geometry.getAttribute("position")));
    }
  });
  it("refuses a volumeless path as a CSG operand instead of feeding it to the evaluator", () => {
    assert.throws(
      () => disposeObject3D(astToThreeJS(parseShapeScript("difference {\n cube\n path {\n  point 0 0\n  point 1 0\n  point 0 1\n }\n}"))),
      /no volume/,
    );
  });
  it("refunds the vertex budget for builder operands that never enter the scene", () => {
    // Each `hull` builds its two spheres, charges them, then disposes them —
    // they never reach the scene, so their charge must not accumulate. The
    // budget here holds the 24,000 vertices this actually draws with room to
    // spare, but not the ~8,800 of discarded operands on top of them.
    const group = astToThreeJS(
      parseShapeScript("detail 20\nfor i in 1 to 10 {\n hull {\n  sphere {\n   position i 0 0\n  }\n  sphere {\n   position i 2 0\n  }\n }\n}"),
      {
        maxVertices: 30_000,
      },
    );
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
    assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript("detail 32\nfor i in 1 to 5000 {\n sphere\n}"), { maxDurationMs: 0 })), /longer than/);
  });
  it("refuses a lathe profile that samples to nothing", () => {
    for (const script of [
      "lathe path {\n translate 1e308 0\n translate 1e308 0\n point 1 0\n point 1 1\n}",
      "lathe path {\n point 0 0\n point 0 1\n point 0 2\n}",
      "lathe path {\n point 1 0\n point 1 0\n}",
    ]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /overflow|axis of rotation|at least 2 points/, script);
    }
    withMesh("lathe path {\n point 0.5 0\n curve 1.5 1\n point 0.5 2\n point 0 2\n}", (mesh) => assert.ok(mesh.geometry.getAttribute("position").count > 0));
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
    assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript('color "bad"\ncube'))), /numeric color/);
    withMesh("color 1 0 0\ncube", (mesh) => assert.equal((mesh.material as THREE.MeshStandardMaterial).color.getHexString(), "ff0000"));
  });
  it("refuses non-finite color channels, which THREE.Color accepts silently", () => {
    for (const script of ["cube { color (1e308 * 1e308) }", "color (1e308 * 1e308)\ncube", "cube { color (1e308 * 1e308) 0 0 }"]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /finite color/, script);
    }
    withMesh("color 0.5\ncube", (mesh) => assert.ok((mesh.material as THREE.MeshStandardMaterial).color.equals(new THREE.Color(0.5, 0.5, 0.5))));
  });
  it("refuses a path whose accumulated transform overflows", () => {
    // Individually finite operands, but the path's frame accumulates: `NaN`
    // positions reach the geometry and every later comparison against them is false.
    for (const script of [
      "lathe path {\n translate 1e308 0\n translate 1e308 0\n point 1 0\n point 1 1\n}",
      "fill path {\n scale 1e308 1e308\n scale 1e308 1e308\n point 1 0\n point 1 1\n point 0 1\n}",
      "extrude path {\n for i in 1 to 10 {\n  translate 1e307 1e307\n  point 0 0\n  point 1 0\n  point 0 1\n }\n}",
      "lathe path {\n rotate 1e308\n rotate 1e308\n point 1 0\n point 1 1\n}",
      "extrude path {\n point 1e308 0\n point 1e308 1e308\n point (0 - 1e308) 1e308\n}",
    ]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /overflow/, script);
    }
  });
  it("refuses a degenerate inline path instead of presenting an empty mesh", () => {
    for (const script of [
      "fill path { point 0 0 }",
      "fill path {\n point 0 0\n point 1 0\n}",
      "extrude path {\n point 0 0\n point 1 0\n point 2 0\n point 0 0\n}",
    ]) {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script))), /encloses an area/, script);
    }
    // A bare path is a stroke, so it needs a segment rather than an area.
    assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript("path { point 0 0 }"))), /at least two points/);
    withMesh("fill path {\n point 0 0\n point 1 0\n point 0 1\n}", (mesh) => assert.ok(mesh.geometry.getAttribute("position").count >= 3));
  });
  it("lofts sections whose winding a mirroring transform reversed", () => {
    withMesh("loft {\n square\n translate 0 0 2\n scale -1 1 1\n square\n}", (mesh) => assert.ok(Math.abs(volume(mesh) - 2) < 1e-5, `volume ${volume(mesh)}`));
  });
  it("keeps nested builder transforms when used as CSG operands", () => {
    withMesh("union {\n group {\n  translate 5 0 0\n  hull {\n   cube\n   cube {\n    position 1 0 0\n   }\n  }\n }\n}", (mesh) => {
      mesh.geometry.computeBoundingBox();
      const box = new THREE.Box3().setFromObject(mesh);
      assert.equal(box.min.x, 4.5);
      assert.equal(box.max.x, 6.5);
    });
  });
  it("supports a stencil result as another CSG operand", () => {
    withMesh("difference {\n stencil {\n  cube\n  cube {\n   position 0.5 0 0\n   color 0 1 0\n  }\n }\n cube {\n  position 0 0.5 0\n }\n}", (mesh) => {
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
    withMesh("lathe path {\n point 1 0\n curve 2 1\n point 1 2\n point 0 2\n}", (mesh) => {
      mesh.geometry.computeBoundingBox();
      assert.ok((mesh.geometry.boundingBox?.max.x ?? 0) > 1.1);
    });
  });
});

describe("expressions", () => {
  it("supports chained tuple/string access", () => {
    withMesh('define points ((2 3 4), (5 6 7))\ncube {\n position points[1].x points[0].y points.count\n size "abc" .count\n}', (mesh) => {
      assert.deepEqual(mesh.position.toArray(), [5, 3, 2]);
    });
  });
  it("rejects unknown members and out-of-range indices", () => {
    for (const expression of ["(1 2 3).constructor", "(1 2 3)[3]", "(1 2 3)[-4]", '(1 2 3)["w"]']) {
      assert.throws(() => astToThreeJS(parseShapeScript(`cube { size ${expression} }`)), /Unknown member|out of range/);
    }
    // Negative indices count from the end and a string index is a member, as upstream.
    withMesh('cube { size (1 2 3)[-1] (1 2 3)["y"] (5 6)[-2] }', (mesh) => assert.deepEqual(extent(mesh).toArray(), [3, 2, 5]));
  });
  it("supports constants, numeric literals, tuple min/max and string functions", () => {
    withMesh("if true {\n cube {\n  position +2 .5 1e-3\n  size max((1, 2, 3))\n }\n}", (mesh) => {
      assert.deepEqual(mesh.position.toArray(), [2, 0.5, 0.001]);
    });
    withMesh('cube {\n size (2 * pi / pi)\n position trim(" abc ").count join(("a", "b"), "").count 0\n}', (mesh) => {
      assert.deepEqual(mesh.position.toArray(), [3, 2, 0]);
    });
  });
  it("uses inline path definitions and loops in builders", () => {
    // `rotate 0.5` is a quarter turn of the path's frame, so the four points
    // land on the axes at radius `edge`: a diamond of area 2.
    withMesh("extrude path {\n define edge 1\n for i in 1 to 4 {\n  point edge 0\n  rotate 0.5\n }\n point edge 0\n}", (mesh) => {
      assert.ok(Math.abs(volume(mesh) - 2) < 1e-5);
    });
  });
  it("reads call arguments as a value list, so upstream's `max(0 (j - 1))` and our `max(0, j - 1)` both work", () => {
    for (const call of ["max(0 (j - 1))", "max(0, j - 1)", "max(0,(j - 1))", "(max(0 (j-1)))"]) {
      withMesh(`define j 3\ncube { size ${call} }`, (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    }
    withMesh("cube { size pow(2 3) pow(2, 2) pow(2 -1) }", (mesh) => near(extent(mesh).toArray(), [8, 4, 0.5]));
    withMesh("cube { size min(1, max(0, (1 - 0.5) / 2)) }", (mesh) => near(extent(mesh).toArray(), [0.25, 0.25, 0.25]));
    withMesh('cube { size join(("a", "b"), "-").count }', (mesh) => near(extent(mesh).toArray(), [3, 3, 3]));
  });
  it("supports upstream's ordinal members", () => {
    withMesh("define v (1 2 3 4)\ncube {\n position v.first v.second v.last\n size v.fourth\n}", (mesh) => {
      near(mesh.position.toArray(), [1, 2, 4]);
      near(extent(mesh).toArray(), [4, 4, 4]);
    });
    withMesh("define rows ((1 2 3) (4 5 6))\ncube {\n position rows.last\n size rows.first.third\n}", (mesh) => near(mesh.position.toArray(), [4, 5, 6]));
    withMesh('define v (1 2 3)\ncube {\n position v.allButFirst.first v.allButLast.count 0\n size "abc" .allButFirst.count\n}', (mesh) => {
      near(mesh.position.toArray(), [2, 2, 0]);
      near(extent(mesh).toArray(), [2, 2, 2]);
    });
    for (const expression of ["(1 2).third", "(1 2).fifth", "().last", "5.first"]) {
      assert.throws(() => astToThreeJS(parseShapeScript(`cube { size ${expression} }`)), /Unknown member|Unexpected|Undefined variable/);
    }
  });
  it("distinguishes signed tuple components from binary arithmetic", () => {
    for (const vector of ["1 +2 3", "+1 +2 +3", "(1 +2 +3)", "1 (1 + 1) (1+2)"]) {
      withMesh(`cube { position ${vector} }`, (mesh) => assert.deepEqual(mesh.position.toArray(), [1, 2, 3]));
    }
    withMesh("cube { position -1 -2 -3 }", (mesh) => assert.deepEqual(mesh.position.toArray(), [-1, -2, -3]));
    withMesh("extrude path {\n point +0 +0\n point +1 +0\n point +0 +1\n point -1 +0\n point +0 +0\n}", (mesh) => assert.ok(Math.abs(volume(mesh) - 1) < 1e-5));
    withMesh("extrude path {\n point 0 0\n point (1 + 2 * 3) 0\n point 0 1\n point -7 0\n point 0 0\n}", (mesh) =>
      assert.ok(Math.abs(volume(mesh) - 7) < 1e-5),
    );
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
    withMesh("cube {\n orientation 0 0.5 0\n size 2 1 1\n}", (mesh) => near(extent(mesh).toArray(), [1, 1, 2], 1e-6));
    withMesh("cube {\n rotation 0.5\n size 2 1 1\n}", (mesh) => near(extent(mesh).toArray(), [1, 2, 1], 1e-6));
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
      withMesh(`cube {\n orientation 0.5 0 ${magnitude} 0\n size 2 1 1\n}`, (mesh) => near(extent(mesh).toArray(), [1, 1, 2], 1e-6));
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
    withMesh("extrude path {\n point 0 0\n point 1 0\n point 1 1\n point 0 1\n point 0 0\n}", (mesh) => assert.ok(Math.abs(volume(mesh) - 1) < 1e-6));
    // `translate` moves the frame, so the same square lands 5 units over.
    withMesh("fill path {\n translate 5 0\n point 0 0\n point 1 0\n point 1 1\n point 0 1\n point 0 0\n}", (mesh) => {
      mesh.geometry.computeBoundingBox();
      near([mesh.geometry.boundingBox!.min.x, mesh.geometry.boundingBox!.max.x], [5, 6]);
    });
    // `scale` scales the frame; a lone value is uniform and evaluated ONCE,
    // so `scale rnd` draws one number, not one per axis.
    withMesh("extrude path {\n scale 2\n point 0 0\n point 1 0\n point 1 1\n point 0 1\n point 0 0\n}", (mesh) => assert.ok(Math.abs(volume(mesh) - 4) < 1e-6));
    withMesh("extrude path {\n scale rnd\n point 0 0\n point 1 0\n point 1 1\n point 0 1\n point 0 0\n}", (mesh) => {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      near([box.max.x, box.max.y], [upstreamRnd(0), upstreamRnd(0)]);
    });
  });
  it("treats `curve` as a Bézier control point, with implicit midpoints between consecutive controls", () => {
    // The octagon-of-controls idiom from the upstream docs draws a unit circle.
    const circle =
      "extrude path {\n curve -0.414 1\n curve 0.414 1\n curve 1 0.414\n curve 1 -0.414\n curve 0.414 -1\n curve -0.414 -1\n curve -1 -0.414\n curve -1 0.414\n curve -0.414 1\n}";
    withMesh(circle, (mesh) => assert.ok(Math.abs(volume(mesh) - Math.PI) / Math.PI < 0.03, `${volume(mesh)}`));
    // The procedural semicircle from the upstream docs: half a unit disc once
    // filled, give or take the 4% that on-curve midpoints at cos(11.25°) cost.
    withMesh("extrude path {\n point 0 1\n for 1 to 7 {\n  rotate 1 / 8\n  curve 0 1\n }\n rotate 1 / 8\n point 0 1\n point 0 -1\n}", (mesh) =>
      assert.ok(Math.abs(volume(mesh) - Math.PI / 2) / (Math.PI / 2) < 0.05, `${volume(mesh)}`),
    );
    // One control between two corners bows the edge out without passing through the control.
    withMesh("fill path {\n point -1 -1\n curve 0 1\n point 1 -1\n point -1 -1\n}", (mesh) => {
      mesh.geometry.computeBoundingBox();
      const top = mesh.geometry.boundingBox!.max.y;
      assert.ok(top > -0.5 && top < 0.5, `${top}`);
    });
  });
  it("seeds `rnd` with upstream's generator, scoped to the enclosing block", () => {
    withMesh("cube { position rnd 0 0 }", (mesh) => near([mesh.position.x], [upstreamRnd(0)]));
    withMesh("seed 57\ncube { position rnd 0 0 }", (mesh) => near([mesh.position.x], [upstreamRnd(57)]));
    // The group reseeds itself only; the outer `rnd` is still the first draw of the default sequence.
    const { group, meshes } = meshesOf("group {\n seed 57\n cube {\n  position rnd 0 0\n }\n}\ncube {\n position rnd 0 0\n}");
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

describe("path transform options", () => {
  it("refuses a `fill` as a loft section, as upstream does (a mesh is not a path)", () => {
    // Native ShapeScript 1.11.4: "A mesh value was not expected in this context."
    const square = "path {\n point -1 -1\n point 1 -1\n point 1 1\n point -1 1\n point -1 -1\n}";
    const script = `loft {\nfill {\n position 0 0 0\n ${square}\n}\nfill {\n position 0 0 2\n ${square}\n}\n}`;
    assert.throws(() => astToThreeJS(parseShapeScript(script)), /`loft` expects `path` cross-sections/);
    // The same value through a definition is refused too — the check is on the value, not the spelling.
    assert.throws(() => astToThreeJS(parseShapeScript(`define disc fill { ${square} }\nloft {\n disc\n translate 0 0 2\n disc\n}`)), /`loft` expects `path`/);
    // A `fill` stays legal where a mesh belongs.
    withMesh(`fill { ${square} }`, (mesh) => near(extent(mesh).toArray(), [2, 2, 0]));
    withMesh(`hull {\n fill { ${square} }\n translate 0 0 2\n fill { ${square} }\n}`, (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
  });

  it("lofts a defined or returned path value — the marker survives capture and placement", () => {
    withMesh("define sq square\nloft {\n sq\n translate 0 0 1\n sq\n}", (mesh) => near(extent(mesh).toArray(), [1, 1, 1]));
    withMesh("define sq(s) {\n square { size s }\n}\nloft {\n sq(1)\n translate 0 0 1\n sq(2)\n}", (mesh) => near(extent(mesh).toArray(), [2, 2, 1]));
    withMesh('define bar text "I"\nloft {\n bar\n translate 0 0 1\n bar\n}', (mesh) => assert.ok(extent(mesh).z > 0.99));
    // A defined solid is still not a path.
    assert.throws(() => astToThreeJS(parseShapeScript("define c cube\nloft {\n c\n translate 0 0 1\n c\n}")), /`loft` expects `path`/);
    // A function returning a tuple of paths is placed as a path too: the
    // builder then judges its outline (here two perimeters), not its kind.
    const two = "define pair() {\n square\n translate 2 0 0\n square\n}\nloft {\n pair()\n translate 0 0 1\n pair()\n}";
    assert.throws(() => astToThreeJS(parseShapeScript(two)), /multiple perimeters/);
  });

  it("lofts open paths, closing each section implicitly as upstream does", () => {
    // Native 1.11.4 builds a watertight 2×2×2 box from four unrepeated corners per section.
    const open = (z: number) => `path {\n position 0 0 ${z}\n point -1 -1\n point 1 -1\n point 1 1\n point -1 1\n}`;
    withMesh(`loft {\n${open(0)}\n${open(2)}\n}`, (mesh) => {
      near(extent(mesh).toArray(), [2, 2, 2]);
      assert.ok(Math.abs(volume(mesh) - 8) < 1e-5, `volume ${volume(mesh)}`);
    });
    // Sections keep their written order when open and closed paths are mixed.
    const closed = "path {\n position 0 0 1\n point -0.5 -0.5\n point 0.5 -0.5\n point 0.5 0.5\n point -0.5 0.5\n point -0.5 -0.5\n}";
    withMesh(`loft {\n${open(0)}\n${closed}\n${open(2)}\n}`, (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
  });

  it("places a path with its own position/orientation/size, as upstream does for loft sections", () => {
    // Two placed unit squares, 2 apart along Z, loft into a 1×1×2 slab.
    const loft =
      "loft {\npath {\n position 0 0 -1\n point -0.5 -0.5\n point 0.5 -0.5\n point 0.5 0.5\n point -0.5 0.5\n point -0.5 -0.5\n}\npath {\n position 0 0 1\n point -0.5 -0.5\n point 0.5 -0.5\n point 0.5 0.5\n point -0.5 0.5\n point -0.5 -0.5\n}\n}";
    withMesh(loft, (mesh) => near(extent(mesh).toArray(), [1, 1, 2], 1e-6));
    // A yaw of a quarter turn stands the path's plane on the X axis instead of Z.
    withMesh("fill path {\n orientation 0 0.5 0\n point 0 0\n point 2 0\n point 2 1\n point 0 1\n point 0 0\n}", (mesh) =>
      near(extent(mesh).toArray(), [0, 1, 2], 1e-6),
    );
    withMesh("extrude path {\n position 5 0 0\n size 2\n point 0 0\n point 1 0\n point 1 1\n point 0 1\n point 0 0\n}", (mesh) => {
      mesh.geometry.computeBoundingBox();
      near([mesh.geometry.boundingBox!.min.x, mesh.geometry.boundingBox!.max.x], [5, 7]);
    });
  });
  it("refuses a placed profile on a lathe and a placement inside a path loop", () => {
    assert.throws(() => astToThreeJS(parseShapeScript("lathe path {\n position 1 0 0\n point 0 0\n point 1 0\n point 1 1\n point 0 1\n}")), /place the lathe/);
    assert.throws(() => parseShapeScript("fill path { for i in 1 to 3 { position 1 0 0 point i 0 } }"), /Unexpected token/);
  });
});

function materialOf(script: string, check: (material: THREE.MeshStandardMaterial, mesh: THREE.Mesh) => void) {
  withMesh(script, (mesh) => check(mesh.material as THREE.MeshStandardMaterial, mesh));
}
function infoOf(script: string) {
  const group = astToThreeJS(parseShapeScript(script));
  try {
    return sceneInfoOf(group);
  } finally {
    disposeObject3D(group);
  }
}
function objectsOf(script: string): THREE.Object3D[] {
  const group = astToThreeJS(parseShapeScript(script));
  const objects: THREE.Object3D[] = [];
  group.traverse((object) => {
    if ((object as THREE.Mesh).isMesh || (object as THREE.Line).isLine) objects.push(object);
  });
  disposeObject3D(group);
  return objects;
}

describe("colours and materials", () => {
  it("reads hex, named, hsb and luminance colours, with alpha as opacity", () => {
    materialOf("cube { color #ff0000 }", (m) => near(m.color.toArray(), [1, 0, 0]));
    materialOf("cube { color #f00 }", (m) => near(m.color.toArray(), [1, 0, 0]));
    materialOf("cube { colour orange }", (m) => near(m.color.toArray(), [1, 0.5, 0]));
    materialOf("cube { color hsb(1 / 3 1 1) }", (m) => near(m.color.toArray(), [0, 1, 0]));
    materialOf("cube { color 0.8 }", (m) => near(m.color.toArray(), [0.8, 0.8, 0.8]));
    materialOf("cube { color #ff000080 }", (m) => {
      assert.ok(m.transparent);
      near([m.opacity], [128 / 255]);
    });
    materialOf("cube { color 1 0.5 }", (m) => {
      near(m.color.toArray(), [1, 1, 1]);
      near([m.opacity], [0.5]);
    });
    // A colour followed by a number replaces its alpha, as upstream.
    materialOf("cube { color red 0.25 }", (m) => near([m.opacity, ...m.color.toArray()], [0.25, 1, 0, 0]));
    materialOf("define glass green 0.2\ncube { color glass }", (m) => near([m.opacity, ...m.color.toArray()], [0.2, 0, 1, 0]));
    // Named colours are ordinary symbols a script may redefine.
    materialOf("define red 1 0.3 0.1\ncube { color red }", (m) => near(m.color.toArray(), [1, 0.3, 0.1]));
  });
  it("multiplies `opacity` through nested scopes and by the colour's alpha", () => {
    materialOf("opacity 0.5\ngroup {\n opacity 0.5\n cube\n}", (m) => near([m.opacity], [0.25]));
    materialOf("opacity 0.5\ncube { opacity 2 }", (m) => near([m.opacity], [1]));
    materialOf("opacity 0.5\ncube { color 1 0 0 0.5 }", (m) => near([m.opacity], [0.25]));
    materialOf("opacity 0.5\nsphere", (m) => assert.ok(m.transparent));
  });
  it("maps metallicity, roughness and glow onto the PBR material, and smoothing 0 onto flat shading", () => {
    materialOf("metallicity 0.9\nroughness 0.2\nglow red\ncube", (m) => {
      near([m.metalness, m.roughness], [0.9, 0.2]);
      near(m.emissive.toArray(), [1, 0, 0]);
      assert.equal(m.flatShading, false);
    });
    materialOf("cube {\n glow green * 0.5\n metallicity 1\n}", (m) => {
      near(m.emissive.toArray(), [0, 0.5, 0]);
      near([m.metalness], [1]);
    });
    materialOf("smoothing 0\nsphere", (m) => assert.equal(m.flatShading, true));
    materialOf("smoothing 0\nsphere { smoothing 0.5 }", (m) => assert.equal(m.flatShading, false));
  });
  it("bundles properties in `material { … }` and applies them as a command or a property", () => {
    const bundle = "define shiny material {\n color blue\n metallicity 1\n roughness 0.1\n}\n";
    materialOf(`${bundle}material shiny\ncube`, (m) => {
      near(m.color.toArray(), [0, 0, 1]);
      near([m.metalness, m.roughness], [1, 0.1]);
    });
    materialOf(`${bundle}sphere {\n material shiny\n color red\n}`, (m) => {
      near(m.color.toArray(), [1, 0, 0]);
      near([m.metalness], [1]);
    });
    assert.throws(() => infoOf("material 5\ncube"), /material \{/);
  });
  it("gives a builder the material its own block ends with", () => {
    materialOf("extrude {\n color red\n square\n}", (m) => near(m.color.toArray(), [1, 0, 0]));
    materialOf("lathe {\n color 0 1 0\n path {\n point 0 1\n point 0.5 1\n point 0.5 0\n point 0 0\n }\n}", (m) => near(m.color.toArray(), [0, 1, 0]));
    materialOf("define star {\n path {\n point 0 0\n point 1 0\n point 0 1\n point 0 0\n }\n}\nextrude {\n color blue\n size 2 2 1\n star\n}", (m, mesh) => {
      near(m.color.toArray(), [0, 0, 1]);
      near(extent(mesh).toArray(), [2, 2, 1]);
    });
  });
  it("accepts textures, cameras and lights with a warning instead of an error", () => {
    assert.deepEqual(infoOf('texture "earth.png"\nsphere').warnings, ['texture "earth.png" is not supported — the shape is drawn with its colour instead']);
    // Deduplicated and capped, so a loop of textures reports each once and stops at the bound.
    assert.equal(infoOf('for i in 1 to 500 {\n texture "t.png"\n}\ncube').warnings.length, 1);
    assert.equal(infoOf('for i in 1 to 500 {\n texture join("t" i ".png")\n}\ncube').warnings.length, 200);
    assert.match(infoOf("camera {\n position 1 2 3\n orientation 0 0.5\n}\ncube").warnings[0]!, /camera/);
    assert.match(infoOf("light { position 1 1 1 }\ncube").warnings[0]!, /light/);
    // A block the script defines itself is invoked, not skipped.
    assert.deepEqual(infoOf("define light { cube }\nlight").warnings, []);
    assert.equal(objectsOf("define light { cube }\nlight").length, 1);
  });
  it("keeps `background` for the viewer and warns about a background image", () => {
    assert.deepEqual(infoOf("background 0 0 1\ncube").background, [0, 0, 1, 1]);
    assert.deepEqual(infoOf("background #808080\ncube").background, [128 / 255, 128 / 255, 128 / 255, 1]);
    assert.equal(infoOf("cube").background, undefined);
    assert.match(infoOf('background "stars.jpg"\ncube').warnings[0]!, /background image "stars.jpg"/);
    assert.throws(() => infoOf("group {\n background red\n cube\n}"), /root/);
  });
});

describe("upstream shapes and paths", () => {
  it("pads a short `size` the way Euclid does: one value is uniform, two are x y x", () => {
    withMesh("cube { size 2 }", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    withMesh("cube { size 1 2 }", (mesh) => near(extent(mesh).toArray(), [1, 2, 1]));
    withMesh("cylinder { size 1 2 }", (mesh) => near(extent(mesh).toArray(), [1, 2, 1], 0.01));
    withMesh("group {\n size 2\n cube\n}", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
  });
  it("builds an icosphere of the requested diameter", () => {
    withMesh("icosphere {\n size 2\n detail 16\n}", (mesh) => {
      // Twenty faces at detail 0 → 20 · 4² triangles at detail 16 (two subdivisions).
      assert.equal(mesh.geometry.getAttribute("position").count, 20 * 16 * 3);
      const size = extent(mesh);
      assert.ok(size.x > 1.9 && size.x <= 2.001 && size.y > 1.9 && size.z > 1.9, size.toArray().join(","));
    });
  });
  it("builds a roundrect whose corner radius is a proportion of the smaller side", () => {
    withMesh("extrude roundrect {\n size 2 1\n radius 0.5\n}", (mesh) => {
      near(extent(mesh).toArray(), [2, 1, 1], 0.01);
      // A 2 × 1 rectangle with 0.5 corners is a stadium: 2·1 − (4 − π)·0.25.
      near([volume(mesh)], [2 - (4 - Math.PI) * 0.25], 0.02);
    });
    withMesh("fill roundrect", (mesh) => near(extent(mesh).toArray(), [1, 1, 0], 0.01));
  });
  it("places `arc` segments inside a path, clockwise from +Y", () => {
    // A half-turn arc from (0, .5) over (+.5, 0) to (0, −.5), closed along the axis: a semicircle.
    withMesh("extrude path {\n arc { angle 1 }\n point 0 0.5\n}", (mesh) => {
      near([volume(mesh)], [(Math.PI * 0.25) / 2], 0.02);
      assert.ok(mesh.geometry.boundingBox === null || true);
      const box = new THREE.Box3().setFromObject(mesh);
      assert.ok(box.max.x > 0.49 && box.min.x > -0.001, `${box.min.x}..${box.max.x}`);
    });
    // Upstream's curved slab: two quarter arcs, placed and oriented.
    withMesh(
      "extrude path {\n arc { angle -0.5 }\n point -0.5 0\n point 1.5 0\n arc {\n position 1 0\n orientation 0.5\n angle -0.5\n }\n curve 0 0.5\n}",
      (mesh) => {
        near(extent(mesh).toArray(), [2, 0.5, 1], 0.02);
      },
    );
    withMesh("extrude path {\n arc {\n  angle 1\n  size 2\n }\n point 0 1\n}", (mesh) => near([volume(mesh)], [Math.PI / 2], 0.02));
  });
  it("draws a bare path as a line, open or closed, and still fills it on request", () => {
    const [line] = objectsOf("path {\n point 0 0\n point 1 1\n point 2 0\n}");
    assert.ok((line as THREE.Line).isLine);
    assert.equal(objectsOf("path {\n point 0 0\n point 1 0\n point 0 1\n point 0 0\n}").filter((o) => (o as THREE.Mesh).isMesh).length, 0);
    withMesh("fill path {\n point 0 0\n point 1 0\n point 0 1\n point 0 0\n}", (mesh) => assert.ok(mesh.geometry.getAttribute("position").count >= 3));
    assert.throws(() => objectsOf("path { point 0 0 }"), /two points/);
    // A stroke takes the scope's colour and opacity like a mesh does.
    const [stroke] = objectsOf("opacity 0.5\ncolor #ff000080\npath {\n point 0 0\n point 1 0\n}") as THREE.Line[];
    const lineMaterial = stroke!.material as THREE.LineBasicMaterial;
    near(lineMaterial.color.toArray(), [1, 0, 0]);
    near([lineMaterial.opacity], [0.5 * (128 / 255)]);
    assert.ok(lineMaterial.transparent);
    assert.throws(() => objectsOf("path {\n point 0 0 1\n point 1 0\n}"), /planar/);
  });
  it("revolves a lathe profile drawn on the −X side like one on +X, always facing outward", () => {
    const right = "lathe path {\n point 0 1\n point 0.5 1\n point 0.5 0\n point 0 0\n}";
    const left = "lathe path {\n point 0 1\n point -0.5 1\n point -0.5 0\n point 0 0\n}";
    const upward = "lathe path {\n point 0 0\n point 0.5 0\n point 0.5 1\n point 0 1\n}";
    withMesh(right, (a) => {
      assert.ok(volume(a) > 0, "a top-down profile must not come out inside out");
      withMesh(left, (b) => near([volume(b)], [volume(a)], 1e-6));
      withMesh(upward, (c) => near([volume(c)], [volume(a)], 1e-6));
    });
    // Two lathes drawn top-down union into one solid (upstream's chess queen).
    withMesh(
      "union {\n lathe path {\n  point 0 1.2\n  point 0.15 1.05\n  point 0 0.9\n }\n lathe path {\n  point 0 0.85\n  point 0.2 0.85\n  point 0.3 0.1\n  point 0 0\n }\n}",
      (mesh) => {
        const box = new THREE.Box3().setFromObject(mesh);
        near([box.min.y, box.max.y], [0, 1.2], 1e-3);
        assert.ok(volume(mesh) > 0.05, `volume ${volume(mesh)}`);
      },
    );
  });
  it("scales a builder's result by its `size`, with an extrude's Z as the depth, centred on the profile", () => {
    withMesh("extrude {\n size 2 3 4\n square\n}", (mesh) => {
      near(extent(mesh).toArray(), [2, 3, 4]);
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.z, box.max.z], [-2, 2]);
    });
    withMesh("extrude path {\n point 0 0\n point 1 0\n point 0 1\n point 0 0\n}", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.z, box.max.z], [-0.5, 0.5]);
    });
    withMesh("extrude {\n size 0.5\n square\n}", (mesh) => near(extent(mesh).toArray(), [0.5, 0.5, 0.5]));
    withMesh("hull {\n size 2\n cube\n}", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
  });
  it("places and colours a custom block through its standard options", () => {
    materialOf("define post {\n cube\n}\npost {\n position 1 2 3\n size 2\n color red\n}", (m, mesh) => {
      near(mesh.position.toArray(), [1, 2, 3]);
      near(extent(mesh).toArray(), [2, 2, 2]);
      near(m.color.toArray(), [1, 0, 0]);
    });
    withMesh("define post { cube { size 1 2 1 } }\npost { orientation 0 0 0.5 }", (mesh) => near(extent(mesh).toArray(), [1, 1, 2]));
    withMesh('define post { cube }\npost { name "left" }', (mesh) => assert.equal(mesh.parent?.name, "left"));
    // `detail` / `smoothing` on the call apply to the block's body.
    materialOf("define bead { sphere }\nbead {\n detail 4\n smoothing 0\n}", (m, mesh) => {
      assert.ok(mesh.geometry.getAttribute("position").count < 60);
      assert.equal(m.flatShading, true);
    });
  });
  it("applies a per-shape `detail`", () => {
    withMesh("sphere { detail 8 }", (mesh) => assert.ok(mesh.geometry.getAttribute("position").count < 100));
    withMesh("detail 8\nsphere { detail 64 }\n", (mesh) => assert.ok(mesh.geometry.getAttribute("position").count > 4000));
  });
});

describe("control flow, ranges and functions", () => {
  it("lets `translate` / `rotate` / `color` inside for, if and switch carry on after the block, as upstream", () => {
    withMesh("for 1 to 3 { translate 1 0 0 }\ncube", (mesh) => near(mesh.position.toArray(), [3, 0, 0]));
    withMesh("if true { translate 0 1 0 }\ncube", (mesh) => near(mesh.position.toArray(), [0, 1, 0]));
    withMesh("switch 1 {\ncase 1\n translate 0 0 1\n}\ncube", (mesh) => near(mesh.position.toArray(), [0, 0, 1]));
    materialOf("for 1 to 1 { color red }\ncube", (m) => near(m.color.toArray(), [1, 0, 0]));
    // Groups and custom blocks still scope them.
    withMesh("group { translate 5 0 0 }\ncube", (mesh) => near(mesh.position.toArray(), [0, 0, 0]));
    withMesh("define move { translate 5 0 0 }\nmove\ncube", (mesh) => near(mesh.position.toArray(), [0, 0, 0]));
    // Symbols defined in a loop do not leak.
    assert.throws(() => objectsOf("for i in 1 to 2 { define k i }\ncube { size k }"), /Undefined variable: k/);
  });
  it("treats ranges as values: stored, re-stepped and looped over", () => {
    assert.equal(objectsOf("define r 1 to 5 step 2\nfor i in r { cube { position i 0 0 } }").length, 3);
    assert.equal(objectsOf("define r 1 to 5\nfor i in r step 4 { cube }").length, 2);
    assert.equal(objectsOf("for i in 5 to 1 step -2 { cube }").length, 3);
    assert.equal(objectsOf("for i in 0.2 to 2.2 { cube }").length, 3);
    assert.equal(objectsOf("for 1 to 3 { cube }").length, 3);
    withMesh("define r 2 to 4\nfor i in r { translate i 0 0 }\ncube", (mesh) => near(mesh.position.toArray(), [9, 0, 0]));
    assert.throws(() => objectsOf("define r 1 to 100000000\nfor i in r { cube }"), /iterations/);
  });
  it("supports the `in` operator on ranges, tuples and strings", () => {
    const yes = (condition: string) => assert.equal(objectsOf(`${condition} { cube }`).length, 1, condition);
    const no = (condition: string) => assert.equal(objectsOf(`${condition} { cube }`).length, 0, condition);
    yes("define r 1 to 5 step 2\nif 3 in r");
    no("define r 1 to 5 step 2\nif 2 in r");
    yes("define r 1 to 5\nif 2.5 in r");
    no("define r 1 to 5\nif 6 in r");
    yes("if 2 in (1 2 3)");
    no("if 4 in (1 2 3)");
    yes('if "b" in "abc"');
    yes("define c 1 0 0\nif (1 0 0) in (c (0 1 0))");
  });
  it("accepts bare function calls, which take every value that follows", () => {
    withMesh("cube { size max 1 2 }", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    withMesh("define a sqrt 9\ncube { size a }", (mesh) => near(extent(mesh).toArray(), [3, 3, 3]));
    withMesh("cube { size sin pi / 2 }", (mesh) => near(extent(mesh).toArray(), [1, 1, 1]));
    withMesh("translate (cos 0) 1\ncube", (mesh) => near(mesh.position.toArray(), [1, 1, 0]));
    withMesh("cube { size (sqrt 9) + (sqrt 16) }", (mesh) => near(extent(mesh).toArray(), [7, 7, 7]));
    withMesh("cube { size max(1 2) 3 }", (mesh) => near(extent(mesh).toArray(), [2, 3, 2]));
    // A `define` of the same name shadows the function — within its block only.
    withMesh("define max 5\ncube { size max }", (mesh) => near(extent(mesh).toArray(), [5, 5, 5]));
    withMesh("group { define max 5 }\ncube { size max 1 2 }", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    withMesh("define f(a) {\n define max a\n max\n}\ncube { size max 1 f(3) }", (mesh) => near(extent(mesh).toArray(), [3, 3, 3]));
    // Loop variables, block options and function parameters shadow too.
    withMesh("for sum in 2 to 2 { cube { size sum 1 1 } }", (mesh) => near(extent(mesh).toArray(), [2, 1, 1]));
    withMesh("define box {\n option max 2\n cube { size max 1 1 }\n}\nbox", (mesh) => near(extent(mesh).toArray(), [2, 1, 1]));
    withMesh("define f(max) { max 1 1 }\ncube { size f(2) }", (mesh) => near(extent(mesh).toArray(), [2, 1, 1]));
    withMesh("extrude path {\n for sum in 1 to 1 {\n point 0 0\n point sum 0\n point 0 sum\n point 0 0\n }\n}", (mesh) =>
      near(extent(mesh).toArray(), [1, 1, 1]),
    );
  });
  it("defines functions with parameters, local defines and a result", () => {
    withMesh("define sq(a) { a * a }\ncube { size sq(3) }", (mesh) => near(extent(mesh).toArray(), [9, 9, 9]));
    withMesh("define hyp(a b) {\n define s a * a + b * b\n sqrt s\n}\ncube { size hyp 3 4 }", (mesh) => near(extent(mesh).toArray(), [5, 5, 5]));
    withMesh("define degrees(r) { r / pi * 180 }\ncube { position degrees(pi) 0 0 }", (mesh) => near(mesh.position.toArray(), [180, 0, 0]));
    withMesh("define vec(a) { a 0 a }\ncube { position vec(2) }", (mesh) => near(mesh.position.toArray(), [2, 0, 2]));
    assert.throws(() => objectsOf("define sq(a) { a * a }\ncube { size sq(1 2) }"), /takes 1 argument/);
    assert.throws(() => objectsOf("define f(a) { f(a) }\ncube { size f(1) }"), /recursed/);
    withMesh("define f(a) { cube { size a } }\nf(2)", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    assert.throws(() => objectsOf("define f(a) { minkowski { cube } }\nf(1)"), /minkowski/);
  });
  it("evaluates a custom shape's call options in the caller's scope", () => {
    // `depth depth - 1` names the CALLER's `depth`. Read in the body's scope it
    // was the default instead, so a recursive shape never counted down.
    const tree = "define branch {\n option depth 1\n cube\n if depth > 0 {\n  branch { depth depth - 1 }\n }\n}\nbranch { depth 3 }";
    assert.equal(objectsOf(tree).filter((object) => (object as THREE.Mesh).isMesh).length, 4);
    // A default that names an outer symbol still sees it.
    withMesh("define w 3\ndefine box {\n option width w\n cube { size width 1 1 }\n}\nbox", (mesh) => near(extent(mesh).toArray(), [3, 1, 1]));
    // And one with no way out is a script error, not a JavaScript stack overflow.
    assert.throws(() => objectsOf("define forever {\n cube\n forever\n}\nforever"), /Custom shape `forever` recursed more than 256 levels/);
  });
  it("collects `print` output and stops on a failed `assert`", () => {
    assert.deepEqual(infoOf('print "size" 1 (2 3)\nprint 1 to 3\ncube').logs, ["size 1 (2 3)", "1 to 3 step 1"]);
    assert.equal(objectsOf("assert 1 = 1\ncube").length, 1);
    assert.throws(() => objectsOf("assert 1 = 2\ncube"), /Assertion failed/);
  });
  it("adds upstream's size, rotation and colour members, string subscripts and split", () => {
    withMesh("define s 1 2 3\ncube { size s.width s.height s.depth }", (mesh) => near(extent(mesh).toArray(), [1, 2, 3]));
    withMesh("define r 0.5 0.25 0\ncube { position r.roll r.yaw r.pitch }", (mesh) => near(mesh.position.toArray(), [0.5, 0.25, 0]));
    withMesh("define c 1 0 0\ncube { position c.alpha c.hue c.brightness }", (mesh) => near(mesh.position.toArray(), [1, 0, 1]));
    withMesh("define c 0 1 0\ncube { position c.hue c.saturation 0 }", (mesh) => near(mesh.position.toArray(), [1 / 3, 1, 0]));
    withMesh('define parts split "a,bb,ccc" ","\ncube { size parts.count parts.second.count parts[-1].count }', (mesh) =>
      near(extent(mesh).toArray(), [3, 2, 3]),
    );
  });
  it("refuses two statements on one line, as upstream does", () => {
    // Upstream reads a property's arguments to the end of the line, so these
    // would be `position` with five arguments there.
    for (const script of [
      "sphere { position 0 1 0 size 2 }",
      "color red cube",
      "polygon { color red point 0 0 0 point 1 0 0 point 0 1 0 }",
      "path { point 0 0 point 1 1 }",
      "cube { size 1 } sphere",
      "define post {\n option height 2 cylinder\n}",
      "post { height 3 size 1 }",
      'text {\n "Hi" size 0.5\n}',
      "extrude {\n square along circle\n}",
      "extrude {\n along circle square\n}",
      "fill path { position 0 0 1 size 2 point 0 0 point 1 0 point 0 1 }",
      "fill path {\n arc { angle 1 size 2 }\n}",
    ]) {
      assert.throws(() => objectsOf(script), /one statement per line/, script);
    }
    // One statement per line, a block's brace on the statement's line, and
    // `else` after the closing brace all pass; so does a statement after an
    // `if` whose block ended the previous line.
    assert.equal(objectsOf("if true { translate 0 1 0 }\ncube").length, 1);
    assert.equal(objectsOf("if false { cube } else { sphere }").length, 1);
    assert.equal(objectsOf("define c if true { 1 } else { 2 }\ncube { size c }").length, 1);
    assert.equal(objectsOf("cube { size 1 }\nsphere").length, 2);
  });
  it("has no `tau`, as upstream has none", () => {
    assert.throws(() => objectsOf("cube { size tau }"), /tau/);
    assert.equal(objectsOf("define tau 2 * pi\ncube { size tau }").length, 1);
  });
  it("names the upstream features it lacks", () => {
    for (const [script, message] of [
      ['import "other.shape"', /import/],
      ["define p path { point 0 0 point 1 1 }", /path.*value/],
      ['fill svgpath "M 0 0 L 1 0 L 0 1 z"', /svgpath/],
    ] as const) {
      assert.throws(() => objectsOf(script), message, script);
    }
  });
});

describe("shapes as values", () => {
  it("defines a shape as a value, reads its members and places it", () => {
    withMesh("define s sphere { size 2 }\ns", (mesh) => near(extent(mesh).toArray(), [2, 2, 2], 0.01));
    withMesh("define s cube { size 1 2 3 }\ncube { size s.bounds.size }", (mesh) => near(extent(mesh).toArray(), [1, 2, 3]));
    withMesh("define s cube {\n size 1 2 3\n}\ncube {\n position s.bounds.center\n size s.bounds.width s.bounds.height s.bounds.depth\n}", (mesh) =>
      near(extent(mesh).toArray(), [1, 2, 3]),
    );
    withMesh("define s cube\ncube { size s.volume s.triangles.count s.polygons.count }", (mesh) => near(extent(mesh).toArray(), [1, 12, 12]));
    withMesh("define s cube { position 1 0 0 }\ns { position 0 2 0 }", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.x, box.min.y], [0.5, 1.5]);
    });
    assert.throws(() => objectsOf("define f(a) { a }\nf 1"), /Unused value/);
    // A keyword the script has given a value keeps reading as that value.
    materialOf("define hull (0 0 1)\nsphere { color hull }", (m) => near(m.color.toArray(), [0, 0, 1]));
  });
  it("builds an icosphere in Euclid's face order, so face indices match upstream", () => {
    // Euclid's first face is v0, v11, v5 of its icosahedron; its centre lies
    // in the +Y half, tilted by the pitch Euclid applies.
    const t = 1 + Math.SQRT2 / 2;
    const scale = 1 / Math.sqrt(t * t + 1);
    const rotate = (p: [number, number, number]) => new THREE.Vector3(...p).multiplyScalar(scale).applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.atan(t));
    const expected = [rotate([-1, t, 0]), rotate([-t, 0, 1]), rotate([0, 1, t])].reduce((sum, v) => sum.add(v), new THREE.Vector3()).multiplyScalar(0.5 / 3);
    withMesh("define ico icosphere {\n detail 0\n}\ndefine c ico.polygons.first.center\ncube {\n position c\n size ico.polygons.count 1 1\n}", (mesh) => {
      near(mesh.position.toArray(), expected.toArray(), 1e-6);
      near(extent(mesh).toArray(), [20, 1, 1]);
    });
  });
  it("evaluates `for` and `if` as expressions", () => {
    withMesh("define scales for i in 1 to 3 { i / 3 }\ncube { size scales }", (mesh) => near(extent(mesh).toArray(), [1 / 3, 2 / 3, 1]));
    withMesh("define pts for p in ((1 2) (3 4)) { p.x + p.y }\ncube { size pts.first pts.last 1 }", (mesh) => near(extent(mesh).toArray(), [3, 7, 1]));
    withMesh("define big true\ndefine s if big { 3 } else { 1 }\ncube { size s }", (mesh) => near(extent(mesh).toArray(), [3, 3, 3]));
    withMesh("define n 2\ndefine s if n = 1 { 1 } else if n = 2 { 2 } else { 3 }\ncube { size s }", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    assert.throws(() => objectsOf("define s if false { 1 }\ncube { size s }"), /needs an `else`/);
  });
  it("makes a face from `polygon { point … }` and a mesh from `mesh { … }`", () => {
    withMesh("polygon {\n point 0 0 0\n point 1 0 0\n point 1 1 0\n point 0 1 0\n}", (mesh) => {
      near(extent(mesh).toArray(), [1, 1, 0]);
      assert.equal(mesh.geometry.getAttribute("position").count, 6);
    });
    // A tetrahedron from four coloured faces, one vertex-coloured mesh.
    const tetra = `mesh {
  define a (0 0 0)
  define b (1 0 0)
  define c (0 1 0)
  define d (0 0 1)
  polygon {
    color red
    point a
    point c
    point b
  }
  polygon {
    color green
    point a
    point b
    point d
  }
  polygon {
    color blue
    point a
    point d
    point c
  }
  polygon {
    point b
    point c
    point d
  }
}`;
    materialOf(tetra, (m, mesh) => {
      assert.equal(mesh.geometry.getAttribute("position").count, 12);
      assert.ok(mesh.geometry.hasAttribute("color"));
      assert.equal(m.vertexColors, true);
      near([Math.abs(volume(mesh))], [1 / 6], 1e-6);
    });
    withMesh(
      "define s mesh {\n polygon {\n  point 0 0 0\n  point 1 0 0\n  point 0 1 0\n }\n}\ncube { size s.polygons.count s.polygons.first.center.x 1 }",
      (mesh) => near(extent(mesh).toArray(), [1, 1 / 3, 1]),
    );
    // A transform inside the block moves the polygons that follow it.
    withMesh("mesh {\n translate 1 0 0\n polygon {\n  point 0 0 0\n  point 1 0 0\n  point 0 1 0\n }\n}", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.x, box.max.x], [1, 2]);
    });
    withMesh("define tri {\n polygon {\n  point 0 0 0\n  point 1 0 0\n  point 0 1 0\n }\n}\nmesh {\n translate 0 0 3\n tri\n}", (mesh) =>
      near([new THREE.Box3().setFromObject(mesh).min.z], [3]),
    );
    assert.throws(() => objectsOf("polygon {\n point 0 0\n point 1 0\n}"), /three points/);
    assert.throws(() => objectsOf("mesh { }"), /at least one polygon/);
  });
  it("lets a function build shapes, and a bare call place or contribute them", () => {
    withMesh("define box(s) { cube { size s } }\nbox 2", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    withMesh("define tri(z) {\n polygon {\n  point 0 0 z\n  point 1 0 z\n  point 0 1 z\n }\n}\nmesh {\n for z in 0 to 1 {\n  tri z\n }\n}", (mesh) => {
      near(extent(mesh).toArray(), [1, 1, 1]);
      assert.equal(mesh.geometry.getAttribute("position").count, 6);
    });
    withMesh(
      "define pair {\n cube {\n  position -1\n }\n cube {\n  position 1\n }\n}\ndefine both(s) {\n pair\n}\ncube {\n size both(1).count 1 1\n}",
      (mesh) => near(extent(mesh).toArray(), [2, 1, 1]),
    );
    assert.throws(() => objectsOf("define nothing(a) { define b a }\nnothing 1"), /returns nothing|produced no value/);
  });
  it("keeps a mesh block's faces as its polygons, places a point polygon, and bounds `for` expressions", () => {
    withMesh(
      "define s mesh {\n polygon {\n  point 0 0 0\n  point 1 0 0\n  point 1 1 0\n  point 0 1 0\n }\n}\ncube { size s.polygons.count s.triangles.count s.polygons.first.triangles.count }",
      (mesh) => near(extent(mesh).toArray(), [1, 2, 2]),
    );
    // A point's first coordinate is evaluated once, so `rnd` advances once per point.
    withMesh("seed 1\npolygon {\n point rnd 0 0\n point 1 0 0\n point 0 1 0\n}", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.x], [0]);
    });
    withMesh("polygon {\n position 5 0 0\n size 2\n point 0 0\n point 1 0\n point 0 1\n}", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.x, box.max.x, box.max.y], [5, 7, 2]);
    });
    assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript("define v for i in 1 to 3 { i }\ncube"), { maxLoopIterations: 2 })), /iterations/);
  });
  it("lets a function end in `if`, `for` or a bare symbol, and treats keyword-named bindings as values", () => {
    withMesh("define choose(x) { if x { 1 } else { 2 } }\ncube { size choose(true) choose(false) 1 }", (mesh) => near(extent(mesh).toArray(), [1, 2, 1]));
    withMesh("define sc(n) { for i in 1 to n { i / n } }\ncube { size sc(2) }", (mesh) => near(extent(mesh).toArray(), [0.5, 1, 0.5]));
    withMesh("define last(v) {\n define l v.last\n l\n}\ncube { size last((1 2 3)) }", (mesh) => near(extent(mesh).toArray(), [3, 3, 3]));
    withMesh("define f(cube) { cube }\ncube { size f(3) }", (mesh) => near(extent(mesh).toArray(), [3, 3, 3]));
    withMesh("define b {\n option sphere 2\n cube { size sphere }\n}\nb", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    withMesh("for cone in 2 to 2 { cube { size cone } }", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
    withMesh("define f(if) { if }\nfor point in 1 to 1 { cube { size f(3) point 1 } }", (mesh) => near(extent(mesh).toArray(), [3, 1, 1]));
    // Retained shape values count against the vertex budget.
    assert.throws(
      () => disposeObject3D(astToThreeJS(parseShapeScript("for i in 1 to 100 { define s sphere { detail 64 } }\ncube"), { maxVertices: 50000 })),
      /vertices/,
    );
  });
  it("accepts line breaks inside parentheses", () => {
    withMesh("cube { size (1\n + 2) }", (mesh) => near(extent(mesh).toArray(), [3, 3, 3]));
    withMesh("define rows (\n(1 2 3)\n(4 5 6)\n)\ncube {\n position rows.first\n size rows.last\n}", (mesh) => {
      near(mesh.position.toArray(), [1, 2, 3]);
      near(extent(mesh).toArray(), [4, 5, 6]);
    });
    withMesh("cube { size max(\n 1\n 2\n) }", (mesh) => near(extent(mesh).toArray(), [2, 2, 2]));
  });
});

describe("minkowski, inset and extrude along", () => {
  it("sums two convex solids into one hull that keeps the first one's colour", () => {
    withMesh("minkowski {\n cube { color 1 0 0 }\n sphere { size 1 }\n}", (mesh) => {
      near(extent(mesh).toArray(), [2, 2, 2], 0.01);
      assert.ok(volume(mesh) > 1 && volume(mesh) < 8, `volume ${volume(mesh)}`);
      assert.ok(mesh.geometry.hasAttribute("color"));
      const color = mesh.geometry.getAttribute("color");
      near([color.getX(0), color.getY(0), color.getZ(0)], [1, 0, 0]);
      assert.equal((mesh.material as THREE.MeshStandardMaterial).vertexColors, true);
    });
    withMesh("minkowski {\n cube\n cube { size 0.5 }\n}", (mesh) => {
      near(extent(mesh).toArray(), [1.5, 1.5, 1.5], 1e-4);
      near([volume(mesh)], [1.5 ** 3], 1e-4);
      assert.equal(mesh.geometry.hasAttribute("color"), false);
    });
    // Per-face colours cannot follow the sum's new vertices: a mesh whose
    // vertices differ gives an uncoloured result; one colour throughout is kept.
    const tetra = (colors: readonly string[]) =>
      `mesh {\n polygon {\n  color ${colors[0]}\n  point 0 0 0\n  point 1 0 0\n  point 0 1 0\n }\n polygon {\n  color ${colors[1]}\n  point 0 0 0\n  point 0 0 1\n  point 1 0 0\n }\n polygon {\n  color ${colors[2]}\n  point 0 0 0\n  point 0 1 0\n  point 0 0 1\n }\n polygon {\n  color ${colors[3]}\n  point 1 0 0\n  point 0 0 1\n  point 0 1 0\n }\n}`;
    withMesh(`minkowski {\n ${tetra(["1 0 0", "0 1 0", "0 0 1", "1 1 0"])}\n cube { size 0.5 }\n}`, (mesh) => {
      near(extent(mesh).toArray(), [1.5, 1.5, 1.5], 1e-4);
      assert.equal(mesh.geometry.hasAttribute("color"), false);
    });
    withMesh(`minkowski {\n ${tetra(["0 1 0", "0 1 0", "0 1 0", "0 1 0"])}\n cube { size 0.5 }\n}`, (mesh) => {
      const color = mesh.geometry.getAttribute("color");
      near([color.getX(0), color.getY(0), color.getZ(0)], [0, 1, 0]);
    });
    // Degeneracy is judged at the shapes' own scale: tiny solids still sum.
    withMesh("minkowski {\n cube { size 0.00001 }\n cube { size 0.00001 }\n}", (mesh) => near(extent(mesh).toArray(), [2e-5, 2e-5, 2e-5], 1e-9));
    // A mirrored operand is still convex: one hull, not per-face pieces.
    withMesh("minkowski {\n cube { size -1 1 1 }\n cube { size 0.5 }\n}", (mesh) => {
      near([volume(mesh)], [1.5 ** 3], 1e-4);
      assert.ok(mesh.geometry.getAttribute("position").count < 100, `${mesh.geometry.getAttribute("position").count} vertices`);
    });
  });
  it("sums a non-convex solid face by face", () => {
    withMesh("minkowski {\n difference {\n  cube\n  cube { size 0.4 2 0.4 }\n }\n sphere { size 0.2 }\n}", (mesh) => {
      near(extent(mesh).toArray(), [1.2, 1.2, 1.2], 0.01);
    });
    // Two non-convex operands: an L-shaped prism summed with itself has
    // parallel faces whose sums are flat; those pairs are skipped, the rest
    // merge into a solid with finite normals and the expected extent.
    const L = "extrude path {\n point 0 0\n point 2 0\n point 2 1\n point 1 1\n point 1 2\n point 0 2\n point 0 0\n}";
    withMesh(`minkowski {\n ${L}\n ${L}\n}`, (mesh) => {
      near(extent(mesh).toArray(), [4, 4, 2], 1e-4);
      const normal = mesh.geometry.getAttribute("normal");
      for (let i = 0; i < normal.count; i++) assert.ok(Number.isFinite(normal.getX(i)) && Number.isFinite(normal.getY(i)), `normal ${i}`);
    });
    assert.throws(() => objectsOf("minkowski { cube }"), /at least two/);
    assert.throws(() => objectsOf("minkowski {\n cube\n path {\n  point 0 0\n  point 1 0\n }\n}"), /at least two/);
  });
  it("insets a mesh value along its faces, exactly at corners", () => {
    withMesh("define c cube\ninset(c 0.1)", (mesh) => near(extent(mesh).toArray(), [0.8, 0.8, 0.8], 1e-5));
    withMesh("define c cube\ninset(c -0.1)", (mesh) => near(extent(mesh).toArray(), [1.2, 1.2, 1.2], 1e-5));
    // A cone's apex slides down to where the inset sides meet: 0.1 / cos(63.4°) below it.
    withMesh("define k cone\ninset(k 0.1)", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.max.y, box.min.y], [0.5 - 0.1 * Math.sqrt(5), -0.4], 1e-3);
    });
    // A boolean leaves T-junctions: the face a seam split has vertices along
    // the cube's edges that the neighbouring face's triangles do not share.
    // Those vertices belong to both faces and move with both, so the inset
    // of the union is inset on every axis and nothing stands proud.
    withMesh("define s union {\n cube\n cylinder {\n  size 0.45 1.2 0.45\n  orientation 0.5\n  position 0.45\n }\n}\ninset(s 0.06)", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z], [-0.44, -0.44, -0.44, 0.99, 0.44, 0.44], 1e-3);
    });
    // A mirrored mesh winds inward; inset still moves its faces inward.
    withMesh("define c cube { size -1 1 1 }\ninset(c 0.1)", (mesh) => near(extent(mesh).toArray(), [0.8, 0.8, 0.8], 1e-5));
    assert.throws(() => objectsOf("inset(1 2)"), /mesh/);
    assert.throws(() => objectsOf("define c cube\ninset(c 1 / 0)"), /finite/);
    // A value's geometry is released once the conversion is over; the scene
    // holds its own clone.
    {
      const disposed = new Set<THREE.BufferGeometry>();
      const original = THREE.BufferGeometry.prototype.dispose;
      THREE.BufferGeometry.prototype.dispose = function (this: THREE.BufferGeometry) {
        disposed.add(this);
        return original.call(this);
      };
      let group: THREE.Group;
      try {
        group = astToThreeJS(parseShapeScript("define c cube\ndefine d inset(c 0.1)\nd"));
      } finally {
        THREE.BufferGeometry.prototype.dispose = original;
      }
      let placed: THREE.Mesh | undefined;
      group.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) placed = object as THREE.Mesh;
      });
      // The cube value and the inset value were released; the scene's clone was not.
      assert.ok(disposed.size >= 2, `${disposed.size} disposed`);
      assert.equal(disposed.has(placed!.geometry), false);
      disposeObject3D(group);
    }
    // A mesh value captured under a transform is a fresh clone: charged past
    // the scratch refund and released with the other values.
    {
      const script = "define big sphere { detail 16 }\ndefine f() {\n translate 1\n big\n}\nf()";
      // The body's transform places the shape it ends with.
      withMesh(script, (mesh) => near([new THREE.Box3().setFromObject(mesh).min.x], [0.5], 0.01));
      const vertices = 16 * 16 * 6; // one sphere at detail 16, as a value (non-indexed)
      // The value, its transformed capture and the placed copy: three charges, not two.
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(script), { maxVertices: vertices * 2.5 })), /vertices/);
      disposeObject3D(astToThreeJS(parseShapeScript(script), { maxVertices: vertices * 3.5 }));
    }
    // Every inset result is a retained allocation, charged against the budget.
    assert.throws(
      () => disposeObject3D(astToThreeJS(parseShapeScript("define c cube\ndefine d inset(c 0.1)\ndefine e inset(d 0.1)\ncube"), { maxVertices: 60 })),
      /vertices/,
    );
  });
  it("keeps the colour a shape value was given and takes the scope's colour otherwise", () => {
    withMesh("define c cone { color 1 0 0 }\ncolor 0 0 1\nc", (mesh) => {
      const color = mesh.geometry.getAttribute("color");
      near([color.getX(0), color.getY(0), color.getZ(0)], [1, 0, 0]);
    });
    withMesh("define c cone\ncolor 0 0 1\nc", (mesh) => {
      assert.equal(mesh.geometry.hasAttribute("color"), false);
      near((mesh.material as THREE.MeshStandardMaterial).color.toArray(), [0, 0, 1]);
    });
  });
  it("extrudes an open path into a two-sided wall", () => {
    withMesh("extrude {\n size 1 1 0.5\n path {\n  point 0 0\n  point 2 0\n }\n}", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.x, box.max.x, box.min.z, box.max.z], [0, 2, -0.25, 0.25]);
      assert.equal(mesh.geometry.getAttribute("position").count, 8);
      near([volume(mesh)], [0]);
    });
    withMesh("define w {\n path {\n  point 0 0\n  point 0 1\n }\n}\nextrude {\n size 1 1 0.2\n w\n}", (mesh) => near(extent(mesh).toArray(), [0, 1, 0.2]));
    assert.throws(() => objectsOf("extrude { path { point 0 0 } }"), /at least two/);
  });
  it("reads a lone `position` value as X alone, on shapes, builders and groups", () => {
    for (const script of [
      "cube { position 1 }",
      "extrude {\n position 1\n square\n}",
      "group { position 1\n cube }",
      "extrude {\n position 1\n square\n along path {\n  point 0 0\n  point 0 1\n }\n}",
    ]) {
      withMesh(script, (mesh) => {
        const box = new THREE.Box3().setFromObject(mesh);
        near([box.min.x, box.max.x], [0.5, 1.5], 0.01);
        assert.ok(box.max.y <= 1.01 && box.min.y >= -0.51 && box.max.z <= 0.51, `${script}: ${box.min.toArray()} ${box.max.toArray()}`);
      });
    }
  });
  it("reads `detail` as a value, scopes it to a path, and draws curves as corners at `detail 0`", () => {
    withMesh("cube { size detail / 32 }", (mesh) => near(extent(mesh).toArray(), [1, 1, 1]));
    const corners = objectsOf("path {\n detail 0\n curve 0 0\n curve 1 0\n curve 1 1\n}")[0] as THREE.Line;
    assert.equal(corners.geometry.getAttribute("position").count, 3);
    const smooth = objectsOf("path {\n curve 0 0\n curve 1 0\n curve 1 1\n}")[0] as THREE.Line;
    assert.ok(smooth.geometry.getAttribute("position").count > 3);
    const [, sphere] = objectsOf("path {\n detail 4\n point 0 0\n point 1 0\n}\nsphere") as [THREE.Line, THREE.Mesh];
    const [plain] = objectsOf("sphere") as [THREE.Mesh];
    assert.equal(sphere.geometry.getAttribute("position").count, plain.geometry.getAttribute("position").count);
  });
  it("sweeps a section along a path with `along`", () => {
    withMesh("extrude {\n circle {\n  size 0.2\n }\n along path {\n  point 0 0\n  point 0 2\n }\n}", (mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      near([box.min.x, box.max.x, box.min.y, box.max.y, box.min.z, box.max.z], [-0.1, 0.1, 0, 2, -0.1, 0.1], 1e-5);
      near([volume(mesh)], [16 * 0.01 * Math.sin(Math.PI / 16) * 2], 1e-4);
    });
    // Points closer than the coordinate tolerance merge; a short real segment does not.
    withMesh("extrude {\n square {\n  size 0.1\n }\n along path {\n  point 0 0\n  point 0.00001 0\n }\n}", (mesh) => near([extent(mesh).x], [0.00001], 1e-7));
    // A closed path sweeps a ring with no caps; `size` scales the whole result.
    withMesh("extrude {\n size 2 1 1\n square { size 0.2 }\n along circle { size 2 }\n}", (mesh) => {
      near(extent(mesh).toArray(), [4.4, 2.2, 0.2], 0.01);
      // The geometry itself (before `size`): a 0.2 square around a circumference of 2π.
      assert.ok(volume(mesh) > 0.24 && volume(mesh) < 0.26, `volume ${volume(mesh)}`);
    });
    for (const [script, message] of [
      ["extrude {\n square\n along path {\n  point 0 0\n  point 1 1\n }\n along circle\n}", /one `along`/],
      ["loft {\n square\n along circle\n}", /only valid inside `extrude`/],
      ["extrude { along circle }", /needs a planar section/],
      ["extrude {\n square\n along\n}", /needs a path/],
      ["extrude {\n square\n along cube\n}", /XY plane|exactly one path|closed perimeter/],
    ] as const) {
      assert.throws(() => objectsOf(script), message, script);
    }
  });
});

describe("text", () => {
  // Helvetica's cap height at point size 1, the face upstream sets text in.
  const CAP = 0.718;
  function boxOf(object: THREE.Object3D): THREE.Box3 {
    object.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(object);
  }
  function faceArea(mesh: THREE.Mesh): number {
    const p = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex();
    let area = 0;
    for (let i = 0; i < (index?.count ?? p.count); i += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(p, index ? index.getX(i + j) : i + j));
      area += new THREE.Vector3().crossVectors(b!.clone().sub(a!), c!.clone().sub(a!)).length() / 2;
    }
    return area;
  }
  it("lays glyphs out from the left margin and baseline at upstream's size", () => {
    // In the scene, text is its outlines; a capital is CAP tall, starting at x = 0 on y = 0.
    const [outline] = objectsOf('text "H"') as [THREE.LineSegments];
    assert.ok(outline.isLineSegments);
    const box = boxOf(outline);
    near([box.min.x, box.min.y, box.max.y, box.max.z], [0, 0, CAP, 0], 0.01);
    withMesh('fill text "H"', (mesh) => near([boxOf(mesh).min.x, boxOf(mesh).min.y, boxOf(mesh).max.y], [0, 0, CAP], 0.01));
    // `size` scales the line height, in one or two dimensions.
    withMesh('fill text {\n size 0.5\n "H"\n}', (mesh) => near([extent(mesh).y], [CAP / 2], 0.01));
    withMesh('fill text {\n size 2 0.5\n "H"\n}', (mesh) => near([extent(mesh).y, boxOf(mesh).min.x], [CAP / 2, 0], 0.01));
    // A wider string is wider; `position` and the current material apply.
    const [hello] = objectsOf('fill text "Hello"') as [THREE.Mesh];
    assert.ok(extent(hello).x > 2 && extent(hello).x < 2.5, `width ${extent(hello).x}`);
    withMesh('color red\nfill text {\n position 2 1\n "H"\n}', (mesh) => {
      near([boxOf(mesh).min.x, boxOf(mesh).min.y], [2, 1], 0.01);
      near((mesh.material as THREE.MeshStandardMaterial).color.toArray(), [1, 0, 0]);
    });
  });
  it("interpolates values as upstream does", () => {
    const widthOf = (script: string) => extent(objectsOf(script)[0] as THREE.Mesh).x;
    // Non-text values are spaced out; an empty string between them removes the space.
    assert.ok(widthOf("fill text 1 2 3") > widthOf('fill text 1 "" 2 "" 3'));
    near([widthOf('fill text 1 "" 2 "" 3')], [widthOf('fill text "123"')], 1e-6);
    near([widthOf('define apples 5\nfill text "Bob has " apples " apples"')], [widthOf('fill text "Bob has 5 apples"')], 1e-6);
    near([widthOf("fill text 2 * 3")], [widthOf('fill text "6"')], 1e-6);
    // `extrude text i` makes one solid per number.
    assert.equal(objectsOf("for i in 1 to 5 {\n extrude text i\n translate 1\n}").length, 5);
  });
  it("breaks, spaces and wraps lines one unit apart", () => {
    const [two] = objectsOf('text {\n "H"\n "H"\n}');
    near([boxOf(two!).min.y, boxOf(two!).max.y], [-1, CAP], 0.01);
    const [escaped] = objectsOf('text "H\\nH"');
    near([boxOf(escaped!).min.y], [-1], 0.01);
    const [spaced] = objectsOf('text {\n linespacing 0.5\n "H"\n "H"\n}');
    near([boxOf(spaced!).min.y], [-1.5], 0.01);
    const [tight] = objectsOf('text {\n linespacing -0.5\n "H"\n "H"\n}');
    near([boxOf(tight!).min.y], [-0.5], 0.01);
    // `wrapwidth` is in world units: "H H H" is wider than one unit, so three lines.
    const [wrapped] = objectsOf('text {\n wrapwidth 1\n "H H H"\n}');
    near([boxOf(wrapped!).min.y], [-2], 0.01);
    assert.throws(() => objectsOf('text {\n wrapwidth 0\n "H"\n}'), /wrapwidth/);
  });
  it("fills and extrudes letters with their counters", () => {
    // An "o" is a ring: it covers well under half of its box; a "1" has no hole.
    withMesh('fill text "o"', (mesh) => assert.ok(faceArea(mesh) < 0.5 * extent(mesh).x * extent(mesh).y, `area ${faceArea(mesh)}`));
    withMesh('fill text "1"', (mesh) => assert.ok(faceArea(mesh) > 0.1 * extent(mesh).x * extent(mesh).y));
    withMesh('extrude {\n size 1 1 0.2\n text "o"\n}', (mesh) => {
      near([extent(mesh).z], [0.2], 1e-6);
      assert.ok(volume(mesh) > 0 && volume(mesh) < 0.5 * 0.2 * extent(mesh).x * extent(mesh).y, `volume ${volume(mesh)}`);
    });
    // Many letters in one builder: one mesh, one shape per glyph.
    withMesh('fill text "Hello, World!"', (mesh) => assert.ok(extent(mesh).x > 5));
  });
  it("is a value with bounds, and a function may return one", () => {
    // Upstream's recipe for centring text (exact for glyphs that sit on the baseline).
    withMesh('define hello text "HILL"\ntranslate -hello.bounds.width/2 -hello.bounds.height/2\nfill hello', (mesh) => {
      const box = boxOf(mesh);
      near([box.min.x + box.max.x, box.min.y + box.max.y], [0, 0], 1e-6);
    });
    // A parameter spelled like a property (`name`) on its own line is a line of text.
    withMesh('define label(name) {\n text {\n  size 0.18\n  name\n }\n}\nfill label("Cube")', (mesh) => near([extent(mesh).y], [CAP * 0.18], 0.01));
    withMesh('define label(name) {\n text {\n  size 0.18\n  name\n }\n}\ntranslate -label("Cube").bounds.width/2 0\nfill label("Cube")', (mesh) => {
      const box = boxOf(mesh);
      near([box.min.x + box.max.x], [0], 1e-6);
    });
    // A `name` property still names the object when nothing binds `name`.
    assert.equal(objectsOf('text {\n name "caption"\n "H"\n}')[0]!.name, "caption");
    // Outline text takes its own material, as a filled one does.
    const outlineMaterial = (script: string) => (objectsOf(script)[0] as THREE.LineSegments).material as THREE.LineBasicMaterial;
    near([outlineMaterial('text {\n opacity 0.2\n "H"\n}').opacity], [0.2]);
    near([outlineMaterial('text {\n color 1 0 0 0.5\n "H"\n}').opacity], [0.5]);
    near(outlineMaterial('define ink material { color 0 0 1 }\ntext {\n material ink\n "H"\n}').color.toArray(), [0, 0, 1]);
    // The outline's two vertices per point count against the budget.
    assert.throws(() => astToThreeJS(parseShapeScript('text "H"'), { maxVertices: 20 }), /vertices/);
  });
  it("keeps the built-in font, substitutes missing glyphs and bounds the text", () => {
    assert.match(infoOf('font "Zapfino"\nfill text "Hi"').warnings[0]!, /font/);
    assert.match(infoOf('fill text {\n font "Zapfino"\n "Hi"\n}').warnings[0]!, /font/);
    assert.deepEqual(infoOf('define font 1\nfill text "Hi"\ncube { size font }').warnings, []);
    // Symbols are case-sensitive: a differently-spelled one is a line of text, not an option.
    assert.equal(objectsOf('define WrapWidth "W"\ntext {\n WrapWidth\n}').length, 1);
    assert.equal(objectsOf('define Font "F"\ntext {\n Font\n}').length, 1);
    assert.match(infoOf('fill text "日本"').warnings[0]!, /"日" "本".*\?/);
    assert.equal(objectsOf('text "   "').length, 0);
    assert.throws(() => objectsOf('fill text "   "'), /Fill requires/);
    assert.throws(() => objectsOf(`fill text "${"x".repeat(2001)}"`), /2000 characters/);
    assert.throws(() => objectsOf("text"), /needs a string/);
  });
});
