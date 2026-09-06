import * as THREE from "three";
import { Brush, Evaluator as CSGEvaluator, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
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
import { disposeScratch } from "./dispose";

export interface ConversionOptions {
  wireframe?: boolean;
  /** Hard ceiling on the objects one script may produce. See
   *  `DEFAULT_MAX_NODES`. */
  maxNodes?: number;
  /** Hard ceiling on the iterations one `for` may run. See
   *  `DEFAULT_MAX_LOOP_ITERATIONS`. */
  maxLoopIterations?: number;
}

// Conversion runs synchronously on the browser's main thread, and the script is
// LLM-authored — a stray `for i in 1 to 100000000` is a plausible accident, not
// only an attack. Without a ceiling that call allocates until the tab dies, and
// the user cannot even read the error because nothing yields. Both limits are
// far above any legible model (the shipped samples peak in the dozens) and far
// below what hurts: 20k meshes render, 100M do not.
export const DEFAULT_MAX_NODES = 20_000;
export const DEFAULT_MAX_LOOP_ITERATIONS = 100_000;

/** Its own class so `convertCSG`'s fallback can rethrow it instead of swallowing
 *  it: catching a budget error there would rebuild the same runaway children as
 *  a plain group, which is the work the budget exists to refuse. */
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
  private detailLevel: number = 32; // Default detail level for curved shapes
  /** Objects produced so far, checked against `maxNodes` on every node. */
  private nodeCount = 0;

  // Transform state stack for relative transforms
  private transformStack: TransformState[] = [];

  constructor(options: ConversionOptions = {}) {
    this.options = options;
    this.symbols = new SymbolTable();
    this.evaluator = new Evaluator(this.symbols);
    // Initialize with identity transform
    this.pushTransform();
  }

  convert(nodes: SceneNode[]): THREE.Group {
    const group = new THREE.Group();

    for (const node of nodes) {
      const object = this.convertNode(node);
      if (object) {
        group.add(object);
      }
    }

    return group;
  }

  private get maxNodes(): number {
    return this.options.maxNodes ?? DEFAULT_MAX_NODES;
  }

  private get maxLoopIterations(): number {
    return this.options.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
  }

  /** Expand a `for … from to to step` range without materialising it first.
   *  The array used to be built up front, so an absurd bound exhausted memory
   *  before a single node existed and the budget below never got a turn. */
  private rangeIterations(from: number, to: number, step: number): number[] {
    if (step === 0 || !Number.isFinite(step) || !Number.isFinite(from) || !Number.isFinite(to)) return [];
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
      default:
        console.warn(`Unknown node type: ${(node as { type: string }).type}`);
        return null;
    }
  }

  private convertBlock(node: { children: SceneNode[] }): THREE.Group {
    const group = new THREE.Group();

    // Create new scope for block
    this.symbols.pushScope();
    this.pushTransform();

    for (const child of node.children) {
      const object = this.convertNode(child);
      if (object) {
        group.add(object);
      }
    }

    // Pop scope
    this.popTransform();
    this.symbols.popScope();

    return group;
  }

  private convertShape(node: ShapeNode): THREE.Mesh {
    const geometry = this.createGeometry(node);
    const material = this.createMaterial(node);
    const mesh = new THREE.Mesh(geometry, material);

    // Apply any property-specific transforms first (local)
    this.applyExplicitTransforms(mesh, node.properties);

    // Then apply the current scope transform so relative transforms compose correctly
    this.applyCurrentTransform(mesh);

    return mesh;
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
        return new THREE.BoxGeometry(size[0], size[1], size[2]);

      case "sphere":
        return new THREE.SphereGeometry(size[0], this.detailLevel, this.detailLevel);

      case "cylinder": {
        const radiusTop = node.properties.radiusTop ? this.evaluateNumber(node.properties.radiusTop) : size[0];
        const radiusBottom = node.properties.radiusBottom ? this.evaluateNumber(node.properties.radiusBottom) : size[0];
        const height = node.properties.height ? this.evaluateNumber(node.properties.height) : size[1];
        return new THREE.CylinderGeometry(radiusTop, radiusBottom, height, this.detailLevel);
      }

      case "cone": {
        const radius = size[0];
        const height = node.properties.height ? this.evaluateNumber(node.properties.height) : size[1];
        return new THREE.ConeGeometry(radius, height, this.detailLevel);
      }

      case "torus": {
        const outerRadius = node.properties.outerRadius ? this.evaluateNumber(node.properties.outerRadius) : size[0];
        const innerRadius = node.properties.innerRadius ? this.evaluateNumber(node.properties.innerRadius) : 0.4;
        return new THREE.TorusGeometry(outerRadius, innerRadius, Math.max(3, Math.floor(this.detailLevel / 2)), this.detailLevel);
      }

      case "circle": {
        const radius = size[0] || 1;
        return new THREE.CircleGeometry(radius, this.detailLevel);
      }

      case "square": {
        const sideLength = size[0] || 1;
        return new THREE.PlaneGeometry(sideLength, sideLength);
      }

      case "polygon": {
        // TODO: Support variable sides via properties
        const radius = size[0] || 1;
        const sides = 6; // Default hexagon
        return new THREE.CircleGeometry(radius, sides);
      }

      default:
        console.warn(`Unknown primitive: ${node.primitive}`);
        return new THREE.BoxGeometry(1, 1, 1);
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

    // Declared outside the try so the fallback path below can free whatever had
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
      // unwinds the frames instead of leaving one behind for the fallback path
      // (which pushes a scope of its own) to inherit.

      // Reset to identity for block's local coordinate space. The MATRIX only:
      // an enclosing `color` is not a coordinate, and clearing it made
      // `color 1 0 0` apply to a plain `cube` but not to a `difference` beside
      // it. `pushTransform` already cloned the inherited colour.
      this.currentTransform().matrix.identity();

      const meshes: THREE.Mesh[] = [];
      try {
        for (const child of node.children) {
          const object = this.convertNode(child);
          if (object) scratch.push(object);
          if (object instanceof THREE.Mesh) {
            // Clone the mesh to avoid modifying the original
            const clonedMesh = object.clone();
            clonedMesh.updateMatrixWorld(true);
            meshes.push(clonedMesh);
          } else if (object instanceof THREE.Group) {
            // Extract meshes from group
            object.traverse((obj) => {
              if (obj instanceof THREE.Mesh) {
                const clonedMesh = obj.clone();
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
          case "stencil":
            // Stencil keeps shape of first but 'paints' the intersecting areas
            result = evaluate(result, brush, INTERSECTION);
            break;
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
      // A budget refusal is not a CSG failure — rebuilding the same children as
      // a plain group would do exactly the work the budget refused. Nothing
      // survives this path, so everything built before the refusal is freed:
      // a rejected preview would otherwise leak whatever the earlier children
      // had already allocated, once per attempt.
      if (error instanceof ShapeScriptLimitError) {
        disposeScratch(scratch, new THREE.Group());
        throw error;
      }
      // Return original shapes as a group if CSG fails
      const fallbackGroup = new THREE.Group();

      // Same scopes as the success path, for the same reason: the children must
      // be built in the BLOCK's coordinate space, because `savedMatrix` — the
      // enclosing transform — is applied to the group below. Pushing only a
      // symbol scope left the parent transform active while converting, so it
      // landed twice on every fallback shape.
      this.symbols.pushScope();
      this.pushTransform();
      this.currentTransform().matrix.identity();

      try {
        for (const child of node.children) {
          const object = this.convertNode(child);
          if (object) {
            fallbackGroup.add(object);
          }
        }
      } finally {
        this.popTransform();
        this.symbols.popScope();
      }

      // Apply saved transform to fallback group
      fallbackGroup.applyMatrix4(savedMatrix);
      fallbackGroup.updateMatrixWorld(true);

      // Whatever had been built before the failure is unreachable now — the
      // fallback rebuilds the children from scratch — so free it here too.
      // Excluded by resource again, in case any of it is shared.
      disposeScratch(scratch, fallbackGroup);

      return fallbackGroup;
    }
  }

  private convertForLoop(node: ForLoopNode): THREE.Group {
    const group = new THREE.Group();

    // Create new scope for loop - both symbols and transforms
    // Transforms accumulate across iterations but are scoped to the loop
    this.symbols.pushScope();
    this.pushTransform();

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
        for (const bodyNode of node.body) {
          const object = this.convertNode(bodyNode);
          if (object) {
            group.add(object);
          }
        }
      }
    } else {
      // for i in from to to
      const from = this.evaluateNumber(node.from);
      const to = this.evaluateNumber(node.to);
      const step = node.step ? this.evaluateNumber(node.step) : 1;

      const iterations = this.rangeIterations(from, to, step);

      for (const i of iterations) {
        this.symbols.set(node.variable, i);

        // Convert body nodes directly - no iteration sub-groups
        // Transforms accumulate across iterations within the loop scope
        for (const bodyNode of node.body) {
          const object = this.convertNode(bodyNode);
          if (object) {
            group.add(object);
          }
        }
      }
    }

    // Pop scope - both symbols and transforms
    this.popTransform();
    this.symbols.popScope();

    return group;
  }

  private convertIf(node: IfNode): THREE.Group {
    const group = new THREE.Group();

    // Evaluate condition
    const condition = this.evaluator.evaluateToBoolean(node.condition);

    // Create new scope
    this.symbols.pushScope();
    this.pushTransform();

    if (condition) {
      // Execute then body
      for (const child of node.thenBody) {
        const object = this.convertNode(child);
        if (object) {
          group.add(object);
        }
      }
    } else if (node.elseBody) {
      // Execute else body
      for (const child of node.elseBody) {
        const object = this.convertNode(child);
        if (object) {
          group.add(object);
        }
      }
    }

    // Pop scope
    this.popTransform();
    this.symbols.popScope();

    return group;
  }

  private convertSwitch(node: SwitchNode): THREE.Group {
    const group = new THREE.Group();

    // Evaluate switch value
    const switchValue = this.evaluator.evaluate(node.value);

    // Create new scope
    this.symbols.pushScope();
    this.pushTransform();

    let matched = false;

    // Check each case
    for (const caseNode of node.cases) {
      for (const caseValue of caseNode.values) {
        const evalCaseValue = this.evaluator.evaluate(caseValue);

        // Simple equality check
        if (this.valuesEqual(switchValue, evalCaseValue)) {
          // Execute case body
          for (const child of caseNode.body) {
            const object = this.convertNode(child);
            if (object) {
              group.add(object);
            }
          }
          matched = true;
          break;
        }
      }

      if (matched) break;
    }

    // If no case matched, execute default case
    if (!matched && node.defaultCase) {
      for (const child of node.defaultCase) {
        const object = this.convertNode(child);
        if (object) {
          group.add(object);
        }
      }
    }

    // Pop scope
    this.popTransform();
    this.symbols.popScope();

    return group;
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
      console.warn(`Custom shape '${node.name}' not found`);
      return null;
    }

    const defineNode = definition as unknown as DefineNode;

    if (!defineNode.body) {
      console.warn(`Custom shape '${node.name}' has no body`);
      return null;
    }

    // Create new scope for custom shape instantiation
    this.symbols.pushScope();
    this.pushTransform();

    // Set default values from options
    if (defineNode.options) {
      for (const option of defineNode.options) {
        const defaultValue = this.evaluator.evaluate(option.defaultValue);
        this.symbols.set(option.name, defaultValue);
      }
    }

    // Override with provided properties
    for (const [key, value] of Object.entries(node.properties)) {
      const evaluatedValue = this.evaluator.evaluate(value as Expression);
      this.symbols.set(key, evaluatedValue);
    }

    // Convert the body
    const group = new THREE.Group();
    for (const child of defineNode.body) {
      const object = this.convertNode(child);
      if (object) {
        group.add(object);
      }
    }

    // Pop scope
    this.popTransform();
    this.symbols.popScope();

    return group;
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

    if (properties.rotation) {
      const rot = this.evaluateVector3(properties.rotation);
      object.rotation.set(...rot);
    }

    // orientation is an alias for rotation
    if (properties.orientation) {
      const rot = this.evaluateVector3(properties.orientation);
      object.rotation.set(...rot);
    }
  }

  private handleDetail(node: DetailNode): void {
    this.detailLevel = this.evaluateNumber(node.value);
    // Also add 'detail' as a variable so it can be referenced in expressions
    this.symbols.set("detail", this.detailLevel);
  }

  private handleColorCommand(node: ColorNode): void {
    const colorValue = this.evaluateVector3OrColor(node.value);
    this.currentTransform().color = new THREE.Color(colorValue[0], colorValue[1], colorValue[2]);
  }

  private handleRotateCommand(node: RotateNode): void {
    const rotation = this.evaluateVector3(node.value);
    const transform = this.currentTransform();
    const rotationMatrix = new THREE.Matrix4();

    const euler = new THREE.Euler(rotation[0] * Math.PI * 2, rotation[1] * Math.PI * 2, rotation[2] * Math.PI * 2, "XYZ");

    rotationMatrix.makeRotationFromEuler(euler);
    transform.matrix.multiply(rotationMatrix);
  }

  private handleOrientationCommand(node: OrientationNode): void {
    const orientation = this.evaluateVector3(node.value);
    const transform = this.currentTransform();

    // Orientation sets absolute rotation, not cumulative like rotate
    // Decompose current matrix to preserve position and scale
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    transform.matrix.decompose(position, new THREE.Quaternion(), scale);

    const euler = new THREE.Euler(orientation[0] * Math.PI * 2, orientation[1] * Math.PI * 2, orientation[2] * Math.PI * 2, "XYZ");

    // Rebuild matrix with new orientation but preserve position and scale
    transform.matrix.compose(position, new THREE.Quaternion().setFromEuler(euler), scale);
  }

  private handleTranslateCommand(node: TranslateNode): void {
    const transform = this.currentTransform();
    const [x, y, z] = this.evaluateTranslateVector(node.value);
    const translationMatrix = new THREE.Matrix4().makeTranslation(x, y, z);
    transform.matrix.multiply(translationMatrix);
  }

  private handleScaleCommand(node: ScaleNode): void {
    const scale = this.evaluateVector3(node.value);
    const transform = this.currentTransform();
    const scaleMatrix = new THREE.Matrix4().makeScale(scale[0], scale[1], scale[2]);
    transform.matrix.multiply(scaleMatrix);
  }

  private convertExtrude(node: ExtrudeNode): THREE.Mesh {
    // Build the 2D shape from the path
    const shape = node.path ? this.buildPath(node.path) : new THREE.Shape([new THREE.Vector2(0, 0)]);

    // Get extrusion depth from size property
    const size = node.properties.size ? this.evaluateVector3(node.properties.size) : [1, 1, 1];
    const depth = size[2] || 1;

    // Create extruded geometry
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
      curveSegments: Math.max(1, Math.floor(this.detailLevel / 4)),
    });

    // Create material
    const material = this.createMaterial(node);

    const mesh = new THREE.Mesh(geometry, material);

    this.applyExplicitTransforms(mesh, node.properties);
    this.applyCurrentTransform(mesh);

    return mesh;
  }

  private buildPath(pathNode: PathNode): THREE.Shape {
    const shape = new THREE.Shape();
    let currentX = 0;
    let currentY = 0;
    let currentAngle = 0; // In radians

    const processCommand = (command: PathCommand) => {
      switch (command.type) {
        case "point": {
          const x = this.evaluateNumber(command.x);
          const y = this.evaluateNumber(command.y);

          // Apply current rotation
          const cos = Math.cos(currentAngle);
          const sin = Math.sin(currentAngle);
          const rotatedX = x * cos - y * sin;
          const rotatedY = x * sin + y * cos;

          currentX += rotatedX;
          currentY += rotatedY;

          if (shape.curves.length === 0) {
            shape.moveTo(currentX, currentY);
          } else {
            shape.lineTo(currentX, currentY);
          }
          break;
        }

        case "curve": {
          const x = this.evaluateNumber(command.x);
          const y = this.evaluateNumber(command.y);

          // Apply current rotation
          const cos = Math.cos(currentAngle);
          const sin = Math.sin(currentAngle);
          const rotatedX = x * cos - y * sin;
          const rotatedY = x * sin + y * cos;

          currentX += rotatedX;
          currentY += rotatedY;

          if (command.controlX !== undefined && command.controlY !== undefined) {
            const cx = this.evaluateNumber(command.controlX);
            const cy = this.evaluateNumber(command.controlY);
            const rotatedCX = cx * cos - cy * sin;
            const rotatedCY = cx * sin + cy * cos;
            shape.quadraticCurveTo(currentX + rotatedCX, currentY + rotatedCY, currentX, currentY);
          } else {
            shape.lineTo(currentX, currentY);
          }
          break;
        }

        case "rotate": {
          // In ShapeScript, 1 = 360 degrees = 2π radians
          const angle = this.evaluateNumber(command.angle);
          currentAngle += angle * Math.PI * 2;
          break;
        }

        case "translate": {
          const x = this.evaluateNumber(command.x);
          const y = this.evaluateNumber(command.y);
          currentX += x;
          currentY += y;
          break;
        }

        case "for": {
          // Expand for loop
          this.symbols.pushScope();

          const from = this.evaluateNumber(command.from);
          const to = this.evaluateNumber(command.to);
          const step = command.step ? this.evaluateNumber(command.step) : 1;

          // Path commands never reach `convertNode`, so `maxNodes` cannot stop
          // this one — the shared bounded iterator is the only ceiling here.
          const iterations = this.rangeIterations(from, to, step);

          for (const i of iterations) {
            this.symbols.set(command.variable, i);
            for (const bodyCmd of command.commands) {
              processCommand(bodyCmd);
            }
          }

          this.symbols.popScope();
          break;
        }
      }
    };

    for (const command of pathNode.commands) {
      processCommand(command);
    }

    return shape;
  }

  private convertLathe(node: LatheNode): THREE.Object3D {
    // Lathe rotates a 2D profile around an axis to create a 3D shape
    // In ShapeScript, the path defines the profile

    // Create new scope
    this.symbols.pushScope();
    this.pushTransform();

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
      console.warn("Lathe requires a path child");
      this.popTransform();
      this.symbols.popScope();
      return new THREE.Group();
    }

    // Extract points directly from path commands
    const points: THREE.Vector2[] = [];
    let currentX = 0;
    let currentY = 0;
    let currentAngle = 0;

    const processCommand = (command: PathCommand) => {
      switch (command.type) {
        case "point":
        case "curve": {
          const x = this.evaluateNumber(command.x);
          const y = this.evaluateNumber(command.y);

          // Apply current rotation
          const cos = Math.cos(currentAngle);
          const sin = Math.sin(currentAngle);
          const rotatedX = x * cos - y * sin;
          const rotatedY = x * sin + y * cos;

          currentX += rotatedX;
          currentY += rotatedY;

          // For lathe, we approximate curves with line segments
          // Add the endpoint (control points affect the curve shape but for simple lathe we just use endpoints)
          points.push(new THREE.Vector2(currentX, currentY));
          break;
        }

        case "rotate": {
          const angle = this.evaluateNumber(command.angle);
          currentAngle += angle * Math.PI * 2;
          break;
        }

        case "translate": {
          const x = this.evaluateNumber(command.x);
          const y = this.evaluateNumber(command.y);
          currentX += x;
          currentY += y;
          break;
        }

        case "for": {
          // Expand for loop
          this.symbols.pushScope();

          const from = this.evaluateNumber(command.from);
          const to = this.evaluateNumber(command.to);
          const step = command.step ? this.evaluateNumber(command.step) : 1;

          // Path commands never reach `convertNode`, so `maxNodes` cannot stop
          // this one — the shared bounded iterator is the only ceiling here.
          const iterations = this.rangeIterations(from, to, step);

          for (const i of iterations) {
            this.symbols.set(command.variable, i);
            for (const bodyCmd of command.commands) {
              processCommand(bodyCmd);
            }
          }

          this.symbols.popScope();
          break;
        }
      }
    };

    // Process all path commands
    for (const command of pathNode.commands) {
      processCommand(command);
    }

    if (points.length < 2) {
      console.warn("Lathe path must have at least 2 points");
      this.popTransform();
      this.symbols.popScope();
      return new THREE.Group();
    }

    // Create lathe geometry
    const geometry = new THREE.LatheGeometry(
      points,
      this.detailLevel, // Number of segments around the axis
    );

    // Create material
    const material = this.createMaterial(node);
    const mesh = new THREE.Mesh(geometry, material);

    this.applyExplicitTransforms(mesh, node.properties);
    this.applyCurrentTransform(mesh);

    this.popTransform();
    this.symbols.popScope();

    return mesh;
  }

  private convertGroupBuilder(node: LoftNode | HullNode): THREE.Object3D {
    // Generic converter for builders that just group their children
    this.symbols.pushScope();
    this.pushTransform();

    const group = new THREE.Group();

    // Convert all children
    for (const child of node.children) {
      const object = this.convertNode(child);
      if (object) {
        group.add(object);
      }
    }

    this.applyExplicitTransforms(group, node.properties);
    this.applyCurrentTransform(group);

    this.popTransform();
    this.symbols.popScope();

    return group;
  }

  private convertLoft(node: LoftNode): THREE.Object3D {
    // Loft creates a 3D shape by interpolating between multiple 2D cross-sections
    // For now, implement as a simple group that renders all children
    // A proper implementation would use spline interpolation between shapes
    return this.convertGroupBuilder(node);
  }

  private convertFill(node: FillNode): THREE.Object3D {
    // Fill creates a solid 2D shape from a path
    // Similar to extrude but with zero depth

    this.symbols.pushScope();
    this.pushTransform();

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
      console.warn("Fill requires a path child");
      this.popTransform();
      this.symbols.popScope();
      return new THREE.Group();
    }

    // Build the 2D shape
    const shape = this.buildPath(pathNode);

    // Create a ShapeGeometry (flat 2D shape)
    const geometry = new THREE.ShapeGeometry(shape);

    // Create material
    const material = this.createMaterial(node);
    const mesh = new THREE.Mesh(geometry, material);

    this.applyExplicitTransforms(mesh, node.properties);
    this.applyCurrentTransform(mesh);

    this.popTransform();
    this.symbols.popScope();

    return mesh;
  }

  private convertHull(node: HullNode): THREE.Object3D {
    // Hull creates a convex hull around child shapes
    // Proper implementation requires computing convex hull from point cloud
    // For now, just render children as a group
    return this.convertGroupBuilder(node);
  }

  // Helper methods

  private evaluateNumber(value: number | Expression | undefined): number {
    if (value === undefined) return 0;
    if (typeof value === "number") return value;
    return this.evaluator.evaluateToNumber(value);
  }

  private evaluateVector3(value: Vector3 | Expression | undefined): Vector3 {
    if (value === undefined) return [0, 0, 0];
    if (Array.isArray(value) && typeof value[0] === "number") {
      return value as Vector3;
    }
    return this.evaluator.evaluateToVector3(value as Expression);
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
    return this.evaluator.evaluateToColor(value as Expression);
  }

  private evaluateVector3OrColor(value: Expression): Vector3 {
    // This helper is used for color commands which can accept a single number or a tuple
    const result = this.evaluator.evaluate(value);

    // Helper to convert Value to number
    const toNum = (v: Value | undefined): number => {
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "string") return parseFloat(v) || 0;
      if (Array.isArray(v) && v.length > 0) return toNum(v[0]);
      return 0;
    };

    if (typeof result === "number") {
      // Single value - use as grayscale
      return [result, result, result];
    } else if (Array.isArray(result)) {
      // Tuple - ensure it's a 3-element vector
      if (result.length === 1) {
        return [toNum(result[0]), toNum(result[0]), toNum(result[0])];
      } else if (result.length === 2) {
        return [toNum(result[0]), toNum(result[1]), 0];
      } else if (result.length >= 3) {
        return [toNum(result[0]), toNum(result[1]), toNum(result[2])];
      }
    }

    return [0.8, 0.8, 0.8]; // Default gray
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
