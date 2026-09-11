import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { parseShapeScript } from "../src/shapescript/parser";
import { astToThreeJS, sceneInfoOf } from "../src/shapescript/toThreeJS";
import { disposeObject3D } from "../src/shapescript/dispose";

// The upstream project's own Examples, unmodified (see the LICENSE.md beside
// them). Each is either rendered here or refused with a message that names
// the upstream feature this renderer lacks — never a parse error on a brace.
const FIXTURES = join(import.meta.dirname, "fixtures", "upstream-examples");

interface Rendered {
  objects: number;
  /** The scene's extent, to catch a transform rule going wrong (a chessboard
   *  whose pieces march off the board) rather than a script merely running. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  warnings: RegExp[];
}

const RENDERS: Record<string, Rendered> = {
  // A stencil of a sphere, a cube and an extruded star: one mesh.
  "Ball.shape": { objects: 1, bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, warnings: [/camera/] },
  // The board is 8.8 wide; every piece stands on it. `translate` inside the
  // `for` loops carries on after them, which is what keeps the pieces on it.
  "Chessboard.shape": { objects: 33, bounds: { min: [-4.4, -0.2, -4.4], max: [4.4, 1.42, 4.4] }, warnings: [/camera/] },
  // Extrusions are centred on their profile plane, as upstream: ±0.25 for a 0.5 depth.
  "Cog.shape": { objects: 1, bounds: { min: [-1, -1, -0.25], max: [1, 1, 0.25] }, warnings: [/camera/] },
  // The sphere draws; its texture and the background image are reported.
  "Earth.shape": { objects: 1, bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, warnings: [/background image "Stars.jpg"/, /texture "Earth.png"/] },
  "Spring.shape": { objects: 1, bounds: { min: [-0.55, -0.65, -0.55], max: [0.55, 0.65, 0.55] }, warnings: [] },
  "Train.shape": { objects: 14, bounds: { min: [-0.6, -0.42, -1.12], max: [0.6, 1.53, 1.15] }, warnings: [/camera/] },
};

const REFUSED: Record<string, RegExp> = {
  "Dodecahedron.shape": /a shape as a value.*not supported/,
  "Fillet.shape": /minkowski.*not supported/,
  "Spirals.shape": /along.*not supported/,
};

describe("upstream example scripts", () => {
  const files = readdirSync(FIXTURES).filter((file) => file.endsWith(".shape"));
  it("covers every fixture", () => {
    assert.deepEqual(files.sort(), [...Object.keys(RENDERS), ...Object.keys(REFUSED)].sort());
  });

  for (const [file, expected] of Object.entries(RENDERS)) {
    it(`renders ${file}`, () => {
      const group = astToThreeJS(parseShapeScript(readFileSync(join(FIXTURES, file), "utf8")));
      try {
        let objects = 0;
        group.traverse((object) => {
          if ((object as THREE.Mesh).isMesh || (object as THREE.Line).isLine) objects++;
        });
        assert.equal(objects, expected.objects);
        const box = new THREE.Box3().setFromObject(group);
        for (const [axis, index] of [
          ["x", 0],
          ["y", 1],
          ["z", 2],
        ] as const) {
          assert.ok(Math.abs(box.min[axis] - expected.bounds.min[index]) < 0.01, `${file} min ${axis}: ${box.min[axis]}`);
          assert.ok(Math.abs(box.max[axis] - expected.bounds.max[index]) < 0.01, `${file} max ${axis}: ${box.max[axis]}`);
        }
        const { warnings } = sceneInfoOf(group);
        assert.equal(warnings.length, expected.warnings.length, warnings.join("; "));
        expected.warnings.forEach((pattern, i) => assert.match(warnings[i]!, pattern));
      } finally {
        disposeObject3D(group);
      }
    });
  }

  for (const [file, message] of Object.entries(REFUSED)) {
    it(`refuses ${file} by naming the missing feature`, () => {
      assert.throws(() => disposeObject3D(astToThreeJS(parseShapeScript(readFileSync(join(FIXTURES, file), "utf8")))), message);
    });
  }
});
