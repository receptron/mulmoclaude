import {
  Token,
  TokenType,
  SceneNode,
  ShapeNode,
  CSGNode,
  ForLoopNode,
  IfNode,
  SwitchNode,
  DefineNode,
  OptionNode,
  ExtrudeNode,
  DetailNode,
  BackgroundNode,
  MaterialNode,
  MaterialProperties,
  PathNode,
  PathCommand,
  PointCommand,
  CurveCommand,
  ArcCommand,
  TranslateCommand,
  ScaleCommand,
  ForLoopPathCommand,
  SeedNode,
  Expression,
  ParseError,
  GroupNode,
  LoftNode,
  LatheNode,
  FillNode,
  HullNode,
  ShapeProperties,
  ShapePrimitive,
} from "./types";
import { BUILT_IN_FUNCTION_NAMES } from "./evaluator";

/** Blocks upstream renders through its own viewer and this renderer skips with
 *  a warning: a camera only frames the upstream app, and lights are not
 *  modelled here. Skipping keeps a script that carries them renderable. */
const IGNORED_BLOCKS = new Set(["camera", "light"]);

/** Upstream commands this renderer has no equivalent for. Named individually
 *  so the diagnostic says what was meant rather than "Unknown shape". */
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  text: "`text` (3D text) is not supported by this renderer",
  font: "`font` is not supported by this renderer",
  import: "`import` is not supported by this renderer — inline the shapes instead",
  mesh: "raw `mesh { polygon … }` is not supported by this renderer — build the shape from primitives, paths and builders",
  polygon: "`polygon { point … }` with explicit points is not supported — use `polygon { sides N }` or a `path`",
  minkowski: "`minkowski` is not supported by this renderer",
  inset: "`inset` is not supported by this renderer",
  svgpath: "`svgpath` is not supported by this renderer — write the outline as a `path`",
  object: "`object` values are not supported by this renderer — use tuples",
  along: "`extrude … along` is not supported by this renderer",
  normals: "`normals` (normal maps) are not supported by this renderer",
  focus: "`focus` is not supported by this renderer",
  debug: "`debug` is not supported by this renderer",
};

/** Own-property lookup: `toString` must not resolve off Object.prototype. */
const unsupportedMessage = (name: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(UNSUPPORTED_COMMANDS, name) ? UNSUPPORTED_COMMANDS[name] : undefined;

// Lexer/Tokenizer
class Lexer {
  private input: string;
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(input: string) {
    this.input = input;
  }

  private peek(offset = 0): string {
    return this.input[this.pos + offset] || "";
  }

  private advance(): string {
    const char = this.input[this.pos++] ?? "";
    if (char === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return char;
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\r") {
        this.advance();
      } else if (char === "/" && this.peek(1) === "/") {
        // Skip single-line comment
        while (this.peek() && this.peek() !== "\n") {
          this.advance();
        }
      } else if (char === "/" && this.peek(1) === "*") {
        // Skip multi-line comment (with nesting support)
        this.advance(); // /
        this.advance(); // *
        let depth = 1;
        while (this.pos < this.input.length && depth > 0) {
          if (this.peek() === "/" && this.peek(1) === "*") {
            depth++;
            this.advance();
            this.advance();
          } else if (this.peek() === "*" && this.peek(1) === "/") {
            depth--;
            this.advance();
            this.advance();
          } else {
            this.advance();
          }
        }
        if (depth > 0) throw new ParseError("Unterminated block comment", this.line, this.column);
      } else {
        break;
      }
    }
  }

  private readNumber(): Token {
    const line = this.line;
    const column = this.column;
    const match = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(this.input.slice(this.pos));
    if (!match) throw new ParseError("Invalid number", line, column);
    const numStr = match[0];
    for (let i = 0; i < numStr.length; i++) this.advance();
    if ((this.peek() === "." && /[0-9]/.test(this.peek(1))) || !Number.isFinite(Number(numStr))) throw new ParseError("Invalid number", line, column);

    return {
      type: TokenType.NUMBER,
      value: parseFloat(numStr),
      line,
      column,
    };
  }

  private readIdentifier(): Token {
    const line = this.line;
    const column = this.column;
    let id = "";

    while (this.pos < this.input.length) {
      const char = this.peek();
      if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_") {
        id += this.advance();
      } else {
        break;
      }
    }

    // Map keywords to token types
    const keywords: Record<string, TokenType> = {
      cube: TokenType.CUBE,
      sphere: TokenType.SPHERE,
      icosphere: TokenType.ICOSPHERE,
      roundrect: TokenType.ROUNDRECT,
      cylinder: TokenType.CYLINDER,
      cone: TokenType.CONE,
      torus: TokenType.TORUS,
      circle: TokenType.CIRCLE,
      square: TokenType.SQUARE,
      polygon: TokenType.POLYGON,
      extrude: TokenType.EXTRUDE,
      loft: TokenType.LOFT,
      lathe: TokenType.LATHE,
      fill: TokenType.FILL,
      hull: TokenType.HULL,
      group: TokenType.GROUP,
      path: TokenType.PATH,
      point: TokenType.POINT,
      curve: TokenType.CURVE,
      arc: TokenType.ARC,
      detail: TokenType.DETAIL,
      smoothing: TokenType.SMOOTHING,
      seed: TokenType.SEED,
      background: TokenType.BACKGROUND,
      texture: TokenType.TEXTURE,
      material: TokenType.MATERIAL,
      metallicity: TokenType.METALLICITY,
      roughness: TokenType.ROUGHNESS,
      glow: TokenType.GLOW,
      print: TokenType.PRINT,
      assert: TokenType.ASSERT,
      union: TokenType.UNION,
      difference: TokenType.DIFFERENCE,
      intersection: TokenType.INTERSECTION,
      xor: TokenType.XOR,
      stencil: TokenType.STENCIL,
      for: TokenType.FOR,
      in: TokenType.IN,
      to: TokenType.TO,
      step: TokenType.STEP,
      if: TokenType.IF,
      else: TokenType.ELSE,
      switch: TokenType.SWITCH,
      case: TokenType.CASE,
      define: TokenType.DEFINE,
      option: TokenType.OPTION,
      position: TokenType.POSITION,
      rotation: TokenType.ROTATION,
      orientation: TokenType.ORIENTATION,
      size: TokenType.SIZE,
      color: TokenType.COLOR,
      colour: TokenType.COLOR,
      opacity: TokenType.OPACITY,
      rotate: TokenType.ROTATE,
      translate: TokenType.TRANSLATE,
      scale: TokenType.SCALE,
      and: TokenType.AND,
      or: TokenType.OR,
      not: TokenType.NOT,
    };

    const type = keywords[id.toLowerCase()] || TokenType.IDENTIFIER;

    return {
      type,
      value: id,
      line,
      column,
    };
  }

  private readString(): Token {
    const line = this.line;
    const column = this.column;
    let str = "";
    let terminated = false;

    this.advance(); // consume opening quote

    while (this.pos < this.input.length) {
      const char = this.peek();

      if (char === '"') {
        this.advance(); // consume closing quote
        terminated = true;
        break;
      } else if (char === "\\") {
        // Handle escape sequences
        this.advance();
        const nextChar = this.peek();
        if (nextChar === '"' || nextChar === "\\") {
          str += this.advance();
        } else if (nextChar === "n") {
          str += "\n";
          this.advance();
        } else if (nextChar === "t") {
          str += "\t";
          this.advance();
        } else {
          str += nextChar;
          this.advance();
        }
      } else {
        str += this.advance();
      }
    }

    // Without this the loop just runs out of input and the token swallows the
    // rest of the file, so a missing quote renders wrong geometry instead of
    // reporting the typo. Scripts are model-authored; the typo is likely.
    if (!terminated) {
      throw new ParseError(`Unterminated string literal`, line, column);
    }

    return {
      type: TokenType.STRING,
      value: str,
      line,
      column,
    };
  }

  /** `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`, as in web colours. */
  private readHexColor(): Token {
    const line = this.line;
    const column = this.column;
    this.advance(); // #
    let digits = "";
    while (/[0-9a-fA-F]/.test(this.peek())) digits += this.advance();
    if (![3, 4, 6, 8].includes(digits.length) || /[0-9a-zA-Z_]/.test(this.peek())) {
      throw new ParseError("Invalid hex color — use #RGB, #RGBA, #RRGGBB or #RRGGBBAA", line, column);
    }
    return { type: TokenType.HEXCOLOR, value: digits, line, column };
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.pos < this.input.length) {
      // Track if we skipped whitespace before this token
      const startPos = this.pos;
      this.skipWhitespace();
      const hadWhitespace = this.pos > startPos;

      if (this.pos >= this.input.length) break;

      const char = this.peek();
      const line = this.line;
      const column = this.column;
      const previous = tokens[tokens.length - 1];

      // Numbers
      if (
        (char >= "0" && char <= "9") ||
        (char === "." && this.peek(1) >= "0" && this.peek(1) <= "9") ||
        (char === "-" &&
          this.peek(1) >= "0" &&
          this.peek(1) <= "9" &&
          (previous === undefined ||
            previous.type === TokenType.LPAREN ||
            previous.type === TokenType.COMMA ||
            previous.type === TokenType.LBRACE ||
            previous.type === TokenType.LBRACKET ||
            this.isOperator(previous.type)))
      ) {
        const token = this.readNumber();
        token.precedingWhitespace = hadWhitespace;
        tokens.push(token);
      }
      // Identifiers and keywords
      else if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z")) {
        const token = this.readIdentifier();
        token.precedingWhitespace = hadWhitespace;
        tokens.push(token);
      }
      // String literals
      else if (char === '"') {
        const token = this.readString();
        token.precedingWhitespace = hadWhitespace;
        tokens.push(token);
      }
      // `#RRGGBB` colour literals
      else if (char === "#") {
        const token = this.readHexColor();
        token.precedingWhitespace = hadWhitespace;
        tokens.push(token);
      }
      // Two-character operators
      else if (char === "<" && this.peek(1) === ">") {
        this.advance();
        this.advance();
        tokens.push({
          type: TokenType.NOT_EQUALS,
          value: "<>",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "<" && this.peek(1) === "=") {
        this.advance();
        this.advance();
        tokens.push({
          type: TokenType.LESS_EQUAL,
          value: "<=",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === ">" && this.peek(1) === "=") {
        this.advance();
        this.advance();
        tokens.push({
          type: TokenType.GREATER_EQUAL,
          value: ">=",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      }
      // Single-character operators and symbols
      else if (char === "+") {
        this.advance();
        tokens.push({
          type: TokenType.PLUS,
          value: "+",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "-") {
        this.advance();
        tokens.push({
          type: TokenType.MINUS,
          value: "-",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "*") {
        this.advance();
        tokens.push({
          type: TokenType.STAR,
          value: "*",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "/") {
        this.advance();
        tokens.push({
          type: TokenType.DIVIDE,
          value: "/",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "%") {
        this.advance();
        tokens.push({
          type: TokenType.PERCENT,
          value: "%",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "(") {
        this.advance();
        tokens.push({
          type: TokenType.LPAREN,
          value: "(",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === ")") {
        this.advance();
        tokens.push({
          type: TokenType.RPAREN,
          value: ")",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "[") {
        this.advance();
        tokens.push({
          type: TokenType.LBRACKET,
          value: "[",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "]") {
        this.advance();
        tokens.push({
          type: TokenType.RBRACKET,
          value: "]",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "{") {
        this.advance();
        tokens.push({
          type: TokenType.LBRACE,
          value: "{",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "}") {
        this.advance();
        tokens.push({
          type: TokenType.RBRACE,
          value: "}",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === ",") {
        this.advance();
        tokens.push({
          type: TokenType.COMMA,
          value: ",",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === ".") {
        this.advance();
        tokens.push({
          type: TokenType.DOT,
          value: ".",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "=") {
        this.advance();
        tokens.push({
          type: TokenType.EQUALS,
          value: "=",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "<") {
        this.advance();
        tokens.push({
          type: TokenType.LESS,
          value: "<",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === ">") {
        this.advance();
        tokens.push({
          type: TokenType.GREATER,
          value: ">",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else if (char === "\n") {
        this.advance();
        tokens.push({
          type: TokenType.NEWLINE,
          value: "\n",
          line,
          column,
          precedingWhitespace: hadWhitespace,
        });
      } else {
        throw new ParseError(`Unexpected character: '${char}'`, line, column);
      }
    }

    tokens.push({
      type: TokenType.EOF,
      value: "",
      line: this.line,
      column: this.column,
      precedingWhitespace: false,
    });

    return tokens;
  }

  private isOperator(type: TokenType): boolean {
    return (
      type === TokenType.PLUS ||
      type === TokenType.MINUS ||
      type === TokenType.STAR ||
      type === TokenType.DIVIDE ||
      type === TokenType.PERCENT ||
      type === TokenType.EQUALS ||
      type === TokenType.NOT_EQUALS ||
      type === TokenType.LESS ||
      type === TokenType.LESS_EQUAL ||
      type === TokenType.GREATER ||
      type === TokenType.GREATER_EQUAL ||
      type === TokenType.AND ||
      type === TokenType.OR
    );
  }
}

/** Tokens that begin a shape or builder — a value upstream can hold and this
 *  renderer cannot. */
const SHAPE_VALUE_TOKENS = new Set([
  TokenType.CUBE,
  TokenType.SPHERE,
  TokenType.ICOSPHERE,
  TokenType.CYLINDER,
  TokenType.CONE,
  TokenType.TORUS,
  TokenType.CIRCLE,
  TokenType.SQUARE,
  TokenType.ROUNDRECT,
  TokenType.POLYGON,
  TokenType.EXTRUDE,
  TokenType.LOFT,
  TokenType.LATHE,
  TokenType.FILL,
  TokenType.HULL,
  TokenType.GROUP,
  TokenType.PATH,
  TokenType.UNION,
  TokenType.DIFFERENCE,
  TokenType.INTERSECTION,
  TokenType.XOR,
  TokenType.STENCIL,
]);

/** Tokens that open a standard shape property inside a custom block call. */
const STANDARD_PROPERTY_TOKENS = new Set([
  TokenType.POSITION,
  TokenType.ROTATION,
  TokenType.ORIENTATION,
  TokenType.SIZE,
  TokenType.COLOR,
  TokenType.OPACITY,
  TokenType.MATERIAL,
  TokenType.METALLICITY,
  TokenType.ROUGHNESS,
  TokenType.GLOW,
  TokenType.TEXTURE,
  TokenType.DETAIL,
  TokenType.SMOOTHING,
]);

/** `#RGB[A]` / `#RRGGBB[AA]` as a literal RGBA tuple in 0–1. */
function hexColorExpression(digits: string): Expression {
  const wide = digits.length >= 6;
  const channels: number[] = [];
  for (let i = 0; i < digits.length; i += wide ? 2 : 1) {
    const pair = wide ? digits.slice(i, i + 2) : digits[i]! + digits[i]!;
    channels.push(parseInt(pair, 16) / 255);
  }
  if (channels.length === 3) channels.push(1);
  return { type: "tuple", elements: channels.map((value) => ({ type: "number", value })) };
}

function materialSubset(properties: ShapeProperties): MaterialProperties {
  const material: MaterialProperties = {};
  for (const key of ["color", "opacity", "metallicity", "roughness", "glow", "texture"] as const) {
    const value = properties[key];
    if (value !== undefined) material[key] = value as Expression;
  }
  return material;
}

// Parser
export class Parser {
  /** Whether the expression being parsed is one value of a whitespace-separated
   *  list. See `withValueList`. */
  private valueList = false;
  /** Names a bare call may use (`max 0 1`, `sqrt 9`): the built-ins plus every
   *  `define name(…)` seen so far, minus names a plain `define` shadows. Lexical
   *  and unscoped — a shadow inside a block outlives the block, which only
   *  matters to a script that reuses a function's name for a number. */
  private callable = new Set<string>(BUILT_IN_FUNCTION_NAMES);
  /** Custom block names, so a user-defined `light` is still invoked rather
   *  than skipped as the upstream light source. */
  private blocks = new Set<string>();

  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // The token stream always ends with an EOF token, so `at()` past the end
  // returns that instead of `undefined` — the invariant the callers below
  // already relied on before `noUncheckedIndexedAccess` made it explicit.
  private at(index: number): Token {
    const token = this.tokens[index] ?? this.tokens[this.tokens.length - 1];
    if (token === undefined) throw new Error("ShapeScript token stream is empty");
    return token;
  }

  private current(): Token {
    return this.at(this.pos);
  }

  private peek(offset = 1): Token {
    return this.at(this.pos + offset);
  }

  private advance(): Token {
    return this.at(this.pos++);
  }

  private expect(type: TokenType): Token {
    const token = this.current();
    if (token.type !== type) {
      throw new ParseError(`Expected ${type} but got ${token.type}`, token.line, token.column);
    }
    return this.advance();
  }

  // Expect an identifier, but allow keywords to be used as identifiers
  private expectIdentifier(): Token {
    const token = this.current();
    if (token.type === TokenType.IDENTIFIER) {
      return this.advance();
    }
    // Allow certain keywords to be used as identifiers
    if (typeof token.value === "string") {
      return this.advance();
    }
    throw new ParseError(`Expected identifier but got ${token.type}`, token.line, token.column);
  }

  private skipNewlines(): void {
    while (this.current().type === TokenType.NEWLINE) {
      this.advance();
    }
  }

  // Expression parsing with precedence climbing
  private parseExpression(minPrec = 0): Expression {
    let left = this.parsePrimary();

    while (true) {
      const token = this.current();
      // A separated sign attached to its operand begins the next tuple value:
      // `1 +2` means (1, 2), while `1+2` and `1 + 2` mean addition. Only where a
      // whitespace-separated list is actually being read — inside call
      // arguments, subscripts and loop bounds, ` -1` is arithmetic.
      if (this.valueList && this.isStartOfNewValue()) break;
      const prec = this.getPrecedence(token.type);

      if (prec < minPrec) break;

      const operator = this.tokenTypeToOperator(token.type);
      if (!operator) break;

      this.advance(); // consume operator

      const right = this.parseExpression(prec + 1);

      left = {
        type: "binary",
        operator,
        left,
        right,
      };
    }

    return minPrec === 0 ? this.parseRangeTail(left) : left;
  }

  /** `a to b [step s]` after a full expression, or `range step s` to re-step a
   *  range held in a symbol. Lowest precedence of all, so `1 to n - 1` runs to
   *  `n - 1`; only a whole expression (minPrec 0) can become a range. */
  private parseRangeTail(from: Expression): Expression {
    if (this.current().type === TokenType.TO) {
      this.advance();
      const to = this.parseExpression(1);
      if (this.current().type === TokenType.STEP) {
        this.advance();
        return { type: "range", from, to, step: this.parseExpression(1) };
      }
      return { type: "range", from, to };
    }
    if (this.current().type === TokenType.STEP) {
      this.advance();
      return { type: "range", from, step: this.parseExpression(1) };
    }
    return from;
  }

  private parsePrimary(): Expression {
    let expression = this.parseAtom();
    while (this.current().type === TokenType.DOT || this.current().type === TokenType.LBRACKET) {
      if (this.current().type === TokenType.DOT) {
        this.advance();
        const token = this.current();
        if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(String(token.value))) {
          throw new ParseError("Expected a member name after '.'", token.line, token.column);
        }
        this.advance();
        expression = { type: "member", object: expression, member: String(token.value) };
      } else {
        this.advance();
        const index = this.withValueList(false, () => this.parseExpression());
        this.expect(TokenType.RBRACKET);
        expression = { type: "subscript", object: expression, index };
      }
    }
    return expression;
  }

  /** The body of a `( … )`, with the opening paren already consumed.
   *
   *  Both a grouped expression and a space- or comma-separated tuple live here,
   *  so its elements are read as a VALUE LIST: `(1 +2 +3)` is three components,
   *  the same as `1 +2 +3` written without the parens. */
  private parseParenthesized(): Expression {
    const elements: Expression[] = [this.parseExpression()];

    if (this.current().type === TokenType.COMMA) {
      this.parseCommaSeparated(elements);
    } else {
      this.parseSpaceSeparated(elements);
    }

    this.expect(TokenType.RPAREN);

    if (elements.length === 1 && elements[0] !== undefined) {
      return elements[0]; // Single parenthesized expression
    }
    return { type: "tuple", elements }; // Tuple
  }

  /** `(1, 2, 3)` — a trailing comma before the `)` ends the list. */
  private parseCommaSeparated(elements: Expression[]): void {
    while (this.current().type === TokenType.COMMA) {
      this.advance();
      if (this.current().type === TokenType.RPAREN) break;
      elements.push(this.parseExpression());
    }
  }

  /** `(1 2 3)` — components held apart by nothing but whitespace. */
  private parseSpaceSeparated(elements: Expression[]): void {
    while (this.startsValue()) {
      elements.push(this.parseExpression());
    }
  }

  private parseAtom(): Expression {
    const token = this.current();

    // Unary operators
    if (token.type === TokenType.MINUS || token.type === TokenType.PLUS || token.type === TokenType.NOT) {
      this.advance();
      return {
        type: "unary",
        operator: token.type === TokenType.MINUS ? "-" : token.type === TokenType.PLUS ? "+" : "not",
        operand: this.parsePrimary(),
      };
    }

    // Parenthesized expression or tuple
    if (token.type === TokenType.LPAREN) {
      this.advance();
      return this.withValueList(true, () => this.parseParenthesized());
    }

    // Number literal
    if (token.type === TokenType.NUMBER) {
      this.advance();
      return {
        type: "number",
        value: token.value as number,
      };
    }

    // String literal
    if (token.type === TokenType.STRING) {
      this.advance();
      return {
        type: "string",
        value: token.value as string,
      };
    }

    if (token.type === TokenType.HEXCOLOR) {
      this.advance();
      return hexColorExpression(String(token.value));
    }

    // `material { … }` — a bundle of material properties as a value
    if (token.type === TokenType.MATERIAL && this.peek().type === TokenType.LBRACE) {
      this.advance();
      this.expect(TokenType.LBRACE);
      const properties = this.parseProperties();
      this.expect(TokenType.RBRACE);
      return { type: "material", properties: materialSubset(properties) };
    }

    // Identifier or function call
    if (token.type === TokenType.IDENTIFIER) {
      const name = token.value as string;
      this.advance();

      // Function call: only if '(' immediately follows with NO space
      // e.g., "sin(x)" is a function call, but "sin (x)" is not
      if (this.current().type === TokenType.LPAREN && !this.current().precedingWhitespace) {
        this.advance();
        const args: Expression[] = [];

        // The arguments are a VALUE LIST, exactly as the body of `( … )` is:
        // `max(0 (j - 1))` is upstream's C-like spelling and `max(0, j - 1)`
        // the one this plugin always took. Reading both through the tuple
        // rules means a script can be written once for either parser.
        this.withValueList(true, () => {
          if (this.current().type === TokenType.RPAREN) return;
          args.push(this.parseExpression());
          if (this.current().type === TokenType.COMMA) {
            this.parseCommaSeparated(args);
          } else {
            this.parseSpaceSeparated(args);
          }
        });

        this.expect(TokenType.RPAREN);

        return {
          type: "call",
          name,
          args,
        };
      }

      // Bare call, upstream's Lisp-like spelling: `max 0 1`, `sqrt 9`, `sin pi / 2`.
      // The function takes every value that follows it, each a full expression,
      // so `sin pi / 2` is sin(pi / 2) and `size max 1 2` is one number.
      if (this.callable.has(name) && this.startsValue()) {
        const args: Expression[] = [];
        this.withValueList(true, () => {
          while (this.startsValue()) args.push(this.parseExpression());
        });
        return { type: "call", name, args };
      }

      // Simple identifier
      return {
        type: "identifier",
        name,
      };
    }

    // Allow keywords to be used as identifiers in expressions
    // (e.g., "define step 5" then "rotate step")
    if (typeof token.value === "string" && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(token.value)) {
      const name = token.value;
      this.advance();
      return {
        type: "identifier",
        name,
      };
    }

    throw new ParseError(`Unexpected token in expression: ${token.type}`, token.line, token.column);
  }

  private getPrecedence(type: TokenType): number {
    switch (type) {
      case TokenType.OR:
        return 1;
      case TokenType.AND:
        return 2;
      case TokenType.EQUALS:
      case TokenType.NOT_EQUALS:
      case TokenType.IN:
        return 3;
      case TokenType.LESS:
      case TokenType.LESS_EQUAL:
      case TokenType.GREATER:
      case TokenType.GREATER_EQUAL:
        return 4;
      case TokenType.PLUS:
      case TokenType.MINUS:
        return 5;
      case TokenType.STAR:
      case TokenType.DIVIDE:
      case TokenType.PERCENT:
        return 6;
      default:
        return 0;
    }
  }

  private tokenTypeToOperator(type: TokenType): string | null {
    switch (type) {
      case TokenType.PLUS:
        return "+";
      case TokenType.MINUS:
        return "-";
      case TokenType.STAR:
        return "*";
      case TokenType.DIVIDE:
        return "/";
      case TokenType.PERCENT:
        return "%";
      case TokenType.EQUALS:
        return "=";
      case TokenType.NOT_EQUALS:
        return "<>";
      case TokenType.IN:
        return "in";
      case TokenType.LESS:
        return "<";
      case TokenType.LESS_EQUAL:
        return "<=";
      case TokenType.GREATER:
        return ">";
      case TokenType.GREATER_EQUAL:
        return ">=";
      case TokenType.AND:
        return "and";
      case TokenType.OR:
        return "or";
      default:
        return null;
    }
  }

  // Parse vector or expression
  // Handles both: "x y z" (space-separated) and "(x, y, z)" (tuple)
  private parseVectorOrExpression(): Expression {
    return this.withValueList(true, () => this.parseValueList());
  }

  /** One property value: `1 -2 3` is a vector, `max(1 2)` a single expression,
   *  and `wheel { … }` a custom shape invocation that belongs to no list. */
  private parseValueList(): Expression {
    const first = this.parseExpression();
    if (!this.startsComponent()) return first;

    const elements: Expression[] = [first];
    while (this.startsComponent()) {
      elements.push(this.parseExpression());
    }
    return elements.length > 1 ? { type: "tuple", elements } : first;
  }

  private parseProperties(): ShapeProperties {
    const properties: ShapeProperties = {};

    while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
      this.skipNewlines();

      const token = this.current();

      switch (token.type) {
        case TokenType.POSITION:
          this.advance();
          properties.position = this.parseVectorOrExpression();
          break;

        case TokenType.ROTATION:
          this.advance();
          properties.rotation = this.parseVectorOrExpression();
          break;

        case TokenType.ORIENTATION:
          this.advance();
          properties.orientation = this.parseVectorOrExpression();
          break;

        case TokenType.SIZE:
          this.advance();
          properties.size = this.parseVectorOrExpression();
          break;

        case TokenType.COLOR:
          this.advance();
          properties.color = this.parseVectorOrExpression();
          break;

        case TokenType.OPACITY:
          this.advance();
          properties.opacity = this.parseExpression();
          break;

        case TokenType.MATERIAL:
          this.advance();
          properties.material = this.parseExpression();
          break;

        case TokenType.METALLICITY:
        case TokenType.ROUGHNESS:
        case TokenType.GLOW:
        case TokenType.TEXTURE:
          this.advance();
          properties[String(token.value).toLowerCase() as "glow"] = this.parseVectorOrExpression();
          break;

        case TokenType.DETAIL:
        case TokenType.SMOOTHING:
          this.advance();
          properties[String(token.value).toLowerCase() as "detail"] = this.parseExpression();
          break;

        case TokenType.RBRACE:
          // End of properties block
          return properties;

        case TokenType.IDENTIFIER: {
          const key = String(token.value);
          if (!["sides", "radiusTop", "radiusBottom", "height", "innerRadius", "outerRadius", "radius", "name"].includes(key)) return properties;
          this.advance();
          properties[key as "sides"] = this.parseExpression();
          break;
        }

        default:
          // Not a property token - stop parsing properties and return
          return properties;
      }

      this.skipNewlines();
    }

    return properties;
  }

  private parseBlockContents(): SceneNode[] {
    return this.scoped(() => {
      this.skipNewlines();

      const nodes: SceneNode[] = [];

      while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
        const node = this.parseNode();
        if (node) {
          nodes.push(node);
        }
        this.skipNewlines();
      }

      return nodes;
    });
  }

  /** Run `parse` with the callable and block name sets scoped to it, so a
   *  `define max 5` inside a block stops shadowing the built-in at the
   *  block's closing brace — the parser-side mirror of the runtime scope. */
  private scoped<T>(parse: () => T): T {
    const callable = this.callable;
    const blocks = this.blocks;
    this.callable = new Set(callable);
    this.blocks = new Set(blocks);
    try {
      return parse();
    } finally {
      this.callable = callable;
      this.blocks = blocks;
    }
  }

  private parseBlock(): SceneNode[] {
    this.expect(TokenType.LBRACE);
    const nodes = this.parseBlockContents();
    this.expect(TokenType.RBRACE);
    return nodes;
  }

  private parseShape(primitive: ShapePrimitive): ShapeNode {
    this.advance(); // consume primitive token

    let properties: ShapeProperties = {};

    if (this.current().type === TokenType.LBRACE) {
      this.expect(TokenType.LBRACE);
      properties = this.parseProperties();
      this.expect(TokenType.RBRACE);
    }

    return {
      type: "shape",
      primitive,
      properties,
    };
  }

  private parseCSG(operation: "union" | "difference" | "intersection" | "xor" | "stencil"): CSGNode {
    this.advance(); // consume operation token

    const children = this.parseBlock();

    return {
      type: "csg",
      operation,
      children,
    };
  }

  /** `for [name in] <range or tuple> { … }`. The range is an ordinary
   *  expression (`1 to n step 2`, or a symbol holding one), so `for 1 to 5`
   *  and `for i in loops` read the same way. */
  private parseForLoop(): ForLoopNode {
    this.advance(); // consume 'for'
    const { variable, iterable } = this.parseLoopHeader();
    // The loop variable shadows a function of the same name inside the body.
    const body = this.scoped(() => {
      this.callable.delete(variable);
      return this.parseBlock();
    });
    return { type: "for", variable, iterable, body };
  }

  private parseLoopHeader(): { variable: string; iterable: Expression } {
    let variable = "_i";
    if (this.current().type === TokenType.IDENTIFIER && this.peek().type === TokenType.IN) {
      variable = this.current().value as string;
      this.advance();
      this.advance();
    }
    return { variable, iterable: this.parseExpression() };
  }

  private parseIf(): IfNode {
    this.advance(); // consume 'if'

    const condition = this.parseExpression();
    const thenBody = this.parseBlock();

    let elseBody: SceneNode[] | undefined;

    this.skipNewlines();

    if (this.current().type === TokenType.ELSE) {
      this.advance();
      this.skipNewlines();

      // Check for 'else if'
      if (this.current().type === TokenType.IF) {
        elseBody = [this.parseIf()];
      } else {
        elseBody = this.parseBlock();
      }
    }

    return {
      type: "if",
      condition,
      thenBody,
      ...(elseBody === undefined ? {} : { elseBody }),
    };
  }

  private parseSwitch(): SwitchNode {
    this.advance(); // consume 'switch'

    const value = this.parseExpression();

    this.expect(TokenType.LBRACE);
    this.skipNewlines();

    const cases: Array<{ values: Expression[]; body: SceneNode[] }> = [];
    let defaultCase: SceneNode[] | undefined;

    this.scoped(() => {
      while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
        if (this.current().type === TokenType.CASE) {
          this.advance();

          const caseValues: Expression[] = [];
          caseValues.push(this.parseExpression());

          // Multiple values for same case
          while (this.current().type !== TokenType.NEWLINE && this.current().type !== TokenType.LBRACE && this.current().type !== TokenType.EOF) {
            caseValues.push(this.parseExpression());
          }

          this.skipNewlines();

          // Case body can be a block or statements until next case
          let caseBody: SceneNode[];
          if (this.current().type === TokenType.LBRACE) {
            caseBody = this.parseBlock();
          } else {
            caseBody = [];
            while (
              this.current().type !== TokenType.CASE &&
              this.current().type !== TokenType.ELSE &&
              this.current().type !== TokenType.RBRACE &&
              this.current().type !== TokenType.EOF
            ) {
              const node = this.parseNode();
              if (node) caseBody.push(node);
              this.skipNewlines();
            }
          }

          cases.push({ values: caseValues, body: caseBody });
        } else if (this.current().type === TokenType.ELSE) {
          this.advance();
          this.skipNewlines();

          if (this.current().type === TokenType.LBRACE) {
            defaultCase = this.parseBlock();
          } else {
            defaultCase = [];
            while (this.current().type !== TokenType.CASE && this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
              const node = this.parseNode();
              if (node) defaultCase.push(node);
              this.skipNewlines();
            }
          }
        } else {
          this.skipNewlines();
          if (this.current().type !== TokenType.CASE && this.current().type !== TokenType.ELSE && this.current().type !== TokenType.RBRACE) {
            this.advance(); // skip unexpected token
          }
        }

        this.skipNewlines();
      }
    });

    this.expect(TokenType.RBRACE);

    return {
      type: "switch",
      value,
      cases,
      ...(defaultCase === undefined ? {} : { defaultCase }),
    };
  }

  private parseDefine(): DefineNode {
    this.advance(); // consume 'define'

    const nameToken = this.expectIdentifier();
    const name = nameToken.value as string;

    // `define name(a b) { … }` — a function with a return value
    if (this.current().type === TokenType.LPAREN && !this.current().precedingWhitespace) {
      return this.parseFunctionDefine(name);
    }

    // Check if this is a custom shape definition with a block
    if (this.current().type === TokenType.LBRACE) {
      // This is a custom shape definition
      this.blocks.add(name);
      this.callable.delete(name);
      this.advance(); // consume '{'

      const options: OptionNode[] = [];
      const body: SceneNode[] = [];

      this.scoped(() => {
        while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
          // Each `option` / body statement sits on its own line, and NEWLINE
          // tokens now survive to the parser (they carry the case boundaries the
          // switch form needs), so consume them here rather than handing one to
          // `parseNode()`.
          this.skipNewlines();
          if (this.current().type === TokenType.RBRACE || this.current().type === TokenType.EOF) break;
          // Check for option declarations
          if (this.current().type === TokenType.OPTION) {
            this.advance(); // consume 'option'

            const optionName = this.expectIdentifier().value as string;
            const defaultValue = this.parseVectorOrExpression();
            // An option is a symbol in the body, shadowing a function of that name.
            this.callable.delete(optionName);

            options.push({
              type: "option",
              name: optionName,
              defaultValue,
            });
          } else {
            // Parse regular scene nodes
            const node = this.parseNode();
            if (node) {
              body.push(node);
            }
          }
        }
      });

      this.expect(TokenType.RBRACE);

      return {
        type: "define",
        name,
        options,
        body,
      };
    }

    // Parse the value - could be a single expression or space-separated tuple
    this.refuseShapeValue(
      `\`define ${name} <shape>\` (a shape as a value) is not supported by this renderer — write \`define ${name} { … }\` for a reusable block`,
    );
    const value = this.parseVectorOrExpression();
    this.callable.delete(name);

    return {
      type: "define",
      name,
      value,
    };
  }

  /** Upstream lets a shape be a value (`define s sphere { … }`, a function
   *  returning a mesh); this renderer has no mesh values, so say so by name
   *  instead of failing on the brace that follows. */
  private refuseShapeValue(message: string): void {
    const token = this.current();
    const name = typeof token.value === "string" ? token.value : "";
    const unsupported = token.type === TokenType.IDENTIFIER ? unsupportedMessage(name) : undefined;
    if (unsupported !== undefined) throw new ParseError(unsupported, token.line, token.column);
    if (SHAPE_VALUE_TOKENS.has(token.type)) throw new ParseError(message, token.line, token.column);
  }

  /** The body may hold `define`s and must end in the expression it returns.
   *  Upstream also allows shapes there (a function returning a mesh); this
   *  renderer has no mesh values, so that form is refused by name. */
  private parseFunctionDefine(name: string): DefineNode {
    this.expect(TokenType.LPAREN);
    const params: string[] = [];
    while (this.current().type !== TokenType.RPAREN) {
      const token = this.current();
      if (typeof token.value !== "string" || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(token.value)) {
        throw new ParseError("Expected a parameter name", token.line, token.column);
      }
      params.push(token.value);
      this.advance();
    }
    this.expect(TokenType.RPAREN);
    // Registered before the body so a function may call itself.
    this.callable.add(name);
    this.expect(TokenType.LBRACE);
    const { body, value } = this.scoped(() => {
      for (const param of params) this.callable.delete(param);
      this.skipNewlines();
      const defines: DefineNode[] = [];
      while (this.current().type === TokenType.DEFINE) {
        defines.push(this.parseDefine());
        this.skipNewlines();
      }
      const token = this.current();
      if (token.type === TokenType.RBRACE) throw new ParseError(`Function \`${name}\` must end with the expression it returns`, token.line, token.column);
      this.refuseShapeValue(
        `Function \`${name}\` builds a shape — functions here may only compute values (numbers, tuples, strings); use \`define ${name} { … }\` with options for a reusable shape`,
      );
      const result = this.parseVectorOrExpression();
      this.skipNewlines();
      return { body: defines, value: result };
    });
    this.expect(TokenType.RBRACE);
    return { type: "define", name, params, body, value };
  }

  private parseDetail(): DetailNode {
    this.advance(); // consume 'detail'

    const value = this.parseExpression();

    return {
      type: "detail",
      value,
    };
  }

  private parseSeed(): SeedNode {
    this.advance(); // consume 'seed'
    return { type: "seed", value: this.parseExpression() };
  }

  private parseBackground(): BackgroundNode {
    this.advance(); // consume 'background'
    return { type: "background", value: this.parseVectorOrExpression() };
  }

  /** `opacity` / `metallicity` / `roughness` / `glow` / `texture` / `material`
   *  as a scoped command. */
  private parseMaterialCommand(): MaterialNode {
    const token = this.advance();
    const property = String(token.value).toLowerCase() as MaterialNode["property"];
    return { type: "material", property, value: this.parseVectorOrExpression() };
  }

  /** `camera { … }` / `light { … }`: the block is consumed and dropped. */
  private skipIgnoredBlock(command: string): SceneNode {
    this.advance();
    if (this.current().type === TokenType.LBRACE) {
      let depth = 0;
      do {
        const token = this.advance();
        if (token.type === TokenType.LBRACE) depth++;
        else if (token.type === TokenType.RBRACE) depth--;
        else if (token.type === TokenType.EOF) throw new ParseError(`Unterminated \`${command}\` block`, token.line, token.column);
      } while (depth > 0);
    }
    return { type: "ignored", command };
  }

  private parseGroup(): GroupNode {
    this.advance(); // consume 'group'
    this.expect(TokenType.LBRACE);
    const children = this.parseBlockContents();
    this.expect(TokenType.RBRACE);
    return {
      type: "group",
      children,
    };
  }

  private parseBuilder(builderType: "extrude" | "loft" | "lathe" | "fill" | "hull"): ExtrudeNode | LoftNode | LatheNode | FillNode | HullNode {
    this.advance(); // consume builder keyword

    // Use the same path parser for `lathe path { ... }` and nested paths,
    // including definitions, transforms, and loops.
    if (this.current().type === TokenType.PATH) {
      const path = this.parsePath();
      return builderType === "extrude" ? { type: "extrude", path, properties: {} } : { type: builderType, children: [path], properties: {} };
    }
    // `extrude circle`, `fill roundrect { … }`, `extrude cog { teeth 8 }`: one
    // child shape without a wrapping block, as upstream allows.
    if (this.current().type !== TokenType.LBRACE) {
      const child = this.parseNode();
      if (!child) throw new ParseError(`\`${builderType}\` needs a path or shape`, this.current().line, this.current().column);
      return { type: builderType, children: [child], properties: {} };
    }
    this.expect(TokenType.LBRACE);
    this.skipNewlines();
    const properties: ShapeProperties = {};
    const children: SceneNode[] = [];
    this.scoped(() => {
      while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
        const token = this.current();
        if ([TokenType.SIZE, TokenType.COLOR, TokenType.POSITION, TokenType.ROTATION, TokenType.ORIENTATION].includes(token.type)) {
          Object.assign(properties, this.parseProperties());
        } else {
          const node = this.parseNode();
          if (node) children.push(node);
        }
        this.skipNewlines();
      }
    });
    this.expect(TokenType.RBRACE);
    if (builderType === "extrude" && children.length === 1 && children[0]?.type === "path") {
      return { type: "extrude", path: children[0], properties };
    }
    return { type: builderType, children, properties };
  }

  /** Run `parse` with the tuple-value break of `isStartOfNewValue` enabled or
   *  suppressed. Whitespace-separated value lists — property values, path
   *  values, the inside of a `( … )` — read ` -1` as the NEXT value; call
   *  arguments, subscripts and `for … to …` bounds are ordinary arithmetic. */
  private withValueList<T>(enabled: boolean, parse: () => T): T {
    const previous = this.valueList;
    this.valueList = enabled;
    try {
      return parse();
    } finally {
      this.valueList = previous;
    }
  }

  /** Whether the current token can begin another value of a whitespace-separated
   *  list, so `point +1 +0`, `position 1 -2 3` and `(1 2 3)` each read as
   *  several values rather than one arithmetic expression. */
  private startsValue(): boolean {
    const type = this.current().type;
    return (
      type === TokenType.NUMBER ||
      type === TokenType.MINUS ||
      type === TokenType.PLUS ||
      type === TokenType.IDENTIFIER ||
      type === TokenType.LPAREN ||
      type === TokenType.STRING ||
      type === TokenType.HEXCOLOR
    );
  }

  /** As `startsValue`, but `name {` is a custom shape invocation rather than the
   *  next component of the list being read. */
  private startsComponent(): boolean {
    return this.startsValue() && !(this.current().type === TokenType.IDENTIFIER && this.peek().type === TokenType.LBRACE);
  }

  private isStartOfNewValue(): boolean {
    const token = this.current();
    return (token.type === TokenType.MINUS || token.type === TokenType.PLUS) && !!token.precedingWhitespace && !this.peek().precedingWhitespace;
  }

  private parsePathValue(): Expression {
    return this.withValueList(true, () => this.parseExpression());
  }

  private parsePath(): PathNode {
    this.advance(); // consume 'path'
    const properties: ShapeProperties = {};
    const commands = this.parsePathBody("path", properties);
    return Object.keys(properties).length === 0 ? { type: "path", commands } : { type: "path", commands, properties };
  }

  /** `{ … }` of a path or of a `for` inside one. Both accept the same
   *  commands, so one reader serves both instead of two drifting copies.
   *  Only the path itself (not a loop inside it) may carry the transform
   *  options, which land in `properties`. */
  private parsePathBody(where: string, properties?: ShapeProperties): PathCommand[] {
    this.expect(TokenType.LBRACE);
    const commands = this.scoped(() => {
      this.skipNewlines();
      const parsed: PathCommand[] = [];
      while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
        if (properties !== undefined && this.parsePathProperty(properties)) {
          this.skipNewlines();
          continue;
        }
        parsed.push(this.parsePathCommand(where));
        this.skipNewlines();
      }
      return parsed;
    });
    this.expect(TokenType.RBRACE);
    return commands;
  }

  /** `position` / `orientation` (alias `rotation`) / `size` inside a path
   *  block, as upstream allows on any shape. Returns false for anything else. */
  private parsePathProperty(properties: ShapeProperties): boolean {
    const type = this.current().type;
    const key =
      type === TokenType.POSITION
        ? "position"
        : type === TokenType.SIZE
          ? "size"
          : type === TokenType.ORIENTATION || type === TokenType.ROTATION
            ? "orientation"
            : undefined;
    if (key === undefined) return false;
    this.advance();
    properties[key] = this.parseVectorOrExpression();
    return true;
  }

  private parsePathCommand(where: string): PathCommand {
    const token = this.current();
    switch (token.type) {
      case TokenType.DEFINE:
        return this.parseDefine();
      case TokenType.DETAIL: {
        this.advance();
        return { type: "detail", value: this.parseExpression() };
      }
      case TokenType.POINT:
      case TokenType.CURVE:
        return this.parsePathPoint(token.type === TokenType.POINT ? "point" : "curve");
      case TokenType.ARC:
        return this.parseArc();
      case TokenType.ROTATE: {
        this.advance();
        return { type: "rotate", angle: this.parseExpression() };
      }
      case TokenType.TRANSLATE:
      case TokenType.SCALE:
        return this.parsePathVector(token.type === TokenType.TRANSLATE ? "translate" : "scale");
      case TokenType.FOR:
        return this.parsePathFor();
      default:
        throw new ParseError(`Unexpected token in ${where}: ${token.type}`, token.line, token.column);
    }
  }

  /** `point x [y]` / `curve x [y]` — absolute coordinates in the path's local
   *  frame, as upstream. Y defaults to 0. */
  private parsePathPoint(type: "point" | "curve"): PointCommand | CurveCommand {
    this.advance();
    const x = this.parsePathValue();
    const y: Expression = this.startsValue() ? this.parsePathValue() : { type: "number", value: 0 };
    if (this.startsValue()) return { type, x, y, z: this.parsePathValue() };
    return { type, x, y };
  }

  /** `arc` or `arc { angle … position … orientation … size … }` inside a path. */
  private parseArc(): ArcCommand {
    this.advance();
    const arc: ArcCommand = { type: "arc" };
    if (this.current().type !== TokenType.LBRACE) return arc;
    this.expect(TokenType.LBRACE);
    this.skipNewlines();
    while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
      const token = this.current();
      const key = String(token.value).toLowerCase();
      if (key === "angle" && token.type === TokenType.IDENTIFIER) {
        this.advance();
        arc.angle = this.parseExpression();
      } else if (
        token.type === TokenType.POSITION ||
        token.type === TokenType.SIZE ||
        token.type === TokenType.ORIENTATION ||
        token.type === TokenType.ROTATION
      ) {
        this.advance();
        arc[token.type === TokenType.ROTATION ? "orientation" : (key as "position")] = this.parseVectorOrExpression();
      } else {
        throw new ParseError(`Unexpected token in arc: ${token.type}`, token.line, token.column);
      }
      this.skipNewlines();
    }
    this.expect(TokenType.RBRACE);
    return arc;
  }

  /** `translate x [y]` / `scale x [y]` inside a path. A lone `translate x`
   *  moves along X only; a lone `scale s` is uniform, recorded by leaving `y`
   *  out rather than by copying the expression (which would evaluate it twice). */
  private parsePathVector(type: "translate" | "scale"): TranslateCommand | ScaleCommand {
    this.advance();
    const x = this.parsePathValue();
    if (type === "scale") return this.startsValue() ? { type, x, y: this.parsePathValue() } : { type, x };
    const y: Expression = this.startsValue() ? this.parsePathValue() : { type: "number", value: 0 };
    return { type, x, y };
  }

  private parsePathFor(): ForLoopPathCommand {
    this.advance(); // consume 'for'
    const { variable, iterable } = this.parseLoopHeader();
    // The loop is expanded during rendering.
    const commands = this.scoped(() => {
      this.callable.delete(variable);
      return this.parsePathBody("path for loop");
    });
    return { type: "for", variable, iterable, commands };
  }

  private parseNode(): SceneNode | null {
    this.skipNewlines();

    const token = this.current();

    type CSGOperation = "union" | "difference" | "intersection" | "xor" | "stencil";
    type BuilderType = "extrude" | "loft" | "lathe" | "fill" | "hull";
    type TransformType = "color" | "rotate" | "translate" | "scale" | "orientation";

    // Map token types to shape names
    const shapeMap: Record<string, ShapePrimitive> = {
      [TokenType.CUBE]: "cube",
      [TokenType.SPHERE]: "sphere",
      [TokenType.ICOSPHERE]: "icosphere",
      [TokenType.ROUNDRECT]: "roundrect",
      [TokenType.CYLINDER]: "cylinder",
      [TokenType.CONE]: "cone",
      [TokenType.TORUS]: "torus",
      [TokenType.CIRCLE]: "circle",
      [TokenType.SQUARE]: "square",
      [TokenType.POLYGON]: "polygon",
    };

    // Map token types to CSG operations
    const csgMap: Record<string, CSGOperation> = {
      [TokenType.UNION]: "union",
      [TokenType.DIFFERENCE]: "difference",
      [TokenType.INTERSECTION]: "intersection",
      [TokenType.XOR]: "xor",
      [TokenType.STENCIL]: "stencil",
    };

    // Map token types to builder operations
    const builderMap: Record<string, BuilderType> = {
      [TokenType.EXTRUDE]: "extrude",
      [TokenType.LOFT]: "loft",
      [TokenType.LATHE]: "lathe",
      [TokenType.FILL]: "fill",
      [TokenType.HULL]: "hull",
    };

    // Map token types to transform types
    const transformMap: Record<string, TransformType> = {
      [TokenType.COLOR]: "color",
      [TokenType.ROTATE]: "rotate",
      [TokenType.TRANSLATE]: "translate",
      [TokenType.SCALE]: "scale",
      [TokenType.POSITION]: "translate", // position is an alias for translate
      [TokenType.ORIENTATION]: "orientation", // orientation sets absolute rotation (not relative like rotate)
      [TokenType.SIZE]: "scale", // `size` inside a group scales what follows, as the group's own size does upstream
    };

    // A custom block named like a built-in (`define arc { … }`) shadows it,
    // as a `define` does upstream — the script's own `arc { … }` is meant.
    if (typeof token.value === "string" && token.type !== TokenType.IDENTIFIER && this.blocks.has(token.value)) {
      this.advance();
      return this.parseCustomShapeCall(token.value);
    }

    // Check mapped operations first
    const shape = shapeMap[token.type];
    if (shape !== undefined) {
      return this.parseShape(shape);
    }
    const csg = csgMap[token.type];
    if (csg !== undefined) {
      return this.parseCSG(csg);
    }
    const builder = builderMap[token.type];
    if (builder !== undefined) {
      return this.parseBuilder(builder);
    }
    const transform = transformMap[token.type];
    if (transform !== undefined) {
      this.advance();
      return {
        type: transform,
        value: this.parseVectorOrExpression(),
      } as SceneNode;
    }

    switch (token.type) {
      case TokenType.FOR:
        return this.parseForLoop();

      case TokenType.IF:
        return this.parseIf();

      case TokenType.SWITCH:
        return this.parseSwitch();

      case TokenType.DEFINE:
        return this.parseDefine();

      case TokenType.GROUP:
        return this.parseGroup();

      case TokenType.DETAIL:
        return this.parseDetail();

      case TokenType.SEED:
        return this.parseSeed();

      case TokenType.BACKGROUND:
        return this.parseBackground();

      case TokenType.TEXTURE:
      case TokenType.MATERIAL:
      case TokenType.OPACITY:
      case TokenType.METALLICITY:
      case TokenType.ROUGHNESS:
      case TokenType.GLOW:
        return this.parseMaterialCommand();

      case TokenType.SMOOTHING:
        this.advance();
        return { type: "smoothing", value: this.parseExpression() };

      case TokenType.PRINT:
        this.advance();
        return { type: "print", value: this.parseVectorOrExpression() };

      case TokenType.ASSERT:
        this.advance();
        return { type: "assert", value: this.parseExpression() };

      case TokenType.PATH:
        return this.parsePath();

      case TokenType.RBRACE:
      case TokenType.EOF:
        return null;

      case TokenType.IDENTIFIER: {
        // Custom shape invocation (e.g., "cog { teeth 8 }")
        const name = token.value as string;
        if (!this.blocks.has(name)) {
          if (IGNORED_BLOCKS.has(name)) return this.skipIgnoredBlock(name);
          const unsupported = unsupportedMessage(name);
          if (unsupported !== undefined) throw new ParseError(unsupported, token.line, token.column);
        }
        this.advance();
        return this.parseCustomShapeCall(name);
      }

      default:
        throw new ParseError(`Unexpected token: ${token.type}`, token.line, token.column);
    }
  }

  /** `name { option value … }` after the name has been consumed. */
  private parseCustomShapeCall(name: string): SceneNode {
    const properties: Record<string, unknown> = {};

    if (this.current().type === TokenType.LBRACE) {
      this.expect(TokenType.LBRACE);
      this.skipNewlines();

      // Parse option overrides (e.g., "teeth 8")
      while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
        // Check for standard properties first
        if (STANDARD_PROPERTY_TOKENS.has(this.current().type)) {
          const props = this.parseProperties();
          Object.assign(properties, props);
        } else if (this.current().type === TokenType.IDENTIFIER) {
          // Parse custom option (e.g., "teeth 8")
          const optionName = this.current().value as string;
          this.advance();
          const optionValue = this.parseVectorOrExpression();
          properties[optionName] = optionValue;
        } else {
          break;
        }

        this.skipNewlines();
      }

      this.expect(TokenType.RBRACE);
    }

    return {
      type: "customShape",
      name,
      properties,
    };
  }

  // `parseNode()` answers `null` at a `}` so that a BLOCK's loop stops there and the
  // block itself consumes the brace. At the TOP level there is no block to close: if
  // nothing consumed the token, `this.pos` has not moved and `parse()` would spin on
  // that same `}` forever. That is not one hung request — the parse is synchronous, so
  // it pins the whole host process (one stray trailing `}` in an agent-written model
  // stopped MulmoTerminal's server from answering anything at all). An unmatched brace
  // is a parse error; report it as one, at its own line and column.
  private refuseStalledToken(posBefore: number): void {
    if (this.pos !== posBefore) return;
    const token = this.current();
    throw new ParseError(`Unexpected token: ${token.type}`, token.line, token.column);
  }

  parse(): SceneNode[] {
    const nodes: SceneNode[] = [];

    while (this.current().type !== TokenType.EOF) {
      const posBefore = this.pos;
      const node = this.parseNode();
      if (node) {
        nodes.push(node);
      }
      this.skipNewlines();
      if (node === null) this.refuseStalledToken(posBefore);
    }

    return nodes;
  }
}

// Main export function
export function parseShapeScript(script: string): SceneNode[] {
  try {
    const lexer = new Lexer(script);
    const tokens = lexer.tokenize();

    // Newlines are NOT filtered out. The parser is written to consume them —
    // 27 `skipNewlines()` calls, and `parseSwitch` stops collecting a case's
    // values at the line boundary — so stripping them first (as this used to,
    // "for simpler parsing") made the unbraced `switch` form the tool
    // definition advertises unparseable: the body and every later `case` were
    // swallowed as values until `Expected RBRACE but got EOF`.
    const parser = new Parser(tokens);
    return parser.parse();
  } catch (error) {
    if (error instanceof ParseError) {
      throw error;
    }
    throw new ParseError(error instanceof Error ? error.message : "Unknown parse error");
  }
}
