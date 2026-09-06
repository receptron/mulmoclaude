import { Expression, Vector3, Color } from "./types";

export type Value = number | boolean | string | Value[];

export class SymbolTable {
  private scopes: Map<string, Value>[] = [];

  constructor() {
    this.pushScope();
  }

  pushScope(): void {
    this.scopes.push(new Map());
  }

  popScope(): void {
    if (this.scopes.length > 1) {
      this.scopes.pop();
    }
  }

  set(name: string, value: Value): void {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope === undefined) throw new Error("SymbolTable has no active scope");
    scope.set(name, value);
  }

  get(name: string): Value | undefined {
    // Search from innermost to outermost scope
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      if (scope?.has(name)) {
        return scope.get(name);
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
const builtInFunctions: Record<string, (...args: Value[]) => Value> = {
  // Arithmetic
  round: (x: Value) => Math.round(toNumber(x)),
  floor: (x: Value) => Math.floor(toNumber(x)),
  ceil: (x: Value) => Math.ceil(toNumber(x)),
  abs: (x: Value) => Math.abs(toNumber(x)),
  sign: (x: Value) => Math.sign(toNumber(x)),
  sqrt: (x: Value) => Math.sqrt(toNumber(x)),
  pow: (x: Value, y: Value) => Math.pow(toNumber(x), toNumber(y)),
  min: (...args: Value[]) => Math.min(...args.map(toNumber)),
  max: (...args: Value[]) => Math.max(...args.map(toNumber)),

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
    return args.map(String).join(separator);
  },

  trim: (s: Value) => String(s).trim(),

  // Random (for procedural generation)
  rand: () => Math.random(),
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

export class Evaluator {
  private symbols: SymbolTable;

  constructor(symbols?: SymbolTable) {
    this.symbols = symbols || new SymbolTable();
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
      case "number":
        return expr.value;

      case "identifier": {
        // Handle built-in random number generator
        if (expr.name === "rnd") {
          return Math.random();
        }

        const value = this.symbols.get(expr.name);
        if (value === undefined) {
          throw new Error(`Undefined variable: ${expr.name}`);
        }
        return value;
      }

      case "binary": {
        const left = this.evaluate(expr.left);
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

      case "member":
      case "subscript":
        throw new Error(`Member access and subscripting not yet implemented: ${expr.type}`);

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
