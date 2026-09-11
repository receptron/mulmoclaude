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
  ArcCommand,
  ForLoopPathCommand,
  CustomShapeNode,
  ColorNode,
  RotateNode,
  OrientationNode,
  TranslateNode,
  ScaleNode,
  MaterialNode,
  MaterialProperties,
  MeshNode,
  ExpressionStatementNode,
  Expression,
  Vector3,
  Color,
  ShapeProperties,
} from "./types";
import { Evaluator, SymbolTable, Value, RGBA, MaterialValue, FunctionValue, isObjectValue, iterationValues, rgbaOf, valuesEqual } from "./evaluator";
import { type MeshValue, type PolygonValue, type Point3, geometryFromPolygons, icosphereGeometry } from "./meshValues";
import { disposeObject3D, disposeScratch } from "./dispose";

/** What a conversion reports besides geometry. Stored on the root group's
 *  `userData` so both viewers and the tool result can read it. */
export interface ShapeScriptSceneInfo {
  /** `background r g b a` from the script's root, when set. */
  background?: RGBA;
  /** Commands that were accepted but not rendered (`texture`, `camera`, …). */
  warnings: string[];
  /** Every `print`, one line each. */
  logs: string[];
}

export function sceneInfoOf(group: THREE.Object3D): ShapeScriptSceneInfo {
  const info = group.userData as Partial<ShapeScriptSceneInfo>;
  return { ...(info.background ? { background: info.background } : {}), warnings: info.warnings ?? [], logs: info.logs ?? [] };
}

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

/** The scoped material, as upstream's `context.state.material`: every field a
 *  `color` / `opacity` / `metallicity` / `roughness` / `glow` / `smoothing`
 *  command sets for the rest of its block. */
type MaterialState = {
  color: THREE.Color | undefined;
  /** Alpha of the current colour (`color 1 0 0 0.5`), separate from `opacity`. */
  alpha: number;
  /** Multiplies through nested scopes: `opacity 0.5` twice is 0.25. */
  opacity: number;
  metallicity: number | undefined;
  roughness: number | undefined;
  glow: THREE.Color | undefined;
  /** `smoothing` threshold in half-turns; 0 means flat shading. */
  smoothing: number | undefined;
};

type TransformState = {
  matrix: THREE.Matrix4;
  material: MaterialState;
};

function cloneMaterialState(material: MaterialState): MaterialState {
  return {
    ...material,
    color: material.color?.clone(),
    glow: material.glow?.clone(),
  };
}

/** How many print statements are kept. A `print` inside a 100k-iteration loop
 *  should not turn the tool result into a transcript. */
const MAX_LOGS = 200;
/** Same bound for distinct warnings; they are deduplicated first. */
const MAX_WARNINGS = 200;

/** Signed volume of an indexed or unindexed triangle geometry. */
function signedVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const count = index?.count ?? position.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(position, index ? index.getX(i) : i);
    b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2);
    volume += a.dot(b.cross(c));
  }
  return volume / 6;
}

/** Flip a closed geometry whose faces point inward, so booleans and lighting
 *  treat it as the solid it encloses. */
function orientOutward<T extends THREE.BufferGeometry>(geometry: T): T {
  if (signedVolume(geometry) >= 0) return geometry;
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
  }
  const normal = geometry.getAttribute("normal");
  if (normal) {
    for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
    normal.needsUpdate = true;
  }
  return geometry;
}

/** Upstream's icosphere subdivision level for a detail setting. */
function icosphereSubdivisions(detail: number): number {
  return Math.max(0, Math.round(Math.log2(Math.max(4, detail))) - 2);
}

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
  /** > 0 while building a builder's operands, where a bare `path` must be a
   *  flat mesh for `profileOf`; at the scene level it draws as a line. */
  private operandDepth = 0;
  private readonly warnings: string[] = [];
  private readonly warningSet = new Set<string>();
  private readonly logs: string[] = [];
  private background: RGBA | undefined;
  private sceneDepth = 0;
  /** While set, polygons and shape values produced by statements are
   *  collected here instead of entering the scene: the body of `mesh { }`,
   *  and a function body whose result is what it built. */
  private valueSink: Value[] | null = null;

  constructor(options: ConversionOptions = {}) {
    this.options = options;
    this.symbols = new SymbolTable();
    this.evaluator = new Evaluator(this.symbols, options.randomSeed);
    // `detail` is readable as a symbol before any `detail` command runs.
    this.symbols.set("detail", this.detailLevel);
    // Shapes as values and shape-building functions are built here.
    this.evaluator.hooks = { shape: (node) => this.shapeValue(node), call: (fn, args) => this.callShapeFunction(fn, args) };
    this.evaluator.maxLoopIterations = this.maxLoopIterations;
    // Initialize with identity transform
    this.pushTransform();
  }

  convert(nodes: SceneNode[]): THREE.Group {
    const group = new THREE.Group();

    try {
      this.addChildren(group, nodes);
      const info: ShapeScriptSceneInfo = { warnings: this.warnings, logs: this.logs, ...(this.background ? { background: this.background } : {}) };
      group.userData = info;
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
      case "material":
        this.handleMaterialCommand(node);
        return null;
      case "smoothing":
        this.currentTransform().material.smoothing = this.evaluateNumber(node.value);
        return null;
      case "background":
        this.handleBackground(node.value);
        return null;
      case "print":
        if (this.logs.length < MAX_LOGS) this.logs.push(printable(this.evaluator.evaluate(node.value)));
        return null;
      case "assert":
        if (!this.evaluator.evaluateToBoolean(node.value)) throw new Error("Assertion failed");
        return null;
      case "ignored":
        this.warn(`\`${node.command}\` is not rendered by this viewer and was skipped`);
        return null;
      case "expression":
        return this.convertExpressionStatement(node);
      case "mesh":
        return this.convertMesh(node);
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
      case "path":
        return this.operandDepth > 0 ? this.convertPathProfile(node) : this.convertPathLine(node);
      default:
        throw new Error(`Unsupported command: ${(node as { type: string }).type}`);
    }
  }

  /** A `path` handed to a builder: the flat face it encloses, which `profileOf`
   *  reads the perimeter back from. */
  private convertPathProfile(node: PathNode): THREE.Mesh {
    const shape = this.buildPath(node);
    this.chargePathEstimate(shape, SHAPE_GEOMETRY_CURVE_SEGMENTS);
    this.requireEnclosedArea(shape, "path");
    const mesh = this.makeMesh(this.placePath(new THREE.ShapeGeometry(shape), node), this.createMaterial({ properties: {} }));
    this.applyCurrentTransform(mesh);
    return mesh;
  }

  /** A `path` in the scene draws as a stroke, as upstream: `fill` makes a
   *  face of it, and a builder consumes it. Open paths are allowed here. */
  private convertPathLine(node: PathNode): THREE.Line {
    const shape = this.buildPath(node);
    const points = shape.getPoints(Math.max(1, Math.floor(this.detailLevel / 4)));
    if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
      throw new Error("`path` needs finite path coordinates — these overflow");
    if (points.length < 2) throw new Error("`path` needs at least two points");
    this.chargeEstimate(points.length);
    this.vertexCount += points.length;
    const geometry = this.placePath(new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(point.x, point.y, 0))), node);
    const material = this.currentTransform().material;
    const opacity = Math.min(1, Math.max(0, material.alpha * material.opacity));
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: material.color?.clone() ?? new THREE.Color(0.8, 0.8, 0.8), opacity, transparent: opacity < 1 }),
    );
    this.applyCurrentTransform(line);
    return line;
  }

  /** Deduplicated and capped: a `texture` inside a 100k-iteration loop must
   *  not turn the warning list into a transcript, nor the check into a scan. */
  private warn(message: string): void {
    if (this.warningSet.has(message) || this.warnings.length >= MAX_WARNINGS) return;
    this.warningSet.add(message);
    this.warnings.push(message);
  }

  /** `background` at the root: a colour is kept for the viewer, a texture
   *  file cannot be loaded here. */
  private handleBackground(value: Expression): void {
    if (this.sceneDepth > 0) throw new Error("`background` can only be used at the root of the script");
    const raw = this.evaluator.evaluate(value);
    if (typeof raw === "string") {
      this.warn(`background image "${raw}" is not supported — the scene keeps its default background`);
      return;
    }
    this.background = this.requireFiniteColor(rgbaOf(raw));
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
    this.sceneDepth++;
    try {
      return build();
    } finally {
      this.sceneDepth--;
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

  /** A control-flow body: `for`, `if` and `switch` scope SYMBOLS only. Their
   *  `translate` / `rotate` / `color` carry on past the closing brace, as
   *  upstream (scope.md, "Conditional Scope") — a loop that rotates each
   *  iteration leaves the frame where the last one ended. */
  private inSymbolScope(group: THREE.Group, build: () => void): THREE.Group {
    this.symbols.pushScope();
    try {
      build();
      return group;
    } catch (error) {
      disposeObject3D(group);
      throw error;
    } finally {
      this.symbols.popScope();
    }
  }

  /** Wrap a finished geometry in a mesh with the node's material and
   *  placement. `scaleBySize` is for builders and groups, whose `size` scales
   *  the result; a primitive's `size` is already in its geometry. */
  private finishMesh(geometry: THREE.BufferGeometry, node: { properties: ShapeProperties }, scaleBySize = true, material?: MaterialState): THREE.Mesh {
    let mesh: THREE.Mesh | undefined;
    try {
      mesh = this.makeMesh(geometry, this.createMaterial(node, material));
      this.applyExplicitTransforms(mesh, node.properties, scaleBySize);
      this.applyCurrentTransform(mesh);
      return mesh;
    } catch (error) {
      if (mesh) disposeObject3D(mesh);
      else geometry.dispose();
      throw error;
    }
  }

  /** Run `build` with the shape's own `detail` / `smoothing` in force, then
   *  restore the enclosing values. */
  private withShapeOptions<T>(properties: ShapeProperties, build: () => T): T {
    const detail = this.detailLevel;
    const smoothing = this.currentTransform().material.smoothing;
    try {
      if (properties.detail !== undefined) this.handleDetail({ type: "detail", value: properties.detail });
      if (properties.smoothing !== undefined) this.currentTransform().material.smoothing = this.evaluateNumber(properties.smoothing);
      return build();
    } finally {
      this.detailLevel = detail;
      this.symbols.set("detail", detail);
      this.currentTransform().material.smoothing = smoothing;
    }
  }

  private convertShape(node: ShapeNode): THREE.Mesh | null {
    if (node.points !== undefined) return this.placeValue(this.polygonValue(node));
    return this.withShapeOptions(node.properties, () => this.finishMesh(this.createGeometry(node), node, false));
  }

  /** Run `build` with produced values going to `sink` rather than the scene. */
  private captureValues<T>(sink: Value[], build: () => T): T {
    const previous = this.valueSink;
    this.valueSink = sink;
    try {
      return build();
    } finally {
      this.valueSink = previous;
    }
  }

  /** A value a statement produced: collected when a sink is open, otherwise
   *  a shape is placed in the scene and anything else is an error, as
   *  upstream's "unused value" is. */
  private placeValue(value: Value): THREE.Mesh | null {
    if (this.valueSink) {
      // Captured in the current frame, as a placed shape would be: a
      // `translate` before a polygon inside `mesh { }` moves that polygon.
      // A copy, so a symbol's value is not moved by using it.
      this.valueSink.push(this.transformedForCapture(value));
      return null;
    }
    if (isObjectValue(value) && value.kind === "mesh") return this.placeMesh(value);
    if (isObjectValue(value) && value.kind === "polygon") return this.placePolygons([value]);
    if (Array.isArray(value) && value.length > 0 && value.every((item) => isObjectValue(item) && (item.kind === "mesh" || item.kind === "polygon"))) {
      const meshes = value.filter((item): item is MeshValue => isObjectValue(item) && item.kind === "mesh");
      const polygons = value.filter((item): item is PolygonValue => isObjectValue(item) && item.kind === "polygon");
      const faces = polygons.length
        ? geometryFromPolygons(
            polygons,
            polygons.some((p) => p.colors),
          )
        : undefined;
      const geometry = mergeMeshGeometries([...meshes.map((mesh) => mesh.geometry), ...(faces ? [faces] : [])]);
      faces?.dispose();
      // `placeMesh` clones, so the merged geometry is an intermediate too.
      const placed = this.placeMesh({ kind: "mesh", geometry });
      geometry.dispose();
      return placed;
    }
    throw new Error("Unused value — a statement that is not a shape does nothing here; use `define` or `print`");
  }

  private transformedForCapture(value: Value): Value {
    const matrix = this.currentTransform().matrix;
    const identity = matrix.equals(new THREE.Matrix4());
    if (Array.isArray(value)) return identity ? value : value.map((item) => this.transformedForCapture(item));
    if (!isShapeValue(value) || identity) return value;
    if (value.kind === "polygon") {
      return { ...value, points: value.points.map((point) => new THREE.Vector3(...point).applyMatrix4(matrix).toArray() as Point3) };
    }
    return {
      ...value,
      geometry: value.geometry.clone().applyMatrix4(matrix),
      ...(value.polygons ? { polygons: value.polygons.map((polygon) => this.transformedForCapture(polygon) as PolygonValue) } : {}),
    };
  }

  private convertExpressionStatement(node: ExpressionStatementNode): THREE.Mesh | null {
    return this.placeValue(this.evaluator.evaluate(node.value));
  }

  /** Place a mesh value in the scene with the current material and frame.
   *  Its own vertex colours win over the material colour, as upstream. */
  private placeMesh(value: MeshValue): THREE.Mesh {
    const geometry = value.geometry.clone();
    const mesh = this.makeMesh(geometry, this.createMaterial({ properties: {} }, undefined, geometry.hasAttribute("color")));
    if (value.name !== undefined) mesh.name = value.name;
    this.applyCurrentTransform(mesh);
    return mesh;
  }

  private placePolygons(polygons: readonly PolygonValue[]): THREE.Mesh {
    const colored = polygons.some((polygon) => polygon.colors !== undefined);
    const geometry = geometryFromPolygons(polygons, colored);
    this.chargeEstimate(geometry.getAttribute("position").count);
    const mesh = this.makeMesh(geometry, this.createMaterial({ properties: {} }, undefined, colored));
    this.applyCurrentTransform(mesh);
    return mesh;
  }

  /** A geometry that stays alive as a value (a `define`d shape, a function's
   *  result) counts against the vertex budget for good, since a script can
   *  keep making them: refuse when it would overflow, then count it. */
  private chargeRetained(geometry: THREE.BufferGeometry): void {
    const count = geometry.getAttribute("position").count;
    this.chargeEstimate(count);
    this.vertexCount += count;
  }

  /** Build `nodes` at the origin in a throwaway group, collecting the values
   *  their statements produced and the geometry of every mesh they built (in
   *  the group's frame). The group is disposed and its vertex charge refunded;
   *  what is returned is the caller's to charge. */
  private buildScratch(
    nodes: readonly SceneNode[],
    after?: (captured: Value[]) => void,
  ): { captured: Value[]; geometries: THREE.BufferGeometry[]; name: string | undefined; polygons: PolygonValue[] | undefined } {
    const temporary = new THREE.Group();
    const captured: Value[] = [];
    const charged = this.vertexCount;
    try {
      this.captureValues(captured, () =>
        this.inScope(temporary, () => {
          this.currentTransform().matrix.identity();
          this.addChildren(temporary, nodes);
          after?.(captured);
        }),
      );
      const meshes = this.meshesIn(temporary);
      const geometries = meshes.map((mesh) => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      const single = meshes.length === 1 ? meshes[0] : undefined;
      const faces = single?.geometry.userData.polygons as PolygonValue[] | undefined;
      const polygons =
        single && faces
          ? faces.map((face) => ({
              ...face,
              points: face.points.map((point) => new THREE.Vector3(...point).applyMatrix4(single.matrixWorld).toArray() as Point3),
            }))
          : undefined;
      return { captured, geometries, name: single?.name || undefined, polygons };
    } finally {
      disposeObject3D(temporary);
      this.vertexCount = charged;
    }
  }

  /** `mesh { … }`: every polygon its body produces, and every mesh it builds,
   *  merged into one mesh in the current frame. */
  private convertMesh(node: MeshNode): THREE.Mesh {
    const { captured, geometries } = this.buildScratch(node.children);
    const polygons = flattenShapeValues(captured).filter((value): value is PolygonValue => value.kind === "polygon");
    const meshes = flattenShapeValues(captured).filter((value): value is MeshValue => value.kind === "mesh");
    const colored = polygons.some((polygon) => polygon.colors !== undefined);
    // Owned here: the face geometry and the scratch clones. Not owned: a mesh
    // value's geometry, which its symbol keeps.
    const owned = [...(polygons.length ? [geometryFromPolygons(polygons, colored)] : []), ...geometries];
    const parts = [...owned, ...meshes.map((mesh) => mesh.geometry)];
    if (parts.length === 0) throw new Error("`mesh` needs at least one polygon");
    const geometry = mergeMeshGeometries(parts);
    owned.forEach((part) => part.dispose());
    // The faces as written, so `.polygons` on this mesh as a value returns
    // them rather than their triangles.
    if (meshes.length === 0 && geometries.length === 0) geometry.userData = { polygons };
    const mesh = this.makeMesh(geometry, this.createMaterial({ properties: {} }, undefined, geometry.hasAttribute("color")));
    this.applyCurrentTransform(mesh);
    return mesh;
  }

  /** `polygon { point … }`: one face from explicit 3D vertices, with `color`
   *  per vertex, loops and defines, as in a path block. */
  private polygonValue(node: ShapeNode): PolygonValue {
    const points: Point3[] = [];
    const colors: RGBA[] = [];
    let color: RGBA | undefined = node.properties.color === undefined ? undefined : this.evaluateRGBA(node.properties.color);
    let colored = color !== undefined;
    const run = (command: PathCommand) => {
      if (++this.pathCommandCount > this.maxLoopIterations) throw new ShapeScriptLimitError(`ShapeScript polygon exceeds ${this.maxLoopIterations} commands`);
      switch (command.type) {
        case "define":
          this.handleDefine(command);
          break;
        case "color":
          color = this.evaluateRGBA(command.value);
          colored = true;
          break;
        case "point":
        case "curve": {
          points.push(this.pointCoordinates(command));
          colors.push(color ?? [0.8, 0.8, 0.8, 1]);
          break;
        }
        case "for":
          this.runPathLoop(command, run);
          break;
        case "detail":
          break;
        default:
          throw new Error(`\`${command.type}\` is not supported inside a polygon — list its points`);
      }
    };
    this.symbols.pushScope();
    try {
      for (const command of node.points ?? []) run(command);
    } finally {
      this.symbols.popScope();
    }
    if (points.length < 3) throw new Error("`polygon` needs at least three points");
    // The block's own position / orientation / size place its points.
    const { position, orientation, rotation, size } = node.properties;
    if (position || orientation || rotation || size) {
      const frame = new THREE.Matrix4();
      this.applyPlacement(frame, node.properties);
      for (const point of points) new THREE.Vector3(...point).applyMatrix4(frame).toArray(point);
    }
    return { kind: "polygon", points, ...(colored ? { colors } : {}) };
  }

  /** `point 1 2 3`, or `point v` where `v` is a tuple. */
  private pointCoordinates(command: PointCommand | CurveCommand): Point3 {
    // Evaluated once: `point rnd 0 0` must draw a single random number.
    const first = typeof command.x === "number" ? command.x : this.evaluator.evaluate(command.x);
    const numbers = Array.isArray(first)
      ? first.map((component) => (typeof component === "number" ? component : Number.NaN))
      : [typeof first === "number" ? first : Number.NaN, this.evaluateNumber(command.y), command.z === undefined ? 0 : this.evaluateNumber(command.z)];
    const [x = 0, y = 0, z = 0] = numbers;
    if (![x, y, z].every(Number.isFinite)) throw new Error("Expected finite point coordinates");
    return [x, y, z];
  }

  private meshesIn(root: THREE.Object3D): THREE.Mesh[] {
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    return meshes;
  }

  /** A shape as a value: built at the origin in a scratch group, its meshes
   *  merged into one geometry the script can read members of and place. A
   *  polygon block or a function that returned one is that value itself. */
  private shapeValue(node: SceneNode): Value {
    const { captured, geometries, name, polygons } = this.buildScratch([node]);
    if (geometries.length === 0) {
      if (captured.length === 1) return captured[0]!;
      if (captured.length > 1) return captured;
      throw new Error("The shape used as a value produced nothing");
    }
    const geometry = mergeMeshGeometries(geometries);
    geometries.forEach((part) => part.dispose());
    this.chargeRetained(geometry);
    return { kind: "mesh", geometry, ...(name === undefined ? {} : { name }), ...(polygons === undefined ? {} : { polygons }) };
  }

  /** A function whose body builds shapes: run it at the origin with its
   *  parameters bound, and return what it built — one value, or a tuple. */
  private callShapeFunction(fn: FunctionValue, args: Value[]): Value {
    const { params = [], body = [], value, name } = fn.definition;
    return this.evaluator.withArguments(params, args, () => {
      const { captured, geometries } = this.buildScratch(body, (values) => {
        if (value !== undefined) values.push(this.evaluator.evaluate(value));
      });
      for (const geometry of geometries) {
        this.chargeRetained(geometry);
        captured.push({ kind: "mesh", geometry });
      }
      if (captured.length === 0) throw new Error(`Function \`${name}\` produced no value`);
      return captured.length === 1 ? captured[0]! : captured;
    });
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
    const size = this.evaluateSize(node.properties.size);

    switch (node.primitive) {
      case "cube":
        this.requireExtent("cube", size);
        return new THREE.BoxGeometry(size[0], size[1], size[2]);

      // `size` is the DIAMETER of every curved primitive, as upstream: a
      // `sphere` with no size fits the unit cube, not a 2-unit one.
      case "sphere":
        this.requireExtent("sphere", size);
        return new THREE.SphereGeometry(0.5, this.detailLevel, this.detailLevel).scale(...size);

      case "icosphere":
        this.requireExtent("icosphere", size);
        // Euclid's construction, face for face, so `.polygons` indexes as upstream.
        return icosphereGeometry(0.5, icosphereSubdivisions(this.detailLevel)).geometry.scale(...size);

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

      case "torus":
        return this.createTorus(node, size);

      case "circle": {
        const radius = (size[0] || 1) / 2;
        return new THREE.CircleGeometry(radius, this.detailLevel);
      }

      case "square": {
        const sideLength = size[0] || 1;
        return new THREE.PlaneGeometry(sideLength, size[1] || sideLength);
      }

      case "roundrect":
        return this.createRoundrect(node, size);

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

  /** `roundrect { size w h radius r }`: the corner radius is `r` times the
   *  smaller side (default 0.25), as upstream. */
  private createRoundrect(node: ShapeNode, size: Vector3): THREE.BufferGeometry {
    const width = size[0] || 1;
    const height = size[1] || width;
    const proportion = node.properties.radius === undefined ? 0.25 : this.evaluateNumber(node.properties.radius);
    const radius = Math.min(Math.max(0, proportion) * Math.min(width, height), width / 2, height / 2);
    const shape = new THREE.Shape();
    const w = width / 2;
    const h = height / 2;
    shape.moveTo(-w + radius, -h);
    shape.lineTo(w - radius, -h);
    shape.absarc(w - radius, -h + radius, radius, -Math.PI / 2, 0, false);
    shape.lineTo(w, h - radius);
    shape.absarc(w - radius, h - radius, radius, 0, Math.PI / 2, false);
    shape.lineTo(-w + radius, h);
    shape.absarc(-w + radius, h - radius, radius, Math.PI / 2, Math.PI, false);
    shape.lineTo(-w, -h + radius);
    shape.absarc(-w + radius, -h + radius, radius, Math.PI, Math.PI * 1.5, false);
    shape.closePath();
    const segments = Math.max(1, Math.floor(this.detailLevel / 4));
    this.chargePathEstimate(shape, segments);
    return new THREE.ShapeGeometry(shape, segments);
  }

  /** A plugin extension (upstream has no torus). `size` is the OVERALL
   *  diameter, tube included, so it follows the same rule as the other curved
   *  primitives: the ring radius is what is left once the tube is subtracted.
   *  `outerRadius` (ring) and `innerRadius` (tube) override the derivation. */
  private createTorus(node: ShapeNode, size: Vector3): THREE.BufferGeometry {
    const TUBE_TO_RING = 0.4;
    const overall = size[0] / 2;
    const explicitTube = node.properties.innerRadius ? this.evaluateNumber(node.properties.innerRadius) : undefined;
    const explicitRing = node.properties.outerRadius ? this.evaluateNumber(node.properties.outerRadius) : undefined;
    const ringRadius = explicitRing ?? (explicitTube === undefined ? overall / (1 + TUBE_TO_RING) : overall - explicitTube);
    const tubeRadius = explicitTube ?? ringRadius * TUBE_TO_RING;
    if (ringRadius <= 0) throw new Error("`torus` tube is as wide as the whole shape — its ring has no radius left");
    this.requireExtent("torus", [ringRadius, tubeRadius]);
    return new THREE.TorusGeometry(ringRadius, tubeRadius, Math.max(3, Math.floor(this.detailLevel / 2)), this.detailLevel);
  }

  /** The material state a shape's own properties produce on top of `base`:
   *  a `material` bundle first, then the individual properties, the way the
   *  same commands would apply in order inside its block. */
  private materialFor(properties: MaterialProperties & { material?: Expression | undefined }, base: MaterialState): MaterialState {
    const state = cloneMaterialState(base);
    if (properties.material !== undefined) this.applyMaterialValue(state, this.evaluator.evaluate(properties.material));
    if (properties.color !== undefined) this.applyColor(state, this.evaluateRGBA(properties.color));
    if (properties.opacity !== undefined) state.opacity *= this.evaluateNumber(properties.opacity);
    if (properties.metallicity !== undefined) state.metallicity = this.evaluateNumber(properties.metallicity);
    if (properties.roughness !== undefined) state.roughness = this.evaluateNumber(properties.roughness);
    if (properties.glow !== undefined) state.glow = this.glowColor(this.evaluator.evaluate(properties.glow));
    if (properties.texture !== undefined) this.warnTexture(this.evaluator.evaluate(properties.texture));
    return state;
  }

  private applyColor(state: MaterialState, [r, g, b, a]: RGBA): void {
    state.color = new THREE.Color(r, g, b);
    state.alpha = a;
  }

  /** `glow` takes a colour or a brightness; the alpha is ignored upstream. */
  private glowColor(value: Value): THREE.Color {
    const [r, g, b] = this.requireFiniteColor(rgbaOf(value));
    return new THREE.Color(r, g, b);
  }

  private warnTexture(value: Value): void {
    if (value === "") return;
    this.warn(`texture "${String(value)}" is not supported — the shape is drawn with its colour instead`);
  }

  private applyMaterialValue(state: MaterialState, value: Value): void {
    if (typeof value !== "object" || Array.isArray(value) || value.kind !== "material") throw new Error("`material` needs a value made with `material { … }`");
    const material: MaterialValue = value;
    if (material.color) this.applyColor(state, this.requireFiniteColor(material.color));
    if (material.opacity !== undefined) state.opacity *= material.opacity;
    if (material.metallicity !== undefined) state.metallicity = material.metallicity;
    if (material.roughness !== undefined) state.roughness = material.roughness;
    if (material.glow) state.glow = this.glowColor(material.glow);
    if (material.texture !== undefined) this.warnTexture(material.texture);
  }

  private createMaterial(node: { properties: ShapeProperties }, base?: MaterialState, vertexColors = false): THREE.Material {
    // A per-shape property wins; otherwise the enclosing scope's commands
    // apply. Opacity is the colour's alpha times every `opacity` in scope.
    const state = this.materialFor(node.properties, base ?? this.currentTransform().material);
    const opacity = Math.max(0, state.alpha * state.opacity);
    return new THREE.MeshStandardMaterial({
      // Vertex colours multiply the material colour, so a coloured mesh keeps its own.
      color: vertexColors ? new THREE.Color(1, 1, 1) : (state.color?.clone() ?? new THREE.Color(0.8, 0.8, 0.8)),
      vertexColors,
      opacity: Math.min(1, opacity),
      transparent: opacity < 1,
      ...(state.metallicity === undefined ? {} : { metalness: Math.min(1, Math.max(0, state.metallicity)) }),
      ...(state.roughness === undefined ? {} : { roughness: Math.min(1, Math.max(0, state.roughness)) }),
      ...(state.glow === undefined ? {} : { emissive: state.glow.clone() }),
      flatShading: state.smoothing !== undefined && state.smoothing <= 0,
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

    // Symbols are scoped to the loop; transforms and materials are not.
    return this.inSymbolScope(group, () => {
      // A range or a tuple; both go through the same bounded expansion, so
      // neither form can run the body more times than the budget allows.
      for (const value of this.iterations(node.iterable)) {
        this.symbols.set(node.variable, value);
        // Convert body nodes directly - no iteration sub-groups.
        // Transforms accumulate across iterations within the loop scope.
        this.addChildren(group, node.body);
      }
    });
  }

  /** Expand a loop's iterable without materialising an absurd range first:
   *  the walk stops at the budget rather than after allocating past it. */
  private iterations(iterable: Expression): Value[] {
    return iterationValues(
      this.evaluator.evaluate(iterable),
      this.maxLoopIterations,
      () => new ShapeScriptLimitError(`ShapeScript loop exceeds ${this.maxLoopIterations} iterations — narrow the range or increase the step`),
    );
  }

  private convertIf(node: IfNode): THREE.Group {
    const group = new THREE.Group();

    // Evaluated BEFORE the scope is pushed, as it always was.
    const condition = this.evaluator.evaluateToBoolean(node.condition);

    return this.inSymbolScope(group, () => this.addChildren(group, condition ? node.thenBody : (node.elseBody ?? [])));
  }

  private convertSwitch(node: SwitchNode): THREE.Group {
    const group = new THREE.Group();

    // Evaluate switch value
    const switchValue = this.evaluator.evaluate(node.value);

    return this.inSymbolScope(group, () => {
      const matched = node.cases.find((caseNode) => caseNode.values.some((caseValue) => valuesEqual(switchValue, this.evaluator.evaluate(caseValue))));
      this.addChildren(group, matched ? matched.body : (node.defaultCase ?? []));
    });
  }

  private handleDefine(node: DefineNode): void {
    // A value or a function is the evaluator's; a custom shape block is kept
    // here, since its body is scene nodes.
    if (this.evaluator.define(node)) return;
    if (node.body !== undefined || node.options !== undefined) {
      // Custom shape definition: define shape { ... }
      // Store the entire node for later instantiation
      // Note: We cast to Value since SymbolTable expects Value, but we know it's a DefineNode
      this.symbols.set(node.name, node as unknown as Value);
    }
  }

  private convertCustomShape(node: CustomShapeNode): THREE.Object3D | null {
    // Look up the custom shape definition
    const definition = this.symbols.get(node.name);

    // A symbol holding a shape value (`define ico icosphere { … }` then `ico`)
    // is placed, with the call's options as its placement.
    if (definition !== undefined && isShapeValue(definition)) {
      const group = new THREE.Group();
      return this.inScope(group, () => {
        this.applyPlacement(this.currentTransform().matrix, node.properties as ShapeProperties);
        const placed = this.placeValue(definition);
        if (placed) group.add(placed);
      });
    }

    if (definition === undefined) throw new Error(`Unknown shape: ${node.name}`);
    // A plain value named as a statement: the result a function body ends
    // with, collected there; anywhere else an unused value.
    if (typeof definition !== "object" || Array.isArray(definition) || !("type" in definition)) return this.placeValue(definition);

    const defineNode = definition as unknown as DefineNode;

    if (!defineNode.body) {
      throw new Error(`Custom shape '${node.name}' has no body`);
    }

    // Same scope handling as every other group builder: a body node that throws
    // must not strand the group (a custom shape can be a CSG operand, where
    // nothing downstream ever sees it) or leave the frames behind.
    const group = new THREE.Group();
    const body = defineNode.body;
    const { position, orientation, rotation, size, name, ...rest } = node.properties as ShapeProperties & Record<string, unknown>;
    return this.inScope(group, () => {
      // The standard options place the block's output, as on any shape; the
      // material ones set the scope its body runs in.
      this.applyPlacement(this.currentTransform().matrix, { position, orientation, rotation, size } as ShapeProperties);
      this.currentTransform().material = this.materialFor(rest as MaterialProperties, this.currentTransform().material);

      // Set default values from options
      for (const option of defineNode.options ?? []) {
        this.symbols.set(option.name, this.evaluator.evaluate(option.defaultValue));
      }

      // Override with provided properties
      for (const [key, value] of Object.entries(rest)) {
        if (!(key in STANDARD_KEYS)) this.symbols.set(key, this.evaluator.evaluate(value as Expression));
      }

      if (name !== undefined) group.name = String(this.evaluator.evaluate(name as Expression));

      // Convert the body, under the call's own `detail` / `smoothing`.
      this.withShapeOptions(rest as ShapeProperties, () => this.addChildren(group, body));
    });
  }

  /** Post-multiply a shape's `position` / `orientation` / `size` into a frame. */
  private applyPlacement(matrix: THREE.Matrix4, properties: ShapeProperties): void {
    const position = properties.position ? new THREE.Vector3(...this.evaluateVector3(properties.position)) : new THREE.Vector3();
    const rotation = properties.orientation ?? properties.rotation;
    const quaternion = rotation ? this.rotationOf(rotation) : new THREE.Quaternion();
    const scale = properties.size ? new THREE.Vector3(...this.evaluateSize(properties.size)) : new THREE.Vector3(1, 1, 1);
    matrix.multiply(new THREE.Matrix4().compose(position, quaternion, scale));
  }

  private pushTransform(): void {
    const current = this.currentTransform();
    this.transformStack.push({
      matrix: current.matrix.clone(),
      material: cloneMaterialState(current.material),
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
    return (
      top ?? {
        matrix: new THREE.Matrix4(),
        material: { color: undefined, alpha: 1, opacity: 1, metallicity: undefined, roughness: undefined, glow: undefined, smoothing: undefined },
      }
    );
  }

  private applyCurrentTransform(object: THREE.Object3D): void {
    const transform = this.currentTransform();
    object.applyMatrix4(transform.matrix);
  }

  private applyExplicitTransforms(object: THREE.Object3D, properties: ShapeProperties, scaleBySize = false): void {
    if (properties.position) {
      const pos = this.evaluateVector3(properties.position);
      object.position.set(...pos);
    }

    // `orientation` is upstream's name; `rotation` is kept as an alias.
    const orientation = properties.orientation ?? properties.rotation;
    if (orientation) {
      object.quaternion.copy(this.rotationOf(orientation));
    }
    if (scaleBySize && properties.size) object.scale.set(...this.evaluateSize(properties.size));
    if (properties.name !== undefined) object.name = String(this.evaluator.evaluate(properties.name));
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
      // Scale by the largest component first: `lengthSq` of `1e200` overflows
      // to infinity and `normalize` would collapse a valid axis to zero.
      const largest = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      if (largest === 0) throw new Error("Rotation axis must not be zero");
      const axis = new THREE.Vector3(x / largest, y / largest, z / largest).normalize();
      return new THREE.Quaternion().setFromAxisAngle(axis, -angle * Math.PI);
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
    this.applyColor(this.currentTransform().material, this.evaluateRGBA(node.value));
  }

  private handleMaterialCommand(node: MaterialNode): void {
    const state = this.currentTransform().material;
    switch (node.property) {
      case "opacity":
        state.opacity *= this.evaluateNumber(node.value);
        break;
      case "metallicity":
        state.metallicity = this.evaluateNumber(node.value);
        break;
      case "roughness":
        state.roughness = this.evaluateNumber(node.value);
        break;
      case "glow":
        state.glow = this.glowColor(this.evaluator.evaluate(node.value));
        break;
      case "texture":
        this.warnTexture(this.evaluator.evaluate(node.value));
        break;
      case "material":
        this.applyMaterialValue(state, this.evaluator.evaluate(node.value));
        break;
    }
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
    const scale = this.evaluateSize(node.value);
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

  /** `size` on an extrude: X and Y scale the profile, Z is the depth. The
   *  depth goes into the geometry (centred on the profile plane, as
   *  upstream), so the mesh keeps a unit Z scale. */
  private extrudeProperties(node: ExtrudeNode): { depth: number; properties: ShapeProperties } {
    const size = node.properties.size ? this.evaluateSize(node.properties.size) : [1, 1, 1];
    const depth = size[2] || 1;
    return { depth, properties: { ...node.properties, size: [size[0] ?? 1, size[1] ?? 1, 1] } };
  }

  private convertExtrude(node: ExtrudeNode): THREE.Mesh {
    return this.withShapeOptions(node.properties, () => {
      const { depth, properties } = this.extrudeProperties(node);
      if (!node.path) {
        return this.buildFromChildren({ children: node.children ?? [], properties }, (meshes) => {
          const shapes = meshes.map((mesh) => this.planarShape(mesh));
          if (!shapes.length) throw new Error("Extrude requires a path or planar shape");
          for (const shape of shapes) this.chargePathEstimate(shape, 1, 12);
          return new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 1 }).translate(0, 0, -depth / 2);
        });
      }
      const shape = this.requireEnclosedArea(this.buildPath(node.path), "extrude");

      // Create extruded geometry
      const curveSegments = Math.max(1, Math.floor(this.detailLevel / 4));
      this.chargePathEstimate(shape, curveSegments, EXTRUDE_VERTICES_PER_POINT);

      // Centred on the profile plane (±depth / 2), as upstream extrudes.
      const geometry = this.placePath(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments }).translate(0, 0, -depth / 2), node.path);
      return this.finishMesh(geometry, { properties });
    });
  }

  private buildPath(pathNode: PathNode): THREE.Shape {
    return this.shapeFromPathPoints(this.collectPathPoints(pathNode));
  }

  /** Bake the path's own `position` / `orientation` / `size` into geometry
   *  built from it. Baked rather than set on the mesh so the consuming
   *  builder's own options (an `extrude { position … }`) still apply on top,
   *  the way they do upstream where the path is a placed shape. */
  private placePath<T extends THREE.BufferGeometry>(geometry: T, pathNode: PathNode): T {
    const properties = pathNode.properties;
    if (!properties) return geometry;
    const frame = new THREE.Matrix4();
    this.applyPlacement(frame, properties);
    return geometry.applyMatrix4(frame);
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
      if (command.z !== undefined && Math.abs(this.evaluateNumber(command.z)) > PATH_POINT_EPSILON) {
        throw new Error("Paths here are planar — a `point` / `curve` may not have a nonzero third coordinate");
      }
      this.placePathPoint(frame, points, this.evaluateNumber(command.x), this.evaluateNumber(command.y), command.type === "curve");
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
        case "arc":
          this.placeArc(frame, points, command);
          break;
        case "rotate":
          // Half-turns, clockwise positive — the same convention as `rotate` on a shape.
          move(new THREE.Matrix4().makeRotationZ(-this.evaluateNumber(command.angle) * Math.PI));
          break;
        case "translate":
          move(new THREE.Matrix4().makeTranslation(this.evaluateNumber(command.x), this.evaluateNumber(command.y), 0));
          break;
        case "scale": {
          const x = this.evaluateNumber(command.x);
          move(new THREE.Matrix4().makeScale(x, command.y === undefined ? x : this.evaluateNumber(command.y), 1));
          break;
        }
        case "for":
          this.runPathLoop(command, processCommand);
          break;
        case "color":
          // Path point colours are not drawn here; the value is checked so a
          // bad one is still an error.
          this.evaluateRGBA(command.value);
          break;
      }
    };

    for (const command of pathNode.commands) {
      processCommand(command);
    }
    return points;
  }

  private placePathPoint(frame: THREE.Matrix4, points: PathPoint[], x: number, y: number, curved: boolean): void {
    const position = new THREE.Vector3(x, y, 0).applyMatrix4(frame);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error("Path coordinates overflowed to a non-finite value");
    points.push({ x: position.x, y: position.y, curved });
  }

  /** `arc { angle a }`: `a` half-turns clockwise from +Y at radius `size / 2`,
   *  placed by its own position/orientation, sampled as corners at the current
   *  detail (upstream's own segment count for the span). */
  private placeArc(frame: THREE.Matrix4, points: PathPoint[], command: ArcCommand): void {
    const angle = command.angle === undefined ? 1 : this.evaluateNumber(command.angle);
    const span = Math.min(2, Math.abs(angle));
    if (span === 0) throw new Error("`arc` needs a nonzero angle");
    const segments = Math.max(span < 0.5 ? 1 : span < 1 ? 2 : 3, Math.ceil((span / 2) * this.detailLevel));
    const radius = (command.size === undefined ? 1 : this.evaluateSize(command.size)[0]) / 2;
    const local = new THREE.Matrix4();
    this.applyPlacement(local, {
      ...(command.position ? { position: command.position } : {}),
      ...(command.orientation ? { orientation: command.orientation } : {}),
    });
    const placed = frame.clone().multiply(local);
    const sign = Math.sign(angle);
    for (let i = 0; i <= segments; i++) {
      const theta = ((sign * span * i) / segments) * Math.PI;
      this.placePathPoint(placed, points, Math.sin(theta) * radius, Math.cos(theta) * radius, false);
    }
  }

  private runPathLoop(command: ForLoopPathCommand, processCommand: (command: PathCommand) => void): void {
    this.symbols.pushScope();
    try {
      // Path commands never reach `convertNode`, so `maxNodes` cannot stop
      // this one — the shared bounded iterator is the only ceiling here.
      for (const value of this.iterations(command.iterable)) {
        this.symbols.set(command.variable, value);
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
    // In ShapeScript, the path defines the profile. The other children are
    // state commands (`material steel`, `detail 64`) that apply to the result.
    let pathNode: PathNode | null = null;
    for (const child of node.children) {
      if (child.type === "path") {
        if (pathNode) throw new Error("`lathe` takes one profile path");
        pathNode = child;
      } else {
        const object = this.convertNode(child);
        if (object) {
          // Never reaches the scene, so nothing downstream would free it.
          disposeObject3D(object);
          throw new Error("`lathe` takes a path, not a shape — give it `path { … }`");
        }
      }
    }

    if (!pathNode) {
      throw new Error("Lathe requires a path child");
    }
    // Upstream transforms the profile before revolving it; a 3D orientation
    // on a profile has no 2D equivalent here, so refuse rather than guess.
    if (pathNode.properties) throw new Error("`lathe` does not support position/orientation/size on its profile path — place the lathe itself instead");

    return this.withShapeOptions(node.properties, () => {
      const shape = this.buildPath(pathNode);
      this.chargePathEstimate(shape, this.detailLevel, this.detailLevel + 1);
      const points = shape.getPoints(this.detailLevel);

      if (points.length < 2) {
        throw new Error("Lathe path must have at least 2 points");
      }
      this.requireLatheProfile(points);
      // A profile drawn on the -X side (upstream's examples do this) revolves
      // to the same solid; LatheGeometry needs it on +X to face outward.
      if (points.every((point) => point.x <= PATH_POINT_EPSILON)) for (const point of points) point.x = -point.x;

      // What `LatheGeometry` is about to allocate: one ring of `detail + 1`
      // vertices per profile point. Checked BEFORE the constructor runs, since by
      // the time `makeMesh` could measure it the memory is already committed.
      this.chargeEstimate(points.length * (this.detailLevel + 1));

      // LatheGeometry winds its faces from the profile's direction, so a
      // profile drawn top-down (upstream's chess pieces all are) comes out
      // inside out — which three-bvh-csg then drops from a union. Orient it
      // outward by the signed volume, as Euclid does from the profile plane.
      const geometry = orientOutward(new THREE.LatheGeometry(points, this.detailLevel));
      return this.finishMesh(geometry, node, true, this.currentTransform().material);
    });
  }

  /** Build `children` into a throwaway group at the block's own origin and hand
   *  back every mesh in it, world matrices already resolved. The group stays
   *  owned by the caller, which disposes it. */
  private buildOperands(temporary: THREE.Group, children: SceneNode[]): { meshes: THREE.Mesh[]; material: MaterialState } {
    let material = this.currentTransform().material;
    this.operandDepth++;
    try {
      this.inScope(temporary, () => {
        this.currentTransform().matrix.identity();
        this.addChildren(temporary, children);
        // The material the block ends with is the builder's own — upstream a
        // `material steel` inside `lathe { … }` colours the lathe.
        material = cloneMaterialState(this.currentTransform().material);
      });
    } finally {
      this.operandDepth--;
    }
    temporary.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    temporary.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    });
    return { meshes, material };
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
    let material: MaterialState;
    try {
      const operands = this.buildOperands(temporary, node.children);
      material = operands.material;
      geometry = build(operands.meshes);
    } finally {
      disposeObject3D(temporary);
      this.vertexCount = chargedBeforeOperands;
    }
    return this.finishMesh(geometry, node, true, material);
  }

  private convertLoft(node: LoftNode): THREE.Object3D {
    return this.withShapeOptions(node.properties, () => this.buildLoft(node));
  }

  private buildLoft(node: LoftNode): THREE.Object3D {
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
      const pathNode = node.children.length === 1 ? node.children.find((child): child is PathNode => child.type === "path") : undefined;
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
      const geometry = this.placePath(new THREE.ShapeGeometry(shape), pathNode);
      return this.finishMesh(geometry, node);
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

  /** A `size`: one value is uniform, two are `x y x` (a cylinder's diameter
   *  and height), three are as given — Euclid's `Vector(size:)`. */
  private evaluateSize(value: Vector3 | Expression | undefined): Vector3 {
    if (value === undefined) return [1, 1, 1];
    const raw: Value = Array.isArray(value) && typeof value[0] === "number" ? (value as number[]) : this.evaluator.evaluate(value as Expression);
    const components = (Array.isArray(raw) ? raw : [raw]).map((component) => {
      if (typeof component !== "number" || !Number.isFinite(component)) throw new Error("Expected finite size components");
      return component;
    });
    const [x = 1, y = x, z = x] = components;
    return [x, y, z];
  }

  private evaluateRGBA(value: Color | Expression): RGBA {
    return this.requireFiniteColor(this.evaluator.evaluateToRGBA(value));
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

  /** Colour channels get the same treatment as sizes and translations.
   *  `new THREE.Color(Infinity, …)` throws nothing — it serialises as
   *  `[null, null, null]`, so validation reported success and the browser was
   *  handed a material it cannot draw. */
  private requireFiniteColor<T extends readonly number[]>(channels: T): T {
    if (!channels.every(Number.isFinite)) throw new Error("Expected finite color channels");
    return channels;
  }
}

/** The keys a custom block call places or colours with, rather than passing
 *  to the block as option values. */
const STANDARD_KEYS: Record<string, true> = {
  position: true,
  orientation: true,
  rotation: true,
  size: true,
  color: true,
  opacity: true,
  material: true,
  metallicity: true,
  roughness: true,
  glow: true,
  texture: true,
  detail: true,
  smoothing: true,
};

/** Mesh and polygon values, at any depth of tuple. */
function flattenShapeValues(values: readonly Value[]): (MeshValue | PolygonValue)[] {
  const shapes: (MeshValue | PolygonValue)[] = [];
  for (const value of values) {
    if (Array.isArray(value)) shapes.push(...flattenShapeValues(value));
    else if (isShapeValue(value)) shapes.push(value);
  }
  return shapes;
}

function isShapeValue(value: Value): value is MeshValue | PolygonValue {
  return isObjectValue(value) && (value.kind === "mesh" || value.kind === "polygon");
}

/** Merge geometries into one non-indexed geometry carrying position, normal,
 *  uv and — when any part has it — colour, so parts from different sources
 *  (a lathe, a polygon list, a CSG result) combine. The inputs are not
 *  touched (each is cloned first), so the caller disposes the ones it owns;
 *  the result is always a new geometry. */
function mergeMeshGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const colored = parts.some((part) => part.hasAttribute("color"));
  const prepared = parts.map((part) => {
    const flat = part.index ? part.toNonIndexed() : part.clone();
    if (!flat.hasAttribute("normal")) flat.computeVertexNormals();
    const count = flat.getAttribute("position").count;
    if (!flat.hasAttribute("uv")) flat.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (colored && !flat.hasAttribute("color")) flat.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(0.8), 3));
    for (const name of Object.keys(flat.attributes)) {
      if (!["position", "normal", "uv", "color"].includes(name)) flat.deleteAttribute(name);
    }
    flat.clearGroups();
    return flat;
  });
  const merged = prepared.length === 1 ? prepared[0]! : mergeGeometries(prepared);
  if (!merged) throw new Error("Could not combine the shapes into one mesh");
  if (prepared.length > 1) prepared.forEach((part) => part.dispose());
  return merged;
}

/** `print` output, one value per space, tuples in parentheses. */
function printable(value: Value): string {
  if (Array.isArray(value)) return value.map((item) => (Array.isArray(item) ? `(${printable(item)})` : printable(item))).join(" ");
  if (typeof value === "object") return value.kind === "range" ? `${value.from} to ${value.to} step ${value.step}` : `<${value.kind}>`;
  return String(value);
}

// Main export function
export function astToThreeJS(nodes: SceneNode[], options: ConversionOptions = {}): THREE.Group {
  const converter = new Converter(options);
  return converter.convert(nodes);
}
