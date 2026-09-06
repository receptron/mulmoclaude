// ShapeScript AST Type Definitions

export type Vector3 = [number, number, number];
export type Color = [number, number, number];

// Expression types
export type Expression = NumberLiteral | IdentifierExpr | BinaryExpr | UnaryExpr | FunctionCall | MemberAccess | SubscriptExpr | TupleExpr;

export interface NumberLiteral {
  type: "number";
  value: number;
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
  | PathNode
  | BackgroundNode
  | TextureNode
  | ColorNode
  | RotateNode
  | OrientationNode
  | TranslateNode
  | ScaleNode
  | CustomShapeNode;

export interface ShapeNode {
  type: "shape";
  primitive: "cube" | "sphere" | "cylinder" | "cone" | "torus" | "circle" | "square" | "polygon";
  properties: ShapeProperties;
  children?: SceneNode[];
}

export interface ShapeProperties {
  position?: Vector3 | Expression;
  rotation?: Vector3 | Expression;
  orientation?: Vector3 | Expression; // Alias for rotation
  size?: Vector3 | Expression;
  color?: Color | Expression;
  opacity?: number | Expression;
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

export interface ForLoopNode {
  type: "for";
  variable: string;
  from: Expression | number;
  to: Expression | number;
  step?: Expression | number;
  iterableValues?: Expression; // For "for i in values"
  body: SceneNode[];
  transforms?: TransformNode[];
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
  value?: Expression; // For variable definitions
  options?: OptionNode[]; // For custom shape definitions
  body?: SceneNode[]; // For custom shape definitions
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

export interface BackgroundNode {
  type: "background";
  value: Expression; // Usually a string (filename)
}

export interface TextureNode {
  type: "texture";
  value: Expression; // Usually a string (filename)
}

export interface ColorNode {
  type: "color";
  value: Expression; // RGB tuple or single value
}

export interface RotateNode {
  type: "rotate";
  value: Expression; // Rotation value (half-turns) or tuple - relative/cumulative
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
}

export type PathCommand = PointCommand | CurveCommand | RotateCommand | TranslateCommand | DetailPathCommand | ForLoopPathCommand;

export interface PointCommand {
  type: "point";
  x: number | Expression;
  y: number | Expression;
}

export interface CurveCommand {
  type: "curve";
  x: number | Expression;
  y: number | Expression;
  controlX?: number | Expression;
  controlY?: number | Expression;
}

export interface RotateCommand {
  type: "rotate";
  angle: number | Expression; // In ShapeScript, 1 = 360 degrees
}

export interface TranslateCommand {
  type: "translate";
  x: number | Expression;
  y: number | Expression;
}

export interface DetailPathCommand {
  type: "detail";
  value: number | Expression;
}

export interface ForLoopPathCommand {
  type: "for";
  variable: string;
  from: number | Expression;
  to: number | Expression;
  step?: number | Expression;
  commands: PathCommand[];
}

// Token types for the lexer
export enum TokenType {
  // Primitives
  CUBE = "CUBE",
  SPHERE = "SPHERE",
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
  PATH = "PATH",
  POINT = "POINT",
  CURVE = "CURVE",
  DETAIL = "DETAIL",
  BACKGROUND = "BACKGROUND",
  TEXTURE = "TEXTURE",

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
