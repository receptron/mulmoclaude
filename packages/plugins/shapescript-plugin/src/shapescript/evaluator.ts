import { Expression, Vector3, Color } from "./types";

export type Value = number | boolean | string | Value[];

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
const memberIndices: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, red: 0, green: 1, blue: 2, alpha: 3 };
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

  // `rand` is intercepted by the evaluator, which owns the seeded generator;
  // the entry stays so `Unknown function` still lists it as known.
  rand: () => 0,
};

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

export class Evaluator {
  private symbols: SymbolTable;

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
        const name = expr.name.toLowerCase();
        // `rand()` shares the seeded generator behind `rnd`, so it cannot be
        // served from the shared function table.
        if (name === "rand") return this.random();
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

      case "member": {
        const value = this.evaluate(expr.object);
        if (expr.member === "count" && (Array.isArray(value) || typeof value === "string")) return value.length;
        const index = memberIndices[expr.member];
        if (Object.hasOwn(memberIndices, expr.member) && index !== undefined && Array.isArray(value) && index < value.length) return value[index]!;
        throw new Error(`Unknown member: ${expr.member}`);
      }
      case "subscript": {
        const value = this.evaluate(expr.object);
        const index = this.evaluate(expr.index);
        if (!Array.isArray(value) && typeof value !== "string") throw new Error("Subscripting requires a tuple or string");
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= value.length)
          throw new Error(`Subscript out of range: ${String(index)}`);
        return value[index]!;
      }

      default:
        throw new Error(`Unknown expression type: ${(expr as { type: string }).type}`);
    }
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
    if (Array.isArray(expr) && typeof expr[0] === "number") {
      return expr as Color;
    }

    const value = this.evaluate(expr);

    if (Array.isArray(value)) {
      const r = value.length > 0 ? toNumber(value[0]) : 0;
      const g = value.length > 1 ? toNumber(value[1]) : 0;
      const b = value.length > 2 ? toNumber(value[2]) : 0;
      return [r, g, b];
    }

    // Single number becomes grayscale
    const n = toNumber(value);
    return [n, n, n];
  }
}
