import { Expression, Vector3, Color, DefineNode, MaterialExpr, SceneNode } from "./types";
import {
  type MeshValue,
  type PolygonValue,
  type BoundsValue,
  type PointValue,
  type Point3,
  boundsOf,
  centerOf,
  meshPolygons,
  meshVolume,
  trianglesOf,
  triangulatePolygon,
} from "./meshValues";
import type * as THREE from "three";
import { insetGeometry } from "./minkowski";

export type { MeshValue, PolygonValue, BoundsValue, PointValue } from "./meshValues";

/** `1 to 5 step 2` as a value: walked by `for`, tested by `in`. */
export interface RangeValue {
  kind: "range";
  from: number;
  to: number;
  step: number;
  /** Whether a `step` was written: `in` then tests only the stepped values,
   *  while an unstepped range contains every number between its bounds. */
  stepped: boolean;
}

/** A `define name(a b) { … }` function, kept as its definition node. */
export interface FunctionValue {
  kind: "function";
  definition: DefineNode;
}

/** An evaluated `material { … }` block. Colours carry alpha; a texture is
 *  kept only so the renderer can warn about it. */
export interface MaterialValue {
  kind: "material";
  color?: RGBA;
  opacity?: number;
  metallicity?: number;
  roughness?: number;
  glow?: RGBA;
  texture?: string;
}

export type RGBA = [number, number, number, number];

export type ObjectValue = RangeValue | FunctionValue | MaterialValue | MeshValue | PolygonValue | BoundsValue | PointValue;

export type Value = number | boolean | string | Value[] | ObjectValue;

export const isObjectValue = (value: Value | undefined): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);

/** What the evaluator needs from the converter: shapes as values are built
 *  there, and a function whose body builds shapes runs there. */
export interface EvaluatorHooks {
  shape(node: SceneNode): Value;
  call(fn: FunctionValue, args: Value[]): Value;
  /** A geometry a builtin allocated that stays alive as a value: charged
   *  against the vertex budget by the converter, or refused. */
  retain(geometry: THREE.BufferGeometry): void;
}

/** Upstream's predefined colour constants (materials.md), as RGB tuples. A
 *  script may `define red …` over them. */
const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  blue: [0, 0, 1],
  green: [0, 1, 0],
  cyan: [0, 1, 1],
  red: [1, 0, 0],
  magenta: [1, 0, 1],
  purple: [0.5, 0, 0.5],
  yellow: [1, 1, 0],
  white: [1, 1, 1],
  orange: [1, 0.5, 0],
  gray: [0.5, 0.5, 0.5],
  grey: [0.5, 0.5, 0.5],
};

/** Upstream's `rnd` generator, bit for bit: a 32-bit LCG kept in a double,
 *  `x = (x * 1664525 + 1013904223) mod 2^32`, returning `x / 2^32`. Matching
 *  it means `seed 57` scatters shapes exactly as it does in the upstream app.
 *  A class, not a closure, because scopes SHARE it: a nested block advances
 *  its parent's sequence, but `seed` inside the block replaces only the
 *  block's own reference (see `SymbolTable.reseed`). */
export class RandomSequence {
  private static readonly MODULUS = 4294967296;
  private state: number;

  constructor(seed: number) {
    this.state = RandomSequence.wrap(seed);
  }

  private static wrap(value: number): number {
    const wrapped = value % RandomSequence.MODULUS;
    return Number.isFinite(wrapped) ? (wrapped < 0 ? wrapped + RandomSequence.MODULUS : wrapped) : 0;
  }

  next(): number {
    this.state = RandomSequence.wrap(this.state * 1664525 + 1013904223);
    return this.state / RandomSequence.MODULUS;
  }
}

interface Scope {
  values: Map<string, Value>;
  random: RandomSequence;
}

export class SymbolTable {
  private scopes: Scope[] = [];

  constructor(seed: number = DEFAULT_RANDOM_SEED) {
    this.scopes.push({ values: new Map(), random: new RandomSequence(seed) });
    for (const [name, value] of Object.entries({ pi: Math.PI, tau: 2 * Math.PI, true: true, false: false })) this.set(name, value);
    for (const [name, value] of Object.entries(NAMED_COLORS)) this.set(name, value);
  }

  private innermost(): Scope {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope === undefined) throw new Error("SymbolTable has no active scope");
    return scope;
  }

  pushScope(): void {
    // The child shares its parent's sequence, as upstream's child context does.
    this.scopes.push({ values: new Map(), random: this.innermost().random });
  }

  popScope(): void {
    if (this.scopes.length > 1) {
      this.scopes.pop();
    }
  }

  /** `seed N`: a fresh sequence for THIS scope only. The parent keeps the
   *  sequence it had, so `rnd` after the closing brace carries on from there. */
  reseed(seed: number): void {
    this.innermost().random = new RandomSequence(seed);
  }

  nextRandom(): number {
    return this.innermost().random.next();
  }

  set(name: string, value: Value): void {
    this.innermost().values.set(name, value);
  }

  get(name: string): Value | undefined {
    // Search from innermost to outermost scope
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      if (scope?.values.has(name)) {
        return scope.values.get(name);
      }
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }
}

// Shared by the `length` and `normalize` built-ins — a standalone function
// rather than `builtInFunctions.length(...)`, which under
// `noUncheckedIndexedAccess` is only `((...args: Value[]) => Value) | undefined`.
function vectorLength(v: Value): number {
  let sum = 0;
  for (const component of toArray(v)) {
    const n = toNumber(component);
    sum += n * n;
  }
  return Math.sqrt(sum);
}

// Built-in functions
const memberIndices: Record<string, number> = {
  x: 0,
  y: 1,
  z: 2,
  w: 3,
  r: 0,
  g: 1,
  b: 2,
  a: 3,
  red: 0,
  green: 1,
  blue: 2,
  alpha: 3,
  width: 0,
  height: 1,
  depth: 2,
  roll: 0,
  yaw: 1,
  pitch: 2,
};
/** `color.hue` / `.saturation` / `.brightness` — HSB of an RGB tuple. */
const hsbMembers: Record<string, number> = { hue: 0, saturation: 1, brightness: 2 };

function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue / 6, max === 0 ? 0 : delta / max, max];
}

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  const hue = ((h % 1) + 1) % 1;
  const sector = hue * 6;
  const chroma = b * s;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const m = b - chroma;
  const [r, g, bl] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return [r + m, g + m, bl + m];
}
/** Upstream's ordinal members, `vector.first` … `vector.tenth`. `last`,
 *  `allButFirst` and `allButLast` depend on the length and are handled inline. */
const ordinalIndices: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9 };

/** Members of the geometry-carrying values. */
function objectMember(value: ObjectValue, member: string): Value | undefined {
  switch (value.kind) {
    case "mesh":
      switch (member) {
        case "polygons":
          return meshPolygons(value);
        case "triangles":
          return trianglesOf(value.geometry);
        case "bounds":
          return boundsOf(meshPolygons(value).flatMap((polygon) => polygon.points));
        case "volume":
          return meshVolume(value);
        case "name":
          return value.name ?? "";
        default:
          return undefined;
      }
    case "polygon":
      switch (member) {
        case "points":
          return value.points.map((position, i): PointValue => ({ kind: "point", position, ...(value.colors?.[i] ? { color: value.colors[i] } : {}) }));
        case "center":
          return centerOf(value.points);
        case "bounds":
          return boundsOf(value.points);
        case "triangles":
          return triangulatePolygon(value.points).map((triangle): PolygonValue => ({
            kind: "polygon",
            points: triangle.map((i) => value.points[i]!),
            ...(value.colors ? { colors: triangle.map((i) => value.colors![i] ?? value.colors![0]!) } : {}),
          }));
        default:
          return undefined;
      }
    case "bounds": {
      const size: Point3 = [value.max[0] - value.min[0], value.max[1] - value.min[1], value.max[2] - value.min[2]];
      switch (member) {
        case "min":
          return value.min;
        case "max":
          return value.max;
        case "center":
          return [(value.min[0] + value.max[0]) / 2, (value.min[1] + value.max[1]) / 2, (value.min[2] + value.max[2]) / 2];
        case "size":
          return size;
        case "width":
          return size[0];
        case "height":
          return size[1];
        case "depth":
          return size[2];
        default:
          return undefined;
      }
    }
    case "point":
      return member === "position" ? value.position : member === "color" ? (value.color ?? [1, 1, 1, 1]) : undefined;
    default:
      return undefined;
  }
}

function sequenceMember(value: Value[] | string, member: string): Value | undefined {
  if (member === "count") return value.length;
  if (member === "last") return value.length > 0 ? value[value.length - 1] : undefined;
  if (member === "allButFirst") return typeof value === "string" ? value.slice(1) : value.slice(1);
  if (member === "allButLast") return typeof value === "string" ? value.slice(0, -1) : value.slice(0, -1);
  if (Array.isArray(value) && member in hsbMembers && value.length >= 3) {
    return rgbToHsb(toNumber(value[0]), toNumber(value[1]), toNumber(value[2]))[hsbMembers[member]!];
  }
  const index = ordinalIndices[member] ?? (Array.isArray(value) ? memberIndices[member] : undefined);
  if (index === undefined) return undefined;
  // `pos.z` of a 2D position is 0 and `col.alpha` of an RGB colour is 1, as
  // upstream pads them; other missing components are errors.
  if (index < value.length) return value[index];
  if (Array.isArray(value) && index < 4 && (member === "alpha" || member === "a")) return 1;
  if (Array.isArray(value) && index < 3 && member in memberIndices) return 0;
  return undefined;
}
const builtInFunctions: Record<string, (...args: Value[]) => Value> = {
  // Arithmetic
  round: (x: Value) => Math.round(toNumber(x)),
  floor: (x: Value) => Math.floor(toNumber(x)),
  ceil: (x: Value) => Math.ceil(toNumber(x)),
  abs: (x: Value) => Math.abs(toNumber(x)),
  sign: (x: Value) => Math.sign(toNumber(x)),
  sqrt: (x: Value) => Math.sqrt(toNumber(x)),
  pow: (x: Value, y: Value) => Math.pow(toNumber(x), toNumber(y)),
  min: (...args: Value[]) => Math.min(...args.flat().map(toNumber)),
  max: (...args: Value[]) => Math.max(...args.flat().map(toNumber)),

  // Trigonometric (uses radians)
  sin: (x: Value) => Math.sin(toNumber(x)),
  cos: (x: Value) => Math.cos(toNumber(x)),
  tan: (x: Value) => Math.tan(toNumber(x)),
  asin: (x: Value) => Math.asin(toNumber(x)),
  acos: (x: Value) => Math.acos(toNumber(x)),
  atan: (x: Value) => Math.atan(toNumber(x)),
  atan2: (y: Value, x: Value) => Math.atan2(toNumber(y), toNumber(x)),

  // Vector operations
  dot: (a: Value, b: Value) => {
    const vecA = toArray(a);
    const vecB = toArray(b);
    let sum = 0;
    for (let i = 0; i < Math.min(vecA.length, vecB.length); i++) {
      sum += toNumber(vecA[i]) * toNumber(vecB[i]);
    }
    return sum;
  },

  cross: (a: Value, b: Value) => {
    const vecA = toArray(a);
    const vecB = toArray(b);
    if (vecA.length < 3 || vecB.length < 3) {
      throw new Error("cross product requires 3D vectors");
    }
    const x = toNumber(vecA[0]);
    const y = toNumber(vecA[1]);
    const z = toNumber(vecA[2]);
    const x2 = toNumber(vecB[0]);
    const y2 = toNumber(vecB[1]);
    const z2 = toNumber(vecB[2]);
    return [y * z2 - z * y2, z * x2 - x * z2, x * y2 - y * x2];
  },

  length: (v: Value) => vectorLength(v),

  normalize: (v: Value) => {
    const vec = toArray(v);
    const len = vectorLength(v);
    if (len === 0) return vec;
    return vec.map((component) => toNumber(component) / len);
  },

  sum: (v: Value) => {
    const vec = toArray(v);
    return vec.reduce((acc: number, val) => acc + toNumber(val), 0);
  },

  // String functions
  join: (...args: Value[]) => {
    const separator = args.length > 0 && typeof args[args.length - 1] === "string" ? (args.pop() as string) : "";
    return args.flat().map(String).join(separator);
  },

  trim: (s: Value) => String(s).trim(),
  split: (s: Value, separator: Value) => String(s).split(String(separator ?? "")),

  // Colours: `rgb(r g b [a])` passes through, `hsb(h s b [a])` converts.
  rgb: (...args: Value[]) => args.flat(),
  hsb: (...args: Value[]) => {
    const [h = 0, s = 0, b = 0, a] = args.flat().map(toNumber);
    return a === undefined ? hsbToRgb(h, s, b) : [...hsbToRgb(h, s, b), a];
  },

  // `rand` is intercepted by the evaluator, which owns the seeded generator;
  // the entry stays so `Unknown function` still lists it as known.
  rand: () => 0,
};

/** Every built-in a bare call may name (`max 0 1`). */
// `rand` and `inset` are served by the evaluator itself (see `evaluate`).
export const BUILT_IN_FUNCTION_NAMES: readonly string[] = [...Object.keys(builtInFunctions), "inset"];

// Accepts `undefined` so callers can index into a `Value[]` under
// `noUncheckedIndexedAccess` without a guard at every call site; an
// out-of-range element throws here exactly as it did before.
function toNumber(value: Value | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const num = parseFloat(value);
    if (isNaN(num)) throw new Error(`Cannot convert "${value}" to number`);
    return num;
  }
  if (Array.isArray(value) && value.length > 0) {
    return toNumber(value[0]);
  }
  if (isObjectValue(value)) throw new Error(`Cannot use a ${value.kind} as a number`);
  throw new Error(`Cannot convert ${typeof value} to number`);
}

function toArray(value: Value): Value[] {
  if (Array.isArray(value)) return value;
  return [value];
}

function toBoolean(value: Value): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/** Whether `needle` is in `haystack`: a range (on its steps), a tuple (by
 *  value), or a string (as a substring), as upstream's `in` operator. */
function contains(needle: Value, haystack: Value): boolean {
  if (isObjectValue(haystack) && haystack.kind === "range") {
    const n = toNumber(needle);
    const { from, to, step } = haystack;
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    if (n < low || n > high) return false;
    if (!haystack.stepped) return true;
    const offset = (n - from) / step;
    return Math.abs(offset - Math.round(offset)) < 1e-9;
  }
  if (Array.isArray(haystack)) return haystack.some((item) => valuesEqual(item, needle));
  if (typeof haystack === "string") return haystack.includes(String(needle));
  throw new Error("`in` needs a range, tuple or string on its right");
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => valuesEqual(item, b[i]!));
  return a === b;
}

/** The values a `for` loop visits: a range walked by its step, a tuple's
 *  elements, or a lone value. The count is bounded by the caller. */
export function iterationValues(iterable: Value, limit: number, exceeded: () => Error): Value[] {
  if (isObjectValue(iterable)) {
    if (iterable.kind !== "range") throw new Error(`Cannot loop over a ${iterable.kind}`);
    const { from, to, step } = iterable;
    const values: number[] = [];
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      if (values.length >= limit) throw exceeded();
      values.push(i);
    }
    return values;
  }
  const values = Array.isArray(iterable) ? iterable : [iterable];
  if (values.length > limit) throw exceeded();
  return values;
}

/** Seeds the generator behind `rnd` / `rand()` when a caller names none.
 *
 *  The same script is evaluated TWICE for one visualization — once on the
 *  server, which validates it and reports the diagnostic, and again in the
 *  browser, which renders it. With `Math.random()` behind `rnd` those two runs
 *  can take different branches, so `if rnd < .5 { cube } else { … }` could
 *  validate clean and then fail in the viewport, which is exactly the failure
 *  the validation exists to prevent. A seeded generator makes both runs agree,
 *  and re-rendering a model on every keystroke stops reshuffling it.
 *
 *  Zero, like upstream, so a script's `rnd` values here are the ones the
 *  upstream app shows for it. */
export const DEFAULT_RANDOM_SEED = 0;

/** A function calling itself with no way out would otherwise overflow the
 *  JavaScript stack, which surfaces as a RangeError with no script context. */
const MAX_CALL_DEPTH = 256;

/** Default ceiling for a `for` expression; the converter sets its own option. */
const DEFAULT_MAX_FOR_EXPRESSION_ITERATIONS = 100_000;

export class Evaluator {
  private symbols: SymbolTable;
  private callDepth = 0;
  /** Set by the converter, which owns geometry. */
  hooks: EvaluatorHooks | undefined;
  /** The same per-loop ceiling the converter applies to `for` statements. */
  maxLoopIterations = DEFAULT_MAX_FOR_EXPRESSION_ITERATIONS;

  constructor(symbols?: SymbolTable, seed?: number) {
    this.symbols = symbols || new SymbolTable(seed);
    if (seed !== undefined) this.symbols.reseed(seed);
  }

  private random(): number {
    return this.symbols.nextRandom();
  }

  /** The `seed` command. Scoped: see `SymbolTable.reseed`. */
  reseed(seed: number): void {
    if (!Number.isFinite(seed)) throw new Error("`seed` needs a finite number");
    this.symbols.reseed(seed);
  }

  getSymbols(): SymbolTable {
    return this.symbols;
  }

  evaluate(expr: Expression | number | string | Vector3 | Color): Value {
    // Handle literal values
    if (typeof expr === "number") {
      return expr;
    }
    if (typeof expr === "string") {
      return expr;
    }
    if (Array.isArray(expr)) {
      return expr;
    }

    // Handle expression nodes
    switch (expr.type) {
      case "string":
      case "number":
        return expr.value;

      case "identifier": {
        // Handle built-in random number generator
        if (expr.name === "rnd") {
          return this.random();
        }

        const value = this.symbols.get(expr.name);
        if (value === undefined) {
          throw new Error(`Undefined variable: ${expr.name}`);
        }
        return value;
      }

      case "binary": {
        const left = this.evaluate(expr.left);
        if (expr.operator === "and" && !toBoolean(left)) return false;
        if (expr.operator === "or" && toBoolean(left)) return true;
        const right = this.evaluate(expr.right);

        switch (expr.operator) {
          case "+":
            if (Array.isArray(left) && Array.isArray(right)) {
              // Vector addition (preserve left length)
              const result: Value[] = [...left];
              for (let i = 0; i < result.length && i < right.length; i++) {
                result[i] = toNumber(result[i]) + toNumber(right[i]);
              }
              return result;
            }
            return toNumber(left) + toNumber(right);

          case "-":
            if (Array.isArray(left) && Array.isArray(right)) {
              // Vector subtraction (preserve left length)
              const result: Value[] = [...left];
              for (let i = 0; i < result.length && i < right.length; i++) {
                result[i] = toNumber(result[i]) - toNumber(right[i]);
              }
              return result;
            }
            return toNumber(left) - toNumber(right);

          case "*":
            if (Array.isArray(left) && Array.isArray(right)) {
              // Element-wise multiplication (truncate to shorter)
              const len = Math.min(left.length, right.length);
              const result: Value[] = [];
              for (let i = 0; i < len; i++) {
                result.push(toNumber(left[i]) * toNumber(right[i]));
              }
              return result;
            }
            if (Array.isArray(left)) {
              // Scalar multiplication
              return left.map((v) => toNumber(v) * toNumber(right));
            }
            if (Array.isArray(right)) {
              // Scalar multiplication
              return right.map((v) => toNumber(left) * toNumber(v));
            }
            return toNumber(left) * toNumber(right);

          case "/":
            if (Array.isArray(left) && Array.isArray(right)) {
              // Element-wise division (truncate to shorter)
              const len = Math.min(left.length, right.length);
              const result: Value[] = [];
              for (let i = 0; i < len; i++) {
                result.push(toNumber(left[i]) / toNumber(right[i]));
              }
              return result;
            }
            if (Array.isArray(left)) {
              // Scalar division
              return left.map((v) => toNumber(v) / toNumber(right));
            }
            return toNumber(left) / toNumber(right);

          case "%":
            return toNumber(left) % toNumber(right);

          case "=":
            if (Array.isArray(left) && Array.isArray(right)) {
              if (left.length !== right.length) return false;
              for (let i = 0; i < left.length; i++) {
                if (toNumber(left[i]) !== toNumber(right[i])) return false;
              }
              return true;
            }
            return left === right;

          case "<>":
            if (Array.isArray(left) && Array.isArray(right)) {
              if (left.length !== right.length) return true;
              for (let i = 0; i < left.length; i++) {
                if (toNumber(left[i]) !== toNumber(right[i])) return true;
              }
              return false;
            }
            return left !== right;

          case "<":
            return toNumber(left) < toNumber(right);

          case "<=":
            return toNumber(left) <= toNumber(right);

          case ">":
            return toNumber(left) > toNumber(right);

          case ">=":
            return toNumber(left) >= toNumber(right);

          case "and":
            return toBoolean(left) && toBoolean(right);

          case "or":
            return toBoolean(left) || toBoolean(right);

          case "in":
            return contains(left, right);

          default:
            throw new Error(`Unknown binary operator: ${expr.operator}`);
        }
      }

      case "unary": {
        const operand = this.evaluate(expr.operand);

        switch (expr.operator) {
          case "+":
            return Array.isArray(operand) ? operand.map(toNumber) : toNumber(operand);
          case "-":
            if (Array.isArray(operand)) {
              return operand.map((v) => -toNumber(v));
            }
            return -toNumber(operand);

          case "not":
            return !toBoolean(operand);

          default:
            throw new Error(`Unknown unary operator: ${expr.operator}`);
        }
      }

      case "call": {
        // Own-property check: a plain object literal inherits `constructor`,
        // `toString` and friends from `Object.prototype`, so `constructor()`
        // used to resolve to a function and return an object that later
        // coerced to `false` — a silently skipped `if` branch instead of
        // "Unknown function".
        const custom = this.symbols.get(expr.name);
        if (isObjectValue(custom) && custom.kind === "function") return this.callFunction(custom, expr.args);
        const name = expr.name.toLowerCase();
        // `rand()` shares the seeded generator behind `rnd`, so it cannot be
        // served from the shared function table.
        if (name === "rand") return this.random();
        if (name === "inset") return this.inset(expr.args.map((arg) => this.evaluate(arg)));
        const func = Object.prototype.hasOwnProperty.call(builtInFunctions, name) ? builtInFunctions[name] : undefined;
        if (!func) {
          throw new Error(`Unknown function: ${expr.name}`);
        }

        const args = expr.args.map((arg) => this.evaluate(arg));
        return func(...args);
      }

      case "tuple": {
        return expr.elements.map((el) => this.evaluate(el));
      }

      case "range":
        return this.evaluateRange(expr.from, expr.to, expr.step);

      case "material":
        return this.evaluateMaterial(expr);

      case "shape":
        if (!this.hooks) throw new Error("A shape cannot be used as a value here");
        return this.hooks.shape(expr.node);

      case "for": {
        const values = iterationValues(
          this.evaluate(expr.iterable),
          this.maxLoopIterations,
          () => new Error(`\`for\` expression exceeds ${this.maxLoopIterations} iterations`),
        );
        this.symbols.pushScope();
        try {
          return values.map((value) => {
            this.symbols.set(expr.variable, value);
            return this.evaluate(expr.body);
          });
        } finally {
          this.symbols.popScope();
        }
      }

      case "if": {
        if (this.evaluateToBoolean(expr.condition)) return this.evaluate(expr.then);
        if (expr.else === undefined) throw new Error("`if` used as a value needs an `else`");
        return this.evaluate(expr.else);
      }

      case "member": {
        const value = this.evaluate(expr.object);
        const result =
          Array.isArray(value) || typeof value === "string"
            ? sequenceMember(value, expr.member)
            : isObjectValue(value)
              ? objectMember(value, expr.member)
              : undefined;
        if (result === undefined) throw new Error(`Unknown member: ${expr.member}`);
        return result;
      }
      case "subscript": {
        const value = this.evaluate(expr.object);
        const index = this.evaluate(expr.index);
        if (!Array.isArray(value) && typeof value !== "string") throw new Error("Subscripting requires a tuple or string");
        // `v["y"]` is `v.y`; `v[-1]` counts from the end, as upstream.
        if (typeof index === "string") {
          const member = sequenceMember(value, index);
          if (member === undefined) throw new Error(`Unknown member: ${index}`);
          return member;
        }
        if (typeof index !== "number" || !Number.isInteger(index) || index < -value.length || index >= value.length)
          throw new Error(`Subscript out of range: ${String(index)}`);
        return value[index < 0 ? value.length + index : index]!;
      }

      default:
        throw new Error(`Unknown expression type: ${(expr as { type: string }).type}`);
    }
  }

  /** `from to to [step]`, or `range step s` when `to` is absent. */
  private evaluateRange(fromExpr: Expression, toExpr: Expression | undefined, stepExpr: Expression | undefined): RangeValue {
    const from = this.evaluate(fromExpr);
    const step = stepExpr === undefined ? undefined : toNumber(this.evaluate(stepExpr));
    if (toExpr === undefined) {
      if (!isObjectValue(from) || from.kind !== "range") throw new Error("`step` needs a range before it");
      return { ...from, step: step ?? from.step, stepped: step !== undefined || from.stepped };
    }
    const range: RangeValue = { kind: "range", from: toNumber(from), to: toNumber(this.evaluate(toExpr)), step: step ?? 1, stepped: step !== undefined };
    if (range.step === 0 || ![range.from, range.to, range.step].every(Number.isFinite))
      throw new Error("Loop bounds and step must be finite, with a nonzero step");
    return range;
  }

  private evaluateMaterial(expr: MaterialExpr): MaterialValue {
    const material: MaterialValue = { kind: "material" };
    const { color, opacity, metallicity, roughness, glow, texture } = expr.properties;
    if (color) material.color = this.evaluateToRGBA(color);
    if (glow) material.glow = this.evaluateToRGBA(glow);
    if (opacity !== undefined) material.opacity = this.evaluateToNumber(opacity);
    if (metallicity !== undefined) material.metallicity = this.evaluateToNumber(metallicity);
    if (roughness !== undefined) material.roughness = this.evaluateToNumber(roughness);
    if (texture) material.texture = String(this.evaluate(texture));
    return material;
  }

  /** `inset(mesh distance)`: a new mesh value with the faces moved inward.
   *  Its geometry is a fresh allocation that lives on as a value, so it is
   *  charged the way a defined shape is. */
  private inset(args: Value[]): Value {
    const [mesh, distance] = args;
    if (args.length !== 2 || !isObjectValue(mesh) || mesh.kind !== "mesh") throw new Error("`inset` takes a mesh and a distance");
    const by = toNumber(distance);
    if (!Number.isFinite(by)) throw new Error("`inset` distance must be a finite number");
    if (!this.hooks) throw new Error("`inset` builds a mesh, which cannot be evaluated here");
    const geometry = insetGeometry(mesh.geometry, by);
    try {
      this.hooks.retain(geometry);
    } catch (error) {
      geometry.dispose();
      throw error;
    }
    // The faces move, so the polygons kept from a `mesh { }` block no longer apply.
    return { kind: "mesh", geometry, ...(mesh.name === undefined ? {} : { name: mesh.name }) };
  }

  /** Bind the parameters in a fresh scope, run the body's `define`s, and
   *  evaluate the result expression. */
  private callFunction(fn: FunctionValue, argExprs: Expression[]): Value {
    const { params = [], body = [], value, name } = fn.definition;
    const args = argExprs.map((arg) => this.evaluate(arg));
    if (args.length !== params.length) throw new Error(`Function \`${name}\` takes ${params.length} argument(s), got ${args.length}`);
    if (++this.callDepth > MAX_CALL_DEPTH) throw new Error(`Function \`${name}\` recursed more than ${MAX_CALL_DEPTH} levels deep`);
    try {
      // A body that builds shapes runs in the converter, which collects what
      // it produced; a body of plain defines and a result is evaluated here.
      if (body.some((node) => node.type !== "define")) {
        if (!this.hooks) throw new Error(`Function \`${name}\` builds shapes, which cannot be evaluated here`);
        return this.hooks.call(fn, args);
      }
      if (value === undefined) throw new Error(`Function \`${name}\` returns nothing`);
      return this.withArguments(params, args, () => {
        for (const define of body) if (define.type === "define") this.define(define);
        return this.evaluate(value);
      });
    } finally {
      this.callDepth--;
    }
  }

  /** Bind parameters in a fresh scope around `run`. Public so the converter
   *  can run a shape-building function body under the same binding. */
  withArguments<T>(params: readonly string[], args: readonly Value[], run: () => T): T {
    this.symbols.pushScope();
    try {
      params.forEach((param, i) => this.symbols.set(param, args[i]!));
      return run();
    } finally {
      this.symbols.popScope();
    }
  }

  /** A `define` of a value or a function. Custom shape blocks are stored by
   *  the converter, which owns their bodies. */
  define(node: DefineNode): boolean {
    if (node.params !== undefined) {
      this.symbols.set(node.name, { kind: "function", definition: node });
      return true;
    }
    if (node.value !== undefined) {
      this.symbols.set(node.name, this.evaluate(node.value));
      return true;
    }
    return false;
  }

  evaluateToNumber(expr: Expression | number): number {
    const value = this.evaluate(expr);
    return toNumber(value);
  }

  evaluateToBoolean(expr: Expression): boolean {
    const value = this.evaluate(expr);
    return toBoolean(value);
  }

  evaluateToVector3(expr: Expression | Vector3): Vector3 {
    if (Array.isArray(expr) && typeof expr[0] === "number") {
      return expr as Vector3;
    }

    const value = this.evaluate(expr);

    if (Array.isArray(value)) {
      const x = value.length > 0 ? toNumber(value[0]) : 0;
      const y = value.length > 1 ? toNumber(value[1]) : 0;
      const z = value.length > 2 ? toNumber(value[2]) : 0;
      return [x, y, z];
    }

    // Single number becomes uniform vector
    const n = toNumber(value);
    return [n, n, n];
  }

  evaluateToColor(expr: Expression | Color): Color {
    const [r, g, b] = this.evaluateToRGBA(expr);
    return [r, g, b];
  }

  /** A colour value with alpha, by upstream's count rules: one number is a
   *  luminance, two are luminance and alpha, three RGB, four RGBA; and a colour
   *  followed by a number (`red 0.5`, `#ff0 0.5`) is that colour with its
   *  alpha replaced. */
  evaluateToRGBA(expr: Expression | Color): RGBA {
    const value = Array.isArray(expr) && typeof expr[0] === "number" ? (expr as number[]) : this.evaluate(expr);
    return rgbaOf(value);
  }
}

export function rgbaOf(value: Value): RGBA {
  if (typeof value === "number" || typeof value === "boolean") {
    const n = toNumber(value);
    return [n, n, n, 1];
  }
  if (!Array.isArray(value)) throw new Error("Expected numeric color channels");
  if (value.length === 2 && Array.isArray(value[0])) return [...rgbaOf(value[0]).slice(0, 3), toNumber(value[1])] as RGBA;
  if (value.length === 1 && Array.isArray(value[0])) return rgbaOf(value[0]);
  const channels = value.map((channel) => {
    if (typeof channel !== "number" && typeof channel !== "boolean") throw new Error("Expected numeric color channels");
    return toNumber(channel);
  });
  const [a = 0.8, b = 1, c = 0, d = 1] = channels;
  switch (channels.length) {
    case 0:
      return [0.8, 0.8, 0.8, 1];
    case 1:
      return [a, a, a, 1];
    case 2:
      return [a, a, a, b];
    case 3:
      return [a, b, c, 1];
    default:
      return [a, b, c, d];
  }
}
