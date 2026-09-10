import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { loftGeometry, profileOf } from "./builders";
import { Brush, Evaluator as CSGEvaluator, ADDITION, SUBTRACTION, INTERSECTION, HOLLOW_SUBTRACTION, HOLLOW_INTERSECTION } from "three-bvh-csg";
import {
  SceneNode,
  ShapeNode,
  CSGNode,
  ForLoopNode,
  IfNode,
  SwitchNode,
  DefineNode,
  ExtrudeNode,
  LatheNode,
  LoftNode,
  FillNode,
  HullNode,
  DetailNode,
  PathNode,
  PathCommand,
  PointCommand,
  CurveCommand,
  ForLoopPathCommand,
  CustomShapeNode,
  ColorNode,
  RotateNode,
  OrientationNode,
  TranslateNode,
  ScaleNode,
  Expression,
  Vector3,
  Color,
  ShapeProperties,
} from "./types";
import { Evaluator, SymbolTable, Value } from "./evaluator";
import { disposeObject3D, disposeScratch } from "./dispose";

/** A path point in path space, after the path's local transform. */
interface PathPoint {
  x: number;
  y: number;
  curved: boolean;
}

const PATH_POINT_EPSILON = 1e-9;

function samePathPoint(a: PathPoint, b: PathPoint): boolean {
  return Math.abs(a.x - b.x) < PATH_POINT_EPSILON && Math.abs(a.y - b.y) < PATH_POINT_EPSILON;
}

function midPathPoint(a: PathPoint, b: PathPoint): PathPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, curved: false };
}

export interface ConversionOptions {
  wireframe?: boolean;
  /** Hard ceiling on the objects one script may produce. See
   *  `DEFAULT_MAX_NODES`. */
  maxNodes?: number;
  /** Hard ceiling on the iterations one `for` may run. See
   *  `DEFAULT_MAX_LOOP_ITERATIONS`. */
  maxLoopIterations?: number;
  /** Hard ceiling on the vertices one script may allocate in total. See
   *  `DEFAULT_MAX_VERTICES`. */
  maxVertices?: number;
  /** Hard ceiling on the wall-clock time one conversion may spend. See
   *  `DEFAULT_MAX_DURATION_MS`. */
  maxDurationMs?: number;
  /** Starting seed for `rnd` / `rand()`, which a `seed` command in the script
   *  overrides. Defaults to `DEFAULT_RANDOM_SEED`, which is what keeps server
   *  validation and browser rendering on the same branch. */
  randomSeed?: number;
}

// Conversion runs synchronously on the browser's main thread, and the script is
// LLM-authored — a stray `for i in 1 to 100000000` is a plausible accident, not
// only an attack. Without a ceiling that call allocates until the tab dies, and
// the user cannot even read the error because nothing yields. Both limits are
// far above any legible model (the shipped samples peak in the dozens) and far
// below what hurts: 100k meshes render, 100M do not.
//
// Raised from 20k: measured, that ceiling was the FIRST one a grid-shaped model
// hit, and it hit it early — a 150x150 array of cubes was refused at ~540k
// vertices, barely a quarter of the vertex budget, so the two ceilings
// disagreed about how big a model is allowed to be.
export const DEFAULT_MAX_NODES = 100_000;
export const DEFAULT_MAX_LOOP_ITERATIONS = 100_000;

// `detail` is a smoothing hint that becomes a SEGMENT COUNT on every curved
// primitive, and a sphere is segments², so `detail 100000` asks for 10^10
// vertices from a single valid statement — outside both budgets above, since it
// is one node in one loop-free script. Clamped rather than refused: it is a
// hint, and rounding an absurd one down still draws the model the author meant.
// 256 segments is already smoother than any viewport resolves; 3 is the least
// that closes a surface.
export const MIN_DETAIL = 3;
export const MAX_DETAIL = 256;

// The node and detail caps bound each factor but not their PRODUCT: 20k spheres
// at the maximum detail is ~10^9 vertices, and a position alone is 12 bytes
// before normals and UVs — tens of gigabytes, allocated synchronously, from a
// script that satisfies every other budget. This is the aggregate ceiling.
// 5M vertices is a heavy scene that still renders; an order more does not.
// It is also the budget that decides how SMOOTH a model may be rather than how
// large: at `detail 64` a sphere is ~2.1k vertices, so this is roughly 2,300 of
// them.
export const DEFAULT_MAX_VERTICES = 5_000_000;

// The counting budgets bound what a script ALLOCATES, not how long it takes to
// get there: CSG is superlinear in its operands, so a script well inside every
// ceiling above can still occupy the thread for minutes — the browser's, or the
// server's when `presentShapeScript` validates before returning. Checked
// between nodes, so it is coarse by construction: it cannot interrupt one long
// boolean, only refuse to start the next. Generous enough that no legible model
// reaches it (the shipped samples convert in milliseconds).
//
// In practice this is the CSG budget and nothing else: 240k vertices of plain
// geometry converts in ~95 ms, while 100 boolean subtractions take 5.3 s. 10 s
// left almost no room for the second kind, so it is 30 s — still a bounded wait
// for the agent's tool call, and still short of the plugin bridge's own
// timeout.
export const DEFAULT_MAX_DURATION_MS = 30_000;

// `ShapeGeometry`'s own default when no `curveSegments` is passed. Named here
// because the pre-flight estimate has to predict what the constructor will do.
const SHAPE_GEOMETRY_CURVE_SEGMENTS = 12;

// An extruded profile becomes two caps plus the wall ring between them, so it
// costs a few vertices per profile point rather than one. Deliberately a rough
// upper-ish bound: the estimate only has to be close enough to refuse the
// scripts that would otherwise commit gigabytes.
const EXTRUDE_VERTICES_PER_POINT = 4;

// Below this the polygon a path encloses is a rounding error rather than a
// shape: `ShapeGeometry` yields no triangles and `ExtrudeGeometry` no volume.
// Small enough that a legitimately tiny model (a millimetre-scale profile)
// still passes.
const DEGENERATE_AREA = 1e-9;

/** Distinguishes complexity refusals from syntax and geometry errors in the
 *  tool's diagnostic return value. */
export class ShapeScriptLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapeScriptLimitError";
  }
}

type TransformState = {
  matrix: THREE.Matrix4;
  // Explicitly `| undefined` rather than optional: `exactOptionalPropertyTypes`
  // otherwise rejects the `current.color = undefined` reset in block scopes.
  color: THREE.Color | undefined;
};

export class Converter {
  private options: ConversionOptions;
  private evaluator: Evaluator;
  private symbols: SymbolTable;
  private pathCommandCount = 0;
  private detailLevel: number = 32; // Default detail level for curved shapes
  /** Objects produced so far, checked against `maxNodes` on every node. */
  private nodeCount = 0;
  /** Vertices allocated so far, checked against `maxVertices` on every mesh. */
  private vertexCount = 0;
  /** When this conversion began, checked against `maxDurationMs` on every node. */
  private readonly startedAt = Date.now();

  // Transform state stack for relative transforms
  private transformStack: TransformState[] = [];

  constructor(options: ConversionOptions = {}) {
    this.options = options;
    this.symbols = new SymbolTable();
    this.evaluator = new Evaluator(this.symbols, options.randomSeed);
    // Initialize with identity transform
    this.pushTransform();
  }

  convert(nodes: SceneNode[]): THREE.Group {
    const group = new THREE.Group();

    try {
      this.addChildren(group, nodes);
    } catch (error) {
      // The ROOT is abandoned the same way a nested group is: the callers
      // assign it only once this returns, and both Vue surfaces catch the error
      // to show it — so 19,999 meshes built before the 20,000th tripped the
      // budget would stay allocated, once per rejected render.
      disposeObject3D(group);
      throw error;
    }

    return group;
  }

  private get maxNodes(): number {
    return this.options.maxNodes ?? DEFAULT_MAX_NODES;
  }

  private get maxLoopIterations(): number {
    return this.options.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
  }

  private get maxVertices(): number {
    return this.options.maxVertices ?? DEFAULT_MAX_VERTICES;
  }

  private get maxDurationMs(): number {
    return this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  }

  /** Charge an ESTIMATE before the allocation happens.
   *
   *  `makeMesh` charges what a geometry actually holds, which is too late for a
   *  constructor whose inputs already predict something enormous:
   *  `LatheGeometry` over a 100k-point profile at `detail 256` allocates ~25M
   *  vertices — hundreds of MB on the UI thread — before there is anything to
   *  measure. Where the count is predictable, refuse first. */
  /** Pre-flight charge for a geometry built from a path.
   *
   *  `Shape.curves` is a plain array, so reading its length allocates nothing —
   *  unlike `getPoints()`, which would build the very buffer we are trying to
   *  refuse. A path may hold up to `maxLoopIterations` points, and at high
   *  detail the constructor multiplies that again, so `ExtrudeGeometry` and
   *  `ShapeGeometry` need the same treatment `LatheGeometry` got. */
  private chargePathEstimate(shape: THREE.Shape, segmentsPerCurve: number, verticesPerPoint = 1): void {
    const points = Math.max(1, shape.curves.length) * Math.max(1, segmentsPerCurve);
    this.chargeEstimate(points * verticesPerPoint);
  }

  private chargeEstimate(vertices: number): void {
    if (this.vertexCount + vertices > this.maxVertices) {
      throw new ShapeScriptLimitError(`ShapeScript exceeds ${this.maxVertices} vertices — lower \`detail\` or simplify the path`);
    }
  }

  /** Every mesh in the scene is built here, so the AGGREGATE vertex count is
   *  bounded and not merely the node count. Charged after the geometry exists —
   *  one primitive is bounded by `MAX_DETAIL²`, so the allocation that trips the
   *  limit is small, and it is freed before the refusal propagates. */
  private makeMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    this.vertexCount += geometry.getAttribute("position")?.count ?? 0;
    if (this.vertexCount > this.maxVertices) {
      geometry.dispose();
      material.dispose();
      throw new ShapeScriptLimitError(`ShapeScript exceeds ${this.maxVertices} vertices — lower \`detail\` or use fewer shapes`);
    }
    return new THREE.Mesh(geometry, material);
  }

  /** Expand a `for … from to to step` range without materialising it first.
   *  The array used to be built up front, so an absurd bound exhausted memory
   *  before a single node existed and the budget below never got a turn. */
  private rangeIterations(from: number, to: number, step: number): number[] {
    if (step === 0 || !Number.isFinite(step) || !Number.isFinite(from) || !Number.isFinite(to))
      throw new Error("Loop bounds and step must be finite, with a nonzero step");
    const iterations: number[] = [];
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      if (iterations.length >= this.maxLoopIterations) {
        throw new ShapeScriptLimitError(`ShapeScript loop exceeds ${this.maxLoopIterations} iterations — narrow the range or increase the step`);
      }
      iterations.push(i);
    }
    return iterations;
  }

  private convertNode(node: SceneNode): THREE.Object3D | null {
    // Counted on the way IN, so a runaway loop stops at the limit rather than
    // after building everything it asked for.
    this.nodeCount += 1;
    if (this.nodeCount > this.maxNodes) {
      throw new ShapeScriptLimitError(`ShapeScript produced more than ${this.maxNodes} objects — reduce the loop counts or the nesting`);
    }
    if (Date.now() - this.startedAt > this.maxDurationMs) {
      throw new ShapeScriptLimitError(`ShapeScript took longer than ${this.maxDurationMs}ms to build — simplify the model or use fewer boolean operations`);
    }
    switch (node.type) {
      case "shape":
        return this.convertShape(node);
      case "csg":
        return this.convertCSG(node);
      case "block":
        return this.convertBlock(node);
      case "for":
        return this.convertForLoop(node);
      case "if":
        return this.convertIf(node);
      case "switch":
        return this.convertSwitch(node);
      case "define":
        this.handleDefine(node);
        return null; // Define doesn't create geometry
      case "extrude":
        return this.convertExtrude(node);
      case "loft":
        return this.convertLoft(node);
      case "lathe":
        return this.convertLathe(node);
      case "fill":
        return this.convertFill(node);
      case "hull":
        return this.convertHull(node);
      case "group":
        return this.convertBlock(node);
      case "detail":
        this.handleDetail(node);
        return null; // Detail doesn't create geometry
      case "seed":
        this.evaluator.reseed(this.evaluateNumber(node.value));
        return null;
      case "color":
        this.handleColorCommand(node);
        return null;
      case "rotate":
        this.handleRotateCommand(node);
        return null;
      case "orientation":
        this.handleOrientationCommand(node);
        return null;
      case "translate":
        this.handleTranslateCommand(node);
        return null;
      case "scale":
        this.handleScaleCommand(node);
        return null;
      case "customShape":
        return this.convertCustomShape(node);
      case "path": {
        const shape = this.buildPath(node);
        this.chargePathEstimate(shape, SHAPE_GEOMETRY_CURVE_SEGMENTS);
        this.requireEnclosedArea(shape, "path");
        const mesh = this.makeMesh(new THREE.ShapeGeometry(shape), this.createMaterial({ properties: {} }));
        this.applyCurrentTransform(mesh);
        return mesh;
      }
      default:
        throw new Error(`Unsupported command: ${(node as { type: string }).type}`);
    }
  }

  /** Build `group` inside a fresh symbol + transform scope.
   *
   *  The `catch` is not tidiness: nothing downstream can reach a group that was
   *  never returned. The CSG caller records a child only once conversion
   *  returns, and the Vue callers assign the root only once `astToThreeJS`
   *  returns — so a body that throws midway (a budget refusal, a bad
   *  expression) strands whatever it had already built, with no owner to
   *  dispose it. The `finally` is the other half: a throw must not leave the
   *  scope frames behind for whatever runs next. */
  private inScope(group: THREE.Group, build: () => void): THREE.Group {
    return this.inFrame(() => {
      try {
        build();
      } catch (error) {
        disposeObject3D(group);
        throw error;
      }
      return group;
    });
  }

  /** The frame half on its own, for builders that return a single mesh rather
   *  than a group: there is nothing to dispose (a geometry that trips the
   *  budget is freed by `makeMesh`), but a throw must still not leave the
   *  symbol and transform frames behind for whatever runs next. */
  private inFrame<T>(build: () => T): T {
    this.symbols.pushScope();
    this.pushTransform();
    try {
      return build();
    } finally {
      this.popTransform();
      this.symbols.popScope();
    }
  }

  /** Convert each child and add whatever it produced to `group`. Every block
   *  form ends up doing exactly this, and jscpd was right that six copies of
   *  the loop is five too many. */
  private addChildren(group: THREE.Group, children: readonly SceneNode[]): void {
    for (const child of children) {
      const object = this.convertNode(child);
      if (object) {
        group.add(object);
      }
    }
  }

  private convertBlock(node: { children: SceneNode[] }): THREE.Group {
    const group = new THREE.Group();
    return this.inScope(group, () => this.addChildren(group, node.children));
  }

  private finishMesh(geometry: THREE.BufferGeometry, node: { properties: ShapeProperties }): THREE.Mesh {
    let mesh: THREE.Mesh | undefined;
    try {
      mesh = this.makeMesh(geometry, this.createMaterial(node));
      this.applyExplicitTransforms(mesh, node.properties);
      this.applyCurrentTransform(mesh);
      return mesh;
    } catch (error) {
      if (mesh) disposeObject3D(mesh);
      else geometry.dispose();
      throw error;
    }
  }

  private convertShape(node: ShapeNode): THREE.Mesh {
    return this.finishMesh(this.createGeometry(node), node);
  }

  /** A solid whose extent is zero in any dimension draws nothing.
   *
   *  `sphere { size 0 }` built a mesh with an empty bounding box, and
   *  validation reported success over a viewport with no visible model —
   *  the same blank result the diagnostics exist to replace. Planar
   *  primitives (`square`, `circle`, `polygon`) are exempt: they are flat by
   *  definition and fall back to a unit size of their own. */
  private requireExtent(primitive: string, dimensions: readonly (number | undefined)[]): void {
    if (dimensions.some((value) => !value)) {
      throw new Error(`\`${primitive}\` needs a nonzero size in every dimension — this one encloses nothing`);
    }
  }

  private createGeometry(node: ShapeNode): THREE.BufferGeometry {
    let size: Vector3 = [1, 1, 1];

    if (node.properties.size) {
      size = this.evaluateVector3(node.properties.size);
    }

    // If only one dimension specified (others are 0), make it uniform
    if (size[1] === 0 && size[2] === 0 && size[0] !== 0) {
      size = [size[0], size[0], size[0]];
    }

    switch (node.primitive) {
      case "cube":
        this.requireExtent("cube", size);
        return new THREE.BoxGeometry(size[0], size[1], size[2]);

      // `size` is the DIAMETER of every curved primitive, as upstream: a
      // `sphere` with no size fits the unit cube, not a 2-unit one.
      case "sphere":
        this.requireExtent("sphere", size);
        return new THREE.SphereGeometry(0.5, this.detailLevel, this.detailLevel).scale(...size);

      case "cylinder": {
        const radiusTop = node.properties.radiusTop ? this.evaluateNumber(node.properties.radiusTop) : size[0] / 2;
        const radiusBottom = node.properties.radiusBottom ? this.evaluateNumber(node.properties.radiusBottom) : size[0] / 2;
        const height = node.properties.height ? this.evaluateNumber(node.properties.height) : size[1];
        // One radius may be zero — that is a cone, not a degenerate cylinder.
        this.requireExtent("cylinder", [radiusTop || radiusBottom, height]);
        return new THREE.CylinderGeometry(radiusTop, radiusBottom, height, this.detailLevel);
      }

      case "cone": {
        const radius = size[0] / 2;
        const height = node.properties.height ? this.evaluateNumber(node.properties.height) : size[1];
        this.requireExtent("cone", [radius, height]);
        return new THREE.ConeGeometry(radius, height, this.detailLevel);
      }

      case "torus": {
        // A plugin extension (upstream has no torus); `size` is the outer
        // diameter so it follows the same rule as the primitives above.
        const outerRadius = node.properties.outerRadius ? this.evaluateNumber(node.properties.outerRadius) : size[0] / 2;
        const innerRadius = node.properties.innerRadius ? this.evaluateNumber(node.properties.innerRadius) : outerRadius * 0.4;
        this.requireExtent("torus", [outerRadius, innerRadius]);
        return new THREE.TorusGeometry(outerRadius, innerRadius, Math.max(3, Math.floor(this.detailLevel / 2)), this.detailLevel);
      }

      case "circle": {
        const radius = (size[0] || 1) / 2;
        return new THREE.CircleGeometry(radius, this.detailLevel);
      }

      case "square": {
        const sideLength = size[0] || 1;
        return new THREE.PlaneGeometry(sideLength, size[1] || sideLength);
      }

      case "polygon": {
        const radius = (size[0] || 1) / 2;
        const sides = node.properties.sides === undefined ? 6 : this.evaluateNumber(node.properties.sides);
        if (!Number.isInteger(sides) || sides < 3 || sides > MAX_DETAIL) throw new Error(`Polygon sides must be an integer from 3 to ${MAX_DETAIL}`);
        return new THREE.CircleGeometry(radius, sides);
      }

      default:
        throw new Error(`Unknown primitive: ${node.primitive}`);
    }
  }

  private materialColor(property: ShapeProperties["color"]): THREE.Color {
    if (property !== undefined) {
      const [red = 0.8, green = 0.8, blue = 0.8] = this.evaluateColor(property);
      return new THREE.Color(red, green, blue);
    }
    const scopeColor = this.currentTransform().color;
    return scopeColor === undefined ? new THREE.Color(0.8, 0.8, 0.8) : scopeColor.clone();
  }

  private createMaterial(node: { properties: ShapeProperties }): THREE.Material {
    // A per-shape `color` property wins; otherwise the enclosing scope's
    // `color` command applies. That fallback was missing, so `color 1 0 0`
    // followed by `cube` rendered the default grey — the scope colour was
    // stored and cloned but never read back.
    const threeColor = this.materialColor(node.properties.color);

    const opacity = node.properties.opacity ? this.evaluateNumber(node.properties.opacity) : 1;
    const transparent = opacity < 1;

    return new THREE.MeshStandardMaterial({
      color: threeColor,
      opacity,
      transparent,
      wireframe: this.options.wireframe ?? false,
    });
  }

  private convertCSG(node: CSGNode): THREE.Object3D {
    if (node.children.length === 0) {
      return new THREE.Group();
    }

    // Save the transform state BEFORE entering block - CSG result will be positioned here
    const savedMatrix = this.currentTransform().matrix.clone();

    // Declared outside the try so the error path can free whatever had
    // been built before the failure. Everything in here exists only to feed the
    // CSG evaluator — the children, their clones, the Brushes, and every
    // intermediate `evaluate()` result — and none of it ever enters the scene,
    // so scene teardown never reclaims it.
    const scratch: THREE.Object3D[] = [];

    try {
      const csgEvaluator = new CSGEvaluator();

      // CSG blocks create both symbol and transform scopes
      // Blocks start at identity - shapes are relative to block origin
      this.symbols.pushScope();
      this.pushTransform();
      // The matching pops live in the `finally` below, so a throw mid-collection
      // unwinds the frames before the error propagates to the caller.

      // Reset to identity for block's local coordinate space. The MATRIX only:
      // an enclosing `color` is not a coordinate, and clearing it made
      // `color 1 0 0` apply to a plain `cube` but not to a `difference` beside
      // it. `pushTransform` already cloned the inherited colour.
      this.currentTransform().matrix.identity();

      const meshes: THREE.Mesh[] = [];
      try {
        for (const child of node.children) {
          // A path is a 2D outline with no volume. Feeding a degenerate operand
          // to the CSG evaluator yields garbage geometry or an internal throw,
          // and the fallback that used to absorb that is gone — so refuse it
          // with a message that names the fix.
          if (child.type === "path") {
            throw new Error("A `path` has no volume and cannot be a CSG operand — wrap it in `extrude`, `lathe` or `fill`");
          }
          const object = this.convertNode(child);
          // `convertNode` returns null for the commands that only change state
          // (`translate`, `color`, `define`, `detail`, …), so nothing may be
          // read off it before this guard.
          if (!object) continue;
          scratch.push(object);
          // Duck-typed rather than `instanceof`: a plugin bundle can load its
          // own copy of three, and then the host's Mesh/Group fail every
          // `instanceof` here while behaving exactly like one.
          if ((object as THREE.Mesh).isMesh) {
            // Clone the mesh to avoid modifying the original
            const clonedMesh = (object as THREE.Mesh).clone();
            clonedMesh.updateMatrixWorld(true);
            meshes.push(clonedMesh);
          } else if ((object as THREE.Group).isGroup) {
            // Preserve parent transforms when flattening nested builder groups.
            object.updateMatrixWorld(true);
            object.traverse((obj) => {
              if ((obj as THREE.Mesh).isMesh) {
                const clonedMesh = (obj as THREE.Mesh).clone();
                obj.matrixWorld.decompose(clonedMesh.position, clonedMesh.quaternion, clonedMesh.scale);
                clonedMesh.updateMatrixWorld(true);
                meshes.push(clonedMesh);
              }
            });
          }
        }
      } finally {
        // Pop scopes - transforms and symbols. In a `finally` so a child that
        // throws (a budget refusal, a bad expression) cannot leave the frame
        // behind for whatever runs next.
        this.popTransform();
        this.symbols.popScope();
      }

      if (meshes.length === 0) {
        return new THREE.Group();
      }

      scratch.push(...meshes);

      // Convert meshes to Brushes with materials
      const brushes = meshes.map((mesh) => {
        const brush = new Brush(mesh.geometry, mesh.material);
        brush.position.copy(mesh.position);
        brush.rotation.copy(mesh.rotation);
        brush.scale.copy(mesh.scale);
        brush.updateMatrixWorld(true);
        return brush;
      });
      scratch.push(...brushes);

      // Perform CSG operation
      const firstBrush = brushes[0];
      if (firstBrush === undefined) throw new Error("CSG operation needs at least one child shape");
      let result = firstBrush;

      for (let i = 1; i < brushes.length; i++) {
        const brush = brushes[i];
        if (brush === undefined) continue;

        // Every `evaluate()` allocates a fresh geometry, and the operand it
        // replaces stops being reachable — so record each one.
        const evaluate = (a: Brush, b: Brush, operation: typeof ADDITION | typeof SUBTRACTION | typeof INTERSECTION): Brush => {
          scratch.push(a, b);
          const produced = csgEvaluator.evaluate(a, b, operation);
          scratch.push(produced);
          this.chargeEstimate(produced.geometry.getAttribute("position")?.count ?? 0);
          this.vertexCount += produced.geometry.getAttribute("position")?.count ?? 0;
          return produced;
        };

        switch (node.operation) {
          case "union":
            result = evaluate(result, brush, ADDITION);
            break;
          case "difference":
            result = evaluate(result, brush, SUBTRACTION);
            break;
          case "intersection":
            result = evaluate(result, brush, INTERSECTION);
            break;
          case "xor": {
            // XOR = (A - B) + (B - A)
            const aMinusB = evaluate(result.clone(), brush.clone(), SUBTRACTION);
            const bMinusA = evaluate(brush.clone(), result.clone(), SUBTRACTION);
            result = evaluate(aMinusB, bMinusA, ADDITION);
            break;
          }
          case "stencil": {
            // Split only A's surface. Solid subtraction would add unwanted
            // cut faces inside A; hollow operations preserve its volume.
            const outside = evaluate(result, brush, HOLLOW_SUBTRACTION);
            const inside = evaluate(result, brush, HOLLOW_INTERSECTION);
            inside.material = Array.isArray(brush.material) ? brush.material[0]! : brush.material;
            inside.geometry.clearGroups();
            inside.geometry.addGroup(0, inside.geometry.index?.count ?? inside.geometry.getAttribute("position").count, 0);
            const parts = [outside, inside];
            const geometries = parts.map((part) => part.geometry.clone().applyMatrix4(part.matrixWorld));
            try {
              const geometry = mergeGeometries(geometries);
              if (!geometry) throw new Error("Could not combine stencil surfaces");
              const materials: THREE.Material[] = [];
              let offset = 0;
              for (const part of parts) {
                for (const group of part.geometry.groups) geometry.addGroup(offset + group.start, group.count, materials.length + (group.materialIndex ?? 0));
                materials.push(...(Array.isArray(part.material) ? part.material : [part.material]));
                offset += part.geometry.index?.count ?? part.geometry.getAttribute("position").count;
              }
              result = new Brush(geometry, materials);
              scratch.push(result);
              this.chargeEstimate(geometry.getAttribute("position").count);
              this.vertexCount += geometry.getAttribute("position").count;
            } finally {
              geometries.forEach((geometry) => geometry.dispose());
            }
            break;
          }
        }
      }

      // Ensure the result has a proper material
      if (!result.material) {
        result.material = firstBrush.material;
      }

      // Apply saved transform to position the CSG result in world space
      result.applyMatrix4(savedMatrix);
      result.updateMatrixWorld(true);

      // Free the operands. By RESOURCE, not by identity: with a single child
      // the result IS the operand, and `mesh.clone()` shares geometry and
      // material with its source, so an identity check would free buffers the
      // returned object still draws with.
      disposeScratch(scratch, result);

      return result;
    } catch (error) {
      disposeScratch(scratch, new THREE.Group());
      // A failed boolean must not silently display its uncombined operands.
      throw error;
    }
  }

  private convertForLoop(node: ForLoopNode): THREE.Group {
    const group = new THREE.Group();

    // New scope for the loop, both symbols and transforms. Transforms
    // accumulate across iterations but stay scoped to the loop.
    return this.inScope(group, () => {
      // Check if it's a values iteration or range iteration
      if (node.iterableValues) {
        // for i in values
        const values = this.evaluator.evaluate(node.iterableValues);
        const valueArray = Array.isArray(values) ? values : [values];
        // Same ceiling as the range form. This one used to bypass both budgets:
        // the iteration cap lives in `rangeIterations`, and the node cap only
        // counts what the BODY builds — so an empty body ran the whole list for
        // free.
        if (valueArray.length > this.maxLoopIterations) {
          throw new ShapeScriptLimitError(`ShapeScript loop exceeds ${this.maxLoopIterations} iterations — narrow the range or increase the step`);
        }

        for (const iterationValue of valueArray) {
          this.symbols.set(node.variable, iterationValue);

          // Convert body nodes - transforms accumulate across iterations
          this.addChildren(group, node.body);
        }
      } else {
        // for i in from to to
        const from = this.evaluateNumber(node.from);
        const to = this.evaluateNumber(node.to);
        const step = node.step ? this.evaluateNumber(node.step) : 1;

        const iterations = this.rangeIterations(from, to, step);

        for (const i of iterations) {
          this.symbols.set(node.variable, i);

          // Convert body nodes directly - no iteration sub-groups.
          // Transforms accumulate across iterations within the loop scope.
          this.addChildren(group, node.body);
        }
      }
    });
  }

  private convertIf(node: IfNode): THREE.Group {
    const group = new THREE.Group();

    // Evaluated BEFORE the scope is pushed, as it always was.
    const condition = this.evaluator.evaluateToBoolean(node.condition);

    return this.inScope(group, () => this.addChildren(group, condition ? node.thenBody : (node.elseBody ?? [])));
  }

  private convertSwitch(node: SwitchNode): THREE.Group {
    const group = new THREE.Group();

    // Evaluate switch value
    const switchValue = this.evaluator.evaluate(node.value);

    return this.inScope(group, () => {
      const matched = node.cases.find((caseNode) => caseNode.values.some((caseValue) => this.valuesEqual(switchValue, this.evaluator.evaluate(caseValue))));
      this.addChildren(group, matched ? matched.body : (node.defaultCase ?? []));
    });
  }

  private handleDefine(node: DefineNode): void {
    // Check if this is a variable definition or a custom shape definition
    if (node.value !== undefined) {
      // Variable definition: define x 5
      const value = this.evaluator.evaluate(node.value);
      this.symbols.set(node.name, value);
    } else if (node.body !== undefined || node.options !== undefined) {
      // Custom shape definition: define shape { ... }
      // Store the entire node for later instantiation
      // Note: We cast to Value since SymbolTable expects Value, but we know it's a DefineNode
      this.symbols.set(node.name, node as unknown as Value);
    }
  }

  private convertCustomShape(node: CustomShapeNode): THREE.Object3D | null {
    // Look up the custom shape definition
    const definition = this.symbols.get(node.name);

    if (!definition || typeof definition !== "object" || !("type" in definition)) {
      throw new Error(`Unknown shape: ${node.name}`);
    }

    const defineNode = definition as unknown as DefineNode;

    if (!defineNode.body) {
      throw new Error(`Custom shape '${node.name}' has no body`);
    }

    // Same scope handling as every other group builder: a body node that throws
    // must not strand the group (a custom shape can be a CSG operand, where
    // nothing downstream ever sees it) or leave the frames behind.
    const group = new THREE.Group();
    const body = defineNode.body;
    return this.inScope(group, () => {
      // Set default values from options
      for (const option of defineNode.options ?? []) {
        this.symbols.set(option.name, this.evaluator.evaluate(option.defaultValue));
      }

      // Override with provided properties
      for (const [key, value] of Object.entries(node.properties)) {
        this.symbols.set(key, this.evaluator.evaluate(value as Expression));
      }

      // Convert the body
      this.addChildren(group, body);
    });
  }

  private pushTransform(): void {
    const current = this.currentTransform();
    this.transformStack.push({
      matrix: current.matrix.clone(),
      color: current.color === undefined ? undefined : current.color.clone(),
    });
  }

  private popTransform(): void {
    if (this.transformStack.length > 1) {
      this.transformStack.pop();
    }
  }

  private currentTransform(): TransformState {
    const top = this.transformStack[this.transformStack.length - 1];
    // Empty stack — hand back a fresh identity transform.
    return top ?? { matrix: new THREE.Matrix4(), color: undefined };
  }

  private applyCurrentTransform(object: THREE.Object3D): void {
    const transform = this.currentTransform();
    object.applyMatrix4(transform.matrix);
  }

  private applyExplicitTransforms(object: THREE.Object3D, properties: ShapeProperties): void {
    if (properties.position) {
      const pos = this.evaluateVector3(properties.position);
      object.position.set(...pos);
    }

    // `orientation` is upstream's name; `rotation` is kept as an alias.
    const orientation = properties.orientation ?? properties.rotation;
    if (orientation) {
      object.quaternion.copy(this.rotationOf(orientation));
    }
  }

  /** An upstream rotation value as a quaternion.
   *
   *  `roll yaw pitch` are HALF-TURNS (0.5 = 90°) about Z, Y and X, applied in
   *  that order, and positive is clockwise looking down each axis toward the
   *  origin — Euclid stores the negated angle, so the sign is flipped here to
   *  match. A lone number is a roll (`orientation 0.25` = 45° about Z, not a
   *  uniform tuple like `size`), and four numbers are `angle x y z`. */
  private rotationOf(value: Expression | Vector3): THREE.Quaternion {
    const components = this.rotationComponents(value);
    if (components.length === 4) {
      const [angle = 0, x = 0, y = 0, z = 0] = components;
      const axis = new THREE.Vector3(x, y, z);
      if (axis.lengthSq() === 0) throw new Error("Rotation axis must not be zero");
      return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), -angle * Math.PI);
    }
    const [roll = 0, yaw = 0, pitch = 0] = components;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch * Math.PI, -yaw * Math.PI, -roll * Math.PI, "ZYX"));
  }

  private rotationComponents(value: Expression | Vector3): number[] {
    const raw: Value = Array.isArray(value) && typeof value[0] === "number" ? (value as number[]) : this.evaluator.evaluate(value as Expression);
    const components = (Array.isArray(raw) ? raw : [raw]).map((component) => (typeof component === "number" ? component : Number.NaN));
    if (components.length === 0 || components.length > 4 || !components.every(Number.isFinite)) {
      throw new Error("Expected a rotation of 1 to 3 half-turn components (roll yaw pitch) or an angle and an axis (angle x y z)");
    }
    return components;
  }

  private handleDetail(node: DetailNode): void {
    const requested = this.evaluateNumber(node.value);
    // NaN survives both comparisons of a naive clamp, and a fractional segment
    // count silently truncates inside three.js — normalise here so every
    // geometry below gets an integer in range.
    this.detailLevel = Number.isFinite(requested) ? Math.min(MAX_DETAIL, Math.max(MIN_DETAIL, Math.floor(requested))) : MIN_DETAIL;
    // Also add 'detail' as a variable so it can be referenced in expressions.
    // The CLAMPED value, so an expression reading `detail` agrees with what was
    // actually drawn.
    this.symbols.set("detail", this.detailLevel);
  }

  private handleColorCommand(node: ColorNode): void {
    const colorValue = this.evaluateVector3OrColor(node.value);
    this.currentTransform().color = new THREE.Color(colorValue[0], colorValue[1], colorValue[2]);
  }

  private handleRotateCommand(node: RotateNode): void {
    const transform = this.currentTransform();
    // Post-multiplied, so the rotation is in the current local frame — the
    // same composition as upstream's `Transform.rotated(by:)`.
    transform.matrix.multiply(new THREE.Matrix4().makeRotationFromQuaternion(this.rotationOf(node.value)));
  }

  private handleOrientationCommand(node: OrientationNode): void {
    const transform = this.currentTransform();

    // Orientation sets absolute rotation, not cumulative like rotate
    // Decompose current matrix to preserve position and scale
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    transform.matrix.decompose(position, new THREE.Quaternion(), scale);

    // Rebuild matrix with new orientation but preserve position and scale
    transform.matrix.compose(position, this.rotationOf(node.value), scale);
  }

  private handleTranslateCommand(node: TranslateNode): void {
    const transform = this.currentTransform();
    const [x, y, z] = this.evaluateTranslateVector(node.value);
    if (![x, y, z].every(Number.isFinite)) throw new Error("Expected finite translation components");
    const translationMatrix = new THREE.Matrix4().makeTranslation(x, y, z);
    transform.matrix.multiply(translationMatrix);
  }

  private handleScaleCommand(node: ScaleNode): void {
    const scale = this.evaluateVector3(node.value);
    const transform = this.currentTransform();
    const scaleMatrix = new THREE.Matrix4().makeScale(scale[0], scale[1], scale[2]);
    transform.matrix.multiply(scaleMatrix);
  }

  /** Refuse a contour that encloses nothing.
   *
   *  `ShapeGeometry` over a single `point` triangulates to zero triangles, and
   *  `ExtrudeGeometry` over collinear points sweeps a ribbon with no volume —
   *  both used to pass validation as a successful visualization and then
   *  present an empty viewport, which is worse than a diagnostic naming the
   *  path. Sampled at the same resolution the geometry will use, so a curve
   *  that only looks flat at low detail is not rejected. */
  private requireEnclosedArea(shape: THREE.Shape, command: string): THREE.Shape {
    const points = shape.getPoints(SHAPE_GEOMETRY_CURVE_SEGMENTS);
    const area = THREE.ShapeUtils.area(points);
    // `NaN` fails EVERY comparison, so a path whose coordinates overflowed to
    // infinity while accumulating would sail past a bare `< DEGENERATE_AREA`.
    if (!Number.isFinite(area)) throw new Error(`\`${command}\` needs finite path coordinates — these overflow`);
    if (points.length < 3 || Math.abs(area) < DEGENERATE_AREA) {
      throw new Error(`\`${command}\` needs a path that encloses an area — this one has fewer than three distinct points, or they are collinear`);
    }
    return shape;
  }

  private convertExtrude(node: ExtrudeNode): THREE.Mesh {
    if (!node.path) {
      return this.buildFromChildren({ children: node.children ?? [], properties: node.properties }, (meshes) => {
        const shapes = meshes.map((mesh) => this.planarShape(mesh));
        if (!shapes.length) throw new Error("Extrude requires a path or planar shape");
        const size = node.properties.size ? this.evaluateVector3(node.properties.size) : [1, 1, 1];
        for (const shape of shapes) this.chargePathEstimate(shape, 1, 12);
        return new THREE.ExtrudeGeometry(shapes, { depth: size[2] ?? 1, bevelEnabled: false, curveSegments: 1 });
      });
    }
    const shape = this.requireEnclosedArea(this.buildPath(node.path), "extrude");

    // Get extrusion depth from size property
    const size = node.properties.size ? this.evaluateVector3(node.properties.size) : [1, 1, 1];
    const depth = size[2] || 1;

    // Create extruded geometry
    const curveSegments = Math.max(1, Math.floor(this.detailLevel / 4));
    this.chargePathEstimate(shape, curveSegments, EXTRUDE_VERTICES_PER_POINT);

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
      curveSegments,
    });

    // Create material
    const material = this.createMaterial(node);

    const mesh = this.makeMesh(geometry, material);

    this.applyExplicitTransforms(mesh, node.properties);
    this.applyCurrentTransform(mesh);

    return mesh;
  }

  private buildPath(pathNode: PathNode): THREE.Shape {
    return this.shapeFromPathPoints(this.collectPathPoints(pathNode));
  }

  /** Run the path's commands and return its points in path space.
   *
   *  Coordinates are ABSOLUTE, as upstream: `point 1 0` is at x=1 however many
   *  points came before it. What `translate`, `rotate` and `scale` move is the
   *  path's local frame, which every later point is placed through — so
   *  `for 0 to 8 { curve 0 1 rotate 1 / 8 }` walks a semicircle. The frame is
   *  post-multiplied like the shape transform, and checked after every command
   *  because individually finite operands can still overflow it. */
  private collectPathPoints(pathNode: PathNode): PathPoint[] {
    const frame = new THREE.Matrix4();
    const points: PathPoint[] = [];

    const place = (command: PointCommand | CurveCommand) => {
      const position = new THREE.Vector3(this.evaluateNumber(command.x), this.evaluateNumber(command.y), 0).applyMatrix4(frame);
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error("Path coordinates overflowed to a non-finite value");
      points.push({ x: position.x, y: position.y, curved: command.type === "curve" });
    };
    const move = (step: THREE.Matrix4) => {
      frame.multiply(step);
      if (!frame.elements.every(Number.isFinite)) {
        throw new Error("Path transform overflowed to a non-finite value — `translate`, `rotate` and `scale` accumulate inside a path");
      }
    };

    const processCommand = (command: PathCommand) => {
      if (++this.pathCommandCount > this.maxLoopIterations) throw new ShapeScriptLimitError(`ShapeScript path exceeds ${this.maxLoopIterations} commands`);
      switch (command.type) {
        case "define":
          this.handleDefine(command);
          break;
        case "detail":
          this.handleDetail(command);
          break;
        case "point":
        case "curve":
          place(command);
          break;
        case "rotate":
          // Half-turns, clockwise positive — the same convention as `rotate` on a shape.
          move(new THREE.Matrix4().makeRotationZ(-this.evaluateNumber(command.angle) * Math.PI));
          break;
        case "translate":
          move(new THREE.Matrix4().makeTranslation(this.evaluateNumber(command.x), this.evaluateNumber(command.y), 0));
          break;
        case "scale":
          move(new THREE.Matrix4().makeScale(this.evaluateNumber(command.x), this.evaluateNumber(command.y), 1));
          break;
        case "for":
          this.runPathLoop(command, processCommand);
          break;
      }
    };

    for (const command of pathNode.commands) {
      processCommand(command);
    }
    return points;
  }

  private runPathLoop(command: ForLoopPathCommand, processCommand: (command: PathCommand) => void): void {
    this.symbols.pushScope();
    try {
      const from = this.evaluateNumber(command.from);
      const to = this.evaluateNumber(command.to);
      const step = command.step ? this.evaluateNumber(command.step) : 1;

      // Path commands never reach `convertNode`, so `maxNodes` cannot stop
      // this one — the shared bounded iterator is the only ceiling here.
      for (const i of this.rangeIterations(from, to, step)) {
        this.symbols.set(command.variable, i);
        for (const bodyCmd of command.commands) {
          processCommand(bodyCmd);
        }
      }
    } finally {
      this.symbols.popScope();
    }
  }

  /** Join path points into an outline, treating `curve` points as upstream does.
   *
   *  A `curve` is the CONTROL point of a quadratic Bézier; the outline passes
   *  through the `point`s on either side of it, not through the control point
   *  itself. Two `curve`s in a row get an implicit on-curve point halfway
   *  between them, which is how eight controls in an octagon draw a circle.
   *  A closed path (first and last point equal) may start on a control point.
   *  An OPEN path's first and last points are taken as corners even when they
   *  are `curve`s — upstream extrapolates a tangent there; this does not. */
  private shapeFromPathPoints(points: readonly PathPoint[]): THREE.Shape {
    const shape = new THREE.Shape();
    const first = points[0];
    if (first === undefined) return shape;

    const last = points[points.length - 1] as PathPoint;
    const closed = points.length > 2 && samePathPoint(first, last);
    const ring = closed ? points.slice(0, -1) : points;
    const at = (index: number): PathPoint => ring[(index + ring.length) % ring.length] as PathPoint;

    // Where a curve through `control` begins: the previous corner, or halfway
    // from the previous control point.
    const curveStart = (previous: PathPoint, control: PathPoint): PathPoint => (previous.curved ? midPathPoint(previous, control) : previous);
    const start = closed && first.curved ? curveStart(at(-1), first) : first;
    shape.moveTo(start.x, start.y);
    // A curve ends ON the next corner, so that corner must not be drawn again
    // as a zero-length line; a corner the script repeats deliberately still is.
    let cornerDrawn = false;

    for (let index = closed ? 0 : 1; index < ring.length; index++) {
      const point = at(index);
      const next = closed || index < ring.length - 1 ? at(index + 1) : undefined;
      if (!point.curved || next === undefined) {
        if (!cornerDrawn) shape.lineTo(point.x, point.y);
        cornerDrawn = false;
        continue;
      }
      const end = next.curved ? midPathPoint(point, next) : next;
      shape.quadraticCurveTo(point.x, point.y, end.x, end.y);
      cornerDrawn = !next.curved;
    }
    if (closed && !cornerDrawn && !samePathPoint(at(-1), start)) shape.lineTo(start.x, start.y);
    return shape;
  }

  private convertLathe(node: LatheNode): THREE.Object3D {
    // The frames are pushed here so a throw anywhere in `buildLathe` — a budget
    // refusal, a bad expression in the profile — cannot leave them behind.
    return this.inFrame(() => this.buildLathe(node));
  }

  /** A lathe profile is only a solid once it is SAMPLED.
   *
   *  `getPoints` interpolates the curves, so a control point that overflowed
   *  reaches `LatheGeometry` as `NaN` however finite the commands looked, and a
   *  profile lying entirely on the axis of rotation (every `x` at 0) sweeps
   *  nothing at all — both validated clean and drew an empty viewport. */
  private requireLatheProfile(points: readonly THREE.Vector2[]): void {
    if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
      throw new Error("`lathe` profile has non-finite coordinates — a curve control point or a path command overflowed");
    }
    const radius = Math.max(...points.map((point) => Math.abs(point.x)));
    const height = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
    if (radius < DEGENERATE_AREA || height < DEGENERATE_AREA) {
      throw new Error("`lathe` needs a profile with both radius and height — one on the axis of rotation sweeps nothing");
    }
  }

  private buildLathe(node: LatheNode): THREE.Object3D {
    // Lathe rotates a 2D profile around an axis to create a 3D shape.
    // In ShapeScript, the path defines the profile.

    // Find path node in children
    let pathNode: PathNode | null = null;
    for (const child of node.children) {
      if (child.type === "path") {
        pathNode = child as PathNode;
        break;
      }
    }

    if (!pathNode) {
      // No path found, return empty group
      throw new Error("Lathe requires a path child");
    }

    const shape = this.buildPath(pathNode);
    this.chargePathEstimate(shape, this.detailLevel, this.detailLevel + 1);
    const points = shape.getPoints(this.detailLevel);

    if (points.length < 2) {
      throw new Error("Lathe path must have at least 2 points");
    }
    this.requireLatheProfile(points);

    // What `LatheGeometry` is about to allocate: one ring of `detail + 1`
    // vertices per profile point. Checked BEFORE the constructor runs, since by
    // the time `makeMesh` could measure it the memory is already committed.
    this.chargeEstimate(points.length * (this.detailLevel + 1));

    // Create lathe geometry
    const geometry = new THREE.LatheGeometry(
      points,
      this.detailLevel, // Number of segments around the axis
    );

    // Create material
    const material = this.createMaterial(node);
    const mesh = this.makeMesh(geometry, material);

    this.applyExplicitTransforms(mesh, node.properties);
    this.applyCurrentTransform(mesh);

    return mesh;
  }

  /** Build `children` into a throwaway group at the block's own origin and hand
   *  back every mesh in it, world matrices already resolved. The group stays
   *  owned by the caller, which disposes it. */
  private buildOperands(temporary: THREE.Group, children: SceneNode[]): THREE.Mesh[] {
    this.inScope(temporary, () => {
      this.currentTransform().matrix.identity();
      this.addChildren(temporary, children);
    });
    temporary.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    temporary.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    return meshes;
  }

  private buildFromChildren(node: { children: SceneNode[]; properties: ShapeProperties }, build: (meshes: THREE.Mesh[]) => THREE.BufferGeometry): THREE.Mesh {
    const temporary = new THREE.Group();
    // The operand meshes are charged as they are built — the budget has to hold
    // while they exist — but they are disposed below and never enter the scene,
    // so the charge is REFUNDED and only what `finishMesh` returns stays
    // counted. Without this a script of a few `hull`s over detailed spheres
    // trips the ceiling while the scene it draws is far beneath it.
    const chargedBeforeOperands = this.vertexCount;
    let geometry: THREE.BufferGeometry;
    try {
      geometry = build(this.buildOperands(temporary, node.children));
    } finally {
      disposeObject3D(temporary);
      this.vertexCount = chargedBeforeOperands;
    }
    return this.finishMesh(geometry, node);
  }

  private convertLoft(node: LoftNode): THREE.Object3D {
    return this.buildFromChildren(node, (meshes) => {
      const profiles = meshes.map(profileOf);
      const vertices = profiles.length * Math.max(0, ...profiles.map((ring) => ring.length));
      this.chargeEstimate(vertices);
      return loftGeometry(profiles);
    });
  }

  private planarShape(mesh: THREE.Mesh): THREE.Shape {
    const ring = profileOf(mesh);
    if (ring.some((p) => Math.abs(p.z) > 1e-5)) throw new Error("Fill/extrude profiles must lie in the XY plane");
    return new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, p.y)));
  }

  private convertFill(node: FillNode): THREE.Object3D {
    // Fill creates a solid 2D shape from a path
    // Similar to extrude but with zero depth
    return this.inFrame(() => {
      const pathNode = node.children.find((child): child is PathNode => child.type === "path");
      if (!pathNode) {
        return this.buildFromChildren(node, (meshes) => {
          const shapes = meshes.map((mesh) => this.planarShape(mesh));
          if (!shapes.length) throw new Error("Fill requires a path or planar shape");
          for (const shape of shapes) this.chargePathEstimate(shape, 1, 3);
          return new THREE.ShapeGeometry(shapes, 1);
        });
      }

      // Build the 2D shape, then a ShapeGeometry (flat 2D shape) from it
      const shape = this.buildPath(pathNode);
      this.chargePathEstimate(shape, SHAPE_GEOMETRY_CURVE_SEGMENTS);
      this.requireEnclosedArea(shape, "fill");
      const geometry = new THREE.ShapeGeometry(shape);
      const mesh = this.makeMesh(geometry, this.createMaterial(node));

      this.applyExplicitTransforms(mesh, node.properties);
      this.applyCurrentTransform(mesh);

      return mesh;
    });
  }

  private convertHull(node: HullNode): THREE.Object3D {
    return this.buildFromChildren(node, (meshes) => {
      const points: THREE.Vector3[] = [];
      for (const mesh of meshes) {
        const position = mesh.geometry.getAttribute("position");
        for (let i = 0; i < position.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
      }
      if (points.length < 4) throw new Error("Hull requires at least four non-coplanar points");
      this.chargeEstimate(points.length * 6);
      const geometry = new ConvexGeometry(points);
      if (!geometry.getAttribute("position").count) {
        geometry.dispose();
        throw new Error("Hull points must enclose a volume");
      }
      // CSG consumes UVs even on an untextured hull.
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute("position").count * 2), 2));
      return geometry;
    });
  }

  // Helper methods

  private evaluateNumber(value: number | Expression | undefined): number {
    if (value === undefined) return 0;
    if (typeof value === "number") return value;
    const result = this.evaluator.evaluateToNumber(value);
    if (!Number.isFinite(result)) throw new Error("Expected a finite number");
    return result;
  }

  private evaluateVector3(value: Vector3 | Expression | undefined): Vector3 {
    if (value === undefined) return [0, 0, 0];
    if (Array.isArray(value) && typeof value[0] === "number") {
      return value as Vector3;
    }
    const result = this.evaluator.evaluateToVector3(value as Expression);
    if (!result.every(Number.isFinite)) throw new Error("Expected finite vector components");
    return result;
  }

  private evaluateTranslateVector(value: Expression): Vector3 {
    const result = this.evaluator.evaluate(value);

    if (typeof result === "number") {
      return [result, 0, 0];
    }

    if (Array.isArray(result)) {
      const x = result.length > 0 && typeof result[0] === "number" ? result[0] : 0;
      const y = result.length > 1 && typeof result[1] === "number" ? result[1] : 0;
      const z = result.length > 2 && typeof result[2] === "number" ? result[2] : 0;
      return [x, y, z];
    }

    return [0, 0, 0];
  }

  private evaluateColor(value: Color | Expression | undefined): Color {
    if (value === undefined) return [0.8, 0.8, 0.8];
    if (Array.isArray(value) && typeof value[0] === "number") {
      return value as Color;
    }
    return this.requireFiniteColor(this.evaluator.evaluateToColor(value as Expression));
  }

  /** Colour channels get the same treatment as sizes and translations.
   *  `new THREE.Color(Infinity, …)` throws nothing — it serialises as
   *  `[null, null, null]`, so validation reported success and the browser was
   *  handed a material it cannot draw. */
  private requireFiniteColor<T extends readonly number[]>(channels: T): T {
    if (!channels.every(Number.isFinite)) throw new Error("Expected finite color channels");
    return channels;
  }

  private evaluateVector3OrColor(value: Expression): Vector3 {
    // This helper is used for color commands which can accept a single number or a tuple
    const result = this.evaluator.evaluate(value);

    // Helper to convert Value to number. Strict, because the fallbacks it used
    // to have made `color "bad" cube` render default grey and VALIDATE clean,
    // while the identical `cube { color "bad" }` returned a diagnostic.
    const toNum = (v: Value | undefined): number => {
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (Array.isArray(v) && v.length > 0) return toNum(v[0]);
      throw new Error("Expected numeric color channels");
    };

    if (typeof result === "number") {
      // Single value - use as grayscale
      return this.requireFiniteColor([result, result, result]);
    } else if (typeof result === "boolean") {
      return this.requireFiniteColor([toNum(result), toNum(result), toNum(result)]);
    } else if (Array.isArray(result)) {
      // Tuple - ensure it's a 3-element vector
      if (result.length === 1) {
        return this.requireFiniteColor([toNum(result[0]), toNum(result[0]), toNum(result[0])]);
      } else if (result.length === 2) {
        return this.requireFiniteColor([toNum(result[0]), toNum(result[1]), 0]);
      } else if (result.length >= 3) {
        return this.requireFiniteColor([toNum(result[0]), toNum(result[1]), toNum(result[2])]);
      }
    }

    throw new Error("Expected numeric color channels");
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this.valuesEqual(a[i], b[i])) return false;
      }
      return true;
    }
    return a === b;
  }
}

// Main export function
export function astToThreeJS(nodes: SceneNode[], options: ConversionOptions = {}): THREE.Group {
  const converter = new Converter(options);
  return converter.convert(nodes);
}
