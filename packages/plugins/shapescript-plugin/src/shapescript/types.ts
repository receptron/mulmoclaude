// ShapeScript AST Type Definitions

export type Vector3 = [number, number, number];
export type Color = [number, number, number];

// Expression types
export type Expression =
  | NumberLiteral
  | StringLiteral
  | IdentifierExpr
  | BinaryExpr
  | UnaryExpr
  | FunctionCall
  | MemberAccess
  | SubscriptExpr
  | TupleExpr
  | RangeExpr
  | MaterialExpr
  | ShapeExpr
  | ForExpr
  | IfExpr;

/** A shape used as a value: `define ico icosphere { detail 0 }`. Built by the
 *  converter into a mesh value the script can read members of and place. */
export interface ShapeExpr {
  type: "shape";
  node: SceneNode;
}

/** `for v in iterable { expr }` as a value: the tuple of every iteration's result. */
export interface ForExpr {
  type: "for";
  variable: string;
  iterable: Expression;
  body: Expression;
}

/** `if cond { a } else { b }` as a value. */
export interface IfExpr {
  type: "if";
  condition: Expression;
  then: Expression;
  else?: Expression;
}

export interface NumberLiteral {
  type: "number";
  value: number;
}

export interface StringLiteral {
  type: "string";
  value: string;
}

export interface IdentifierExpr {
  type: "identifier";
  name: string;
}

export interface BinaryExpr {
  type: "binary";
  operator: string; // +, -, *, /, %, =, <>, <, <=, >, >=, and, or
  left: Expression;
  right: Expression;
}

export interface UnaryExpr {
  type: "unary";
  operator: string; // -, not
  operand: Expression;
}

export interface FunctionCall {
  type: "call";
  name: string;
  args: Expression[];
}

export interface MemberAccess {
  type: "member";
  object: Expression;
  member: string;
}

export interface SubscriptExpr {
  type: "subscript";
  object: Expression;
  index: Expression;
}

export interface TupleExpr {
  type: "tuple";
  elements: Expression[];
}

/** `from to to [step s]`, or `existing step s` when `to` is absent — a range
 *  value a `for` loop walks and the `in` operator tests, as upstream. */
export interface RangeExpr {
  type: "range";
  from: Expression;
  to?: Expression;
  step?: Expression;
}

/** `material { color … roughness … }` — a bundle of material properties that
 *  `define` can name and the `material` command re-applies. */
export interface MaterialExpr {
  type: "material";
  properties: MaterialProperties;
}

export interface MaterialProperties {
  color?: Color | Expression;
  opacity?: number | Expression;
  metallicity?: number | Expression;
  roughness?: number | Expression;
  glow?: Color | Expression;
  texture?: Expression;
}

export type SceneNode =
  | ShapeNode
  | CSGNode
  | BlockNode
  | ForLoopNode
  | IfNode
  | SwitchNode
  | DefineNode
  | ExtrudeNode
  | LoftNode
  | LatheNode
  | FillNode
  | HullNode
  | GroupNode
  | DetailNode
  | SeedNode
  | PathNode
  | BackgroundNode
  | MaterialNode
  | SmoothingNode
  | PrintNode
  | AssertNode
  | IgnoredNode
  | MeshNode
  | ExpressionStatementNode
  | ColorNode
  | RotateNode
  | OrientationNode
  | TranslateNode
  | ScaleNode
  | CustomShapeNode;

export interface ShapeNode {
  type: "shape";
  primitive: ShapePrimitive;
  properties: ShapeProperties;
  children?: SceneNode[];
  /** `polygon { point … }`: explicit vertices (3D), with `color` and loops,
   *  making a single face rather than a regular polygon. */
  points?: PathCommand[];
}

/** `mesh { polygon { … } … }` — a mesh assembled from polygon values. */
export interface MeshNode {
  type: "mesh";
  children: SceneNode[];
}

/** A bare expression as a statement: a call that returns a shape (`face data`
 *  inside `mesh`), or the value a function body ends with. */
export interface ExpressionStatementNode {
  type: "expression";
  value: Expression;
}

export type ShapePrimitive = "cube" | "sphere" | "icosphere" | "cylinder" | "cone" | "torus" | "circle" | "square" | "roundrect" | "polygon";

export interface ShapeProperties extends MaterialProperties {
  position?: Vector3 | Expression;
  rotation?: Vector3 | Expression;
  orientation?: Vector3 | Expression; // Alias for rotation
  size?: Vector3 | Expression;
  /** `material name` inside a block: every property of the named bundle. */
  material?: Expression;
  /** Per-shape `detail` / `smoothing`, as upstream allows inside any block. */
  detail?: number | Expression;
  smoothing?: number | Expression;
  name?: Expression;
  sides?: number | Expression;
  /** `roundrect` corner radius, as a proportion of the smaller side. */
  radius?: number | Expression;
  // For cylinder/cone specific properties
  radiusTop?: number | Expression;
  radiusBottom?: number | Expression;
  height?: number | Expression;
  // For torus
  innerRadius?: number | Expression;
  outerRadius?: number | Expression;
}

export interface CSGNode {
  type: "csg";
  operation: "union" | "difference" | "intersection" | "xor" | "stencil";
  children: SceneNode[];
}

export interface BlockNode {
  type: "block";
  children: SceneNode[];
}

/** `for v in <iterable> { … }`. The iterable is one expression: a range
 *  (`1 to 5 step 2`, or a symbol holding one) or a tuple of values. */
export interface ForLoopNode {
  type: "for";
  variable: string;
  iterable: Expression;
  body: SceneNode[];
}

export interface IfNode {
  type: "if";
  condition: Expression;
  thenBody: SceneNode[];
  elseBody?: SceneNode[];
}

export interface SwitchNode {
  type: "switch";
  value: Expression;
  cases: Array<{
    values: Expression[];
    body: SceneNode[];
  }>;
  defaultCase?: SceneNode[];
}

export interface TransformNode {
  type: "rotate" | "translate" | "scale";
  values: Vector3;
}

export interface DefineNode {
  type: "define";
  name: string;
  value?: Expression; // For variable definitions, or a function's result expression
  options?: OptionNode[]; // For custom shape definitions
  body?: SceneNode[]; // For custom shape definitions, or a function's leading `define`s
  /** `define name(a b) { … }` — a function. `body` holds its statements
   *  (defines, or shapes it builds) and `value` the expression it ends with,
   *  if any; a function with no final expression returns what it built. */
  params?: string[];
}

export interface OptionNode {
  type: "option";
  name: string;
  defaultValue: Expression;
}

export interface DetailNode {
  type: "detail";
  value: number | Expression;
}

/** `seed N` — reseeds the `rnd` sequence for the rest of the enclosing block. */
export interface SeedNode {
  type: "seed";
  value: Expression;
}

export interface BackgroundNode {
  type: "background";
  value: Expression; // A colour, or a texture file name (which is not supported)
}

/** A scoped material command: `opacity 0.5`, `metallicity 1`, `roughness 0.2`,
 *  `glow red`, `texture "file.png"` (warned, not rendered) or `material name`. */
export interface MaterialNode {
  type: "material";
  property: "opacity" | "metallicity" | "roughness" | "glow" | "texture" | "material";
  value: Expression;
}

/** `smoothing N` — 0 draws every edge sharp (flat shading); anything else smooth. */
export interface SmoothingNode {
  type: "smoothing";
  value: Expression;
}

/** `print a b …` — logged, and returned to the agent with the tool result. */
export interface PrintNode {
  type: "print";
  value: Expression;
}

/** `assert condition` — a failing assertion stops the script. */
export interface AssertNode {
  type: "assert";
  value: Expression;
}

/** A block upstream renders but this renderer does not (`camera`, `light`):
 *  parsed and skipped, with a warning naming it. */
export interface IgnoredNode {
  type: "ignored";
  command: string;
}

export interface ColorNode {
  type: "color";
  value: Expression; // RGB tuple or single value
}

export interface RotateNode {
  type: "rotate";
  value: Expression; // `roll yaw pitch` in half-turns, or `angle x y z` — relative/cumulative
}

export interface OrientationNode {
  type: "orientation";
  value: Expression; // Absolute rotation (sets orientation directly)
}

export interface TranslateNode {
  type: "translate";
  value: Expression; // Translation vector
}

export interface ScaleNode {
  type: "scale";
  value: Expression; // Scale factor or vector
}

export interface CustomShapeNode {
  type: "customShape";
  name: string; // Name of the custom shape defined elsewhere
  properties: Record<string, unknown>; // Option overrides (e.g., { teeth: 8 })
}

export interface ExtrudeNode {
  type: "extrude";
  path?: PathNode;
  properties: ShapeProperties;
  children?: SceneNode[];
}

export interface LoftNode {
  type: "loft";
  properties: ShapeProperties;
  children: SceneNode[];
}

export interface LatheNode {
  type: "lathe";
  properties: ShapeProperties;
  children: SceneNode[];
}

export interface FillNode {
  type: "fill";
  properties: ShapeProperties;
  children: SceneNode[];
}

export interface HullNode {
  type: "hull";
  properties: ShapeProperties;
  children: SceneNode[];
}

export interface GroupNode {
  type: "group";
  children: SceneNode[];
}

export interface PathNode {
  type: "path";
  commands: PathCommand[];
  /** `position` / `orientation` / `size` given inside the path block — the
   *  standard transform options upstream allows on a path, which is how a
   *  `loft` section is placed in 3D without a wrapping `fill`. */
  properties?: ShapeProperties;
}

export type PathCommand =
  | DefineNode
  | PointCommand
  | CurveCommand
  | ArcCommand
  | RotateCommand
  | TranslateCommand
  | ScaleCommand
  | DetailPathCommand
  | ColorPathCommand
  | ForLoopPathCommand;

/** `color …` inside a path or polygon block: the colour of the points that follow. */
export interface ColorPathCommand {
  type: "color";
  value: Expression;
}

export interface PointCommand {
  type: "point";
  x: number | Expression;
  y: number | Expression;
  /** A third coordinate is accepted for upstream compatibility; paths here are
   *  planar, so it must be zero. */
  z?: Expression;
}

/** `arc { angle A [position] [orientation] [size] }` inside a path: a circular
 *  arc of `angle` half-turns, clockwise from +Y, radius `size / 2` (default
 *  0.5), sampled at the current detail. */
export interface ArcCommand {
  type: "arc";
  angle?: Expression;
  position?: Expression;
  orientation?: Expression;
  size?: Expression;
}

/** A quadratic Bézier CONTROL point. The curve passes through the neighbouring
 *  `point`s, not through this one; two `curve`s in a row get an implicit
 *  on-curve midpoint between them, as upstream does. */
export interface CurveCommand {
  type: "curve";
  x: number | Expression;
  y: number | Expression;
  z?: Expression;
}

export interface RotateCommand {
  type: "rotate";
  angle: number | Expression; // half-turns: 0.5 = 90°, positive = clockwise
}

export interface TranslateCommand {
  type: "translate";
  x: number | Expression;
  y: number | Expression;
}

/** `scale x [y]` inside a path. `y` absent means uniform: the one expression
 *  is evaluated once and reused, so `scale rnd` cannot draw two values. */
export interface ScaleCommand {
  type: "scale";
  x: number | Expression;
  y?: number | Expression;
}

export interface DetailPathCommand {
  type: "detail";
  value: number | Expression;
}

export interface ForLoopPathCommand {
  type: "for";
  variable: string;
  iterable: Expression;
  commands: PathCommand[];
}

// Token types for the lexer
export enum TokenType {
  // Primitives
  CUBE = "CUBE",
  SPHERE = "SPHERE",
  ICOSPHERE = "ICOSPHERE",
  ROUNDRECT = "ROUNDRECT",
  CYLINDER = "CYLINDER",
  CONE = "CONE",
  TORUS = "TORUS",
  CIRCLE = "CIRCLE",
  SQUARE = "SQUARE",
  POLYGON = "POLYGON",

  // Builders
  EXTRUDE = "EXTRUDE",
  LOFT = "LOFT",
  LATHE = "LATHE",
  FILL = "FILL",
  HULL = "HULL",
  GROUP = "GROUP",
  MESH = "MESH",
  PATH = "PATH",
  POINT = "POINT",
  CURVE = "CURVE",
  ARC = "ARC",
  DETAIL = "DETAIL",
  SMOOTHING = "SMOOTHING",
  SEED = "SEED",
  BACKGROUND = "BACKGROUND",
  TEXTURE = "TEXTURE",
  MATERIAL = "MATERIAL",
  METALLICITY = "METALLICITY",
  ROUGHNESS = "ROUGHNESS",
  GLOW = "GLOW",
  PRINT = "PRINT",
  ASSERT = "ASSERT",

  // CSG Operations
  UNION = "UNION",
  DIFFERENCE = "DIFFERENCE",
  INTERSECTION = "INTERSECTION",
  XOR = "XOR",
  STENCIL = "STENCIL",

  // Control Flow
  FOR = "FOR",
  IN = "IN",
  TO = "TO",
  STEP = "STEP",
  IF = "IF",
  ELSE = "ELSE",
  SWITCH = "SWITCH",
  CASE = "CASE",
  DEFINE = "DEFINE",
  OPTION = "OPTION",

  // Properties
  POSITION = "POSITION",
  ROTATION = "ROTATION",
  ORIENTATION = "ORIENTATION",
  SIZE = "SIZE",
  COLOR = "COLOR",
  OPACITY = "OPACITY",
  ROTATE = "ROTATE",
  TRANSLATE = "TRANSLATE",
  SCALE = "SCALE",

  // Literals
  NUMBER = "NUMBER",
  IDENTIFIER = "IDENTIFIER",
  STRING = "STRING",
  /** `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`; the value is the digits. */
  HEXCOLOR = "HEXCOLOR",

  // Operators
  PLUS = "PLUS",
  MINUS = "MINUS",
  STAR = "STAR",
  DIVIDE = "DIVIDE",
  PERCENT = "PERCENT",
  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  LBRACKET = "LBRACKET",
  RBRACKET = "RBRACKET",
  DOT = "DOT",
  EQUALS = "EQUALS",
  NOT_EQUALS = "NOT_EQUALS",
  LESS = "LESS",
  LESS_EQUAL = "LESS_EQUAL",
  GREATER = "GREATER",
  GREATER_EQUAL = "GREATER_EQUAL",
  AND = "AND",
  OR = "OR",
  NOT = "NOT",

  // Symbols
  LBRACE = "LBRACE",
  RBRACE = "RBRACE",
  COMMA = "COMMA",
  SLASH = "SLASH",

  // Special
  NEWLINE = "NEWLINE",
  EOF = "EOF",
  COMMENT = "COMMENT",
}

export interface Token {
  type: TokenType;
  value: string | number;
  line: number;
  column: number;
  precedingWhitespace?: boolean; // True if whitespace came before this token
}

export class ParseError extends Error {
  constructor(
    message: string,
    public line?: number,
    public column?: number,
  ) {
    super(line !== undefined && column !== undefined ? `Parse error at line ${line}, column ${column}: ${message}` : `Parse error: ${message}`);
    this.name = "ParseError";
  }
}
