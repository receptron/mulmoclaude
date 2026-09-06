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
  TextureNode,
  PathNode,
  PathCommand,
  Expression,
  ParseError,
  GroupNode,
  LoftNode,
  LatheNode,
  FillNode,
  HullNode,
  ShapeProperties,
} from "./types";

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
      } else {
        break;
      }
    }
  }

  private readNumber(): Token {
    const line = this.line;
    const column = this.column;
    let numStr = "";

    // Handle negative numbers (but be careful about subtraction)
    if (this.peek() === "-") {
      numStr += this.advance();
    }

    while (this.pos < this.input.length) {
      const char = this.peek();
      if ((char >= "0" && char <= "9") || char === ".") {
        numStr += this.advance();
      } else {
        break;
      }
    }

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
      detail: TokenType.DETAIL,
      background: TokenType.BACKGROUND,
      texture: TokenType.TEXTURE,
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

// Parser
export class Parser {
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

    return left;
  }

  private parsePrimary(): Expression {
    const token = this.current();

    // Unary operators
    if (token.type === TokenType.MINUS || token.type === TokenType.NOT) {
      this.advance();
      return {
        type: "unary",
        operator: token.type === TokenType.MINUS ? "-" : "not",
        operand: this.parsePrimary(),
      };
    }

    // Parenthesized expression or tuple
    if (token.type === TokenType.LPAREN) {
      this.advance();
      const elements: Expression[] = [];
      elements.push(this.parseExpression());

      // Check if it's a comma-separated tuple
      if (this.current().type === TokenType.COMMA) {
        while (this.current().type === TokenType.COMMA) {
          this.advance();
          if (this.current().type === TokenType.RPAREN) break;
          elements.push(this.parseExpression());
        }
      }
      // Check if it's a space-separated tuple (e.g., "(1 2 3)")
      else {
        const nextToken = this.current();
        const canBeVectorComponent =
          nextToken.type === TokenType.NUMBER ||
          nextToken.type === TokenType.IDENTIFIER ||
          nextToken.type === TokenType.MINUS ||
          nextToken.type === TokenType.LPAREN;

        if (canBeVectorComponent && nextToken.type !== TokenType.RPAREN) {
          // Parse space-separated values
          while (true) {
            const currentToken = this.current();
            if (
              currentToken.type === TokenType.NUMBER ||
              currentToken.type === TokenType.IDENTIFIER ||
              currentToken.type === TokenType.MINUS ||
              currentToken.type === TokenType.LPAREN
            ) {
              elements.push(this.parseExpression());
            } else {
              break;
            }
          }
        }
      }

      this.expect(TokenType.RPAREN);

      if (elements.length === 1 && elements[0] !== undefined) {
        return elements[0]; // Single parenthesized expression
      } else {
        return { type: "tuple", elements }; // Tuple
      }
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
        type: "identifier", // Treat strings as special identifiers for now
        name: token.value as string,
      };
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

        if (this.current().type !== TokenType.RPAREN) {
          args.push(this.parseExpression());

          while (this.current().type === TokenType.COMMA) {
            this.advance();
            if (this.current().type === TokenType.RPAREN) break;
            args.push(this.parseExpression());
          }
        }

        this.expect(TokenType.RPAREN);

        return {
          type: "call",
          name,
          args,
        };
      }

      // Simple identifier
      return {
        type: "identifier",
        name,
      };
    }

    // Allow keywords to be used as identifiers in expressions
    // (e.g., "define step 5" then "rotate step")
    if (typeof token.value === "string") {
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
    const first = this.parseExpression();

    // Check if there are more expressions following (space-separated values)
    // Look ahead to see if next token could be part of a vector
    const nextToken = this.current();

    // Don't consume identifiers followed by LBRACE - they're custom shape invocations
    const isCustomShapeInvocation = nextToken.type === TokenType.IDENTIFIER && this.peek().type === TokenType.LBRACE;

    const canBeVectorComponent =
      (nextToken.type === TokenType.NUMBER ||
        nextToken.type === TokenType.IDENTIFIER ||
        nextToken.type === TokenType.MINUS ||
        nextToken.type === TokenType.LPAREN) &&
      !isCustomShapeInvocation;

    if (canBeVectorComponent && nextToken.type !== TokenType.COMMA) {
      // Parse space-separated values: x y z (or any number of values)
      const elements: Expression[] = [first];

      // Keep parsing as long as we see valid tuple component tokens
      while (true) {
        const currentToken = this.current();

        // Check again for custom shape invocation
        const isCustomShape = currentToken.type === TokenType.IDENTIFIER && this.peek().type === TokenType.LBRACE;

        if (
          (currentToken.type === TokenType.NUMBER ||
            currentToken.type === TokenType.IDENTIFIER ||
            currentToken.type === TokenType.MINUS ||
            currentToken.type === TokenType.LPAREN) &&
          !isCustomShape
        ) {
          elements.push(this.parseExpression());
        } else {
          break;
        }
      }

      if (elements.length > 1) {
        return { type: "tuple", elements };
      }
    }

    // If it's already a tuple, return it
    if (first.type === "tuple") {
      return first;
    }

    // Single expression
    return first;
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

        case TokenType.RBRACE:
          // End of properties block
          return properties;

        default:
          // Not a property token - stop parsing properties and return
          return properties;
      }

      this.skipNewlines();
    }

    return properties;
  }

  private parseBlockContents(): SceneNode[] {
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
  }

  private parseBlock(): SceneNode[] {
    this.expect(TokenType.LBRACE);
    const nodes = this.parseBlockContents();
    this.expect(TokenType.RBRACE);
    return nodes;
  }

  private parseShape(primitive: "cube" | "sphere" | "cylinder" | "cone" | "torus" | "circle" | "square" | "polygon"): ShapeNode {
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

  private parseForLoop(): ForLoopNode {
    this.advance(); // consume 'for'

    let variable = "i";

    // Parse: for <identifier> in <expr> to <expr>
    // or: for <identifier> in <expr>
    if (this.current().type === TokenType.IDENTIFIER) {
      variable = this.current().value as string;
      this.advance();
    }

    // Check for 'in' keyword
    if (this.current().type === TokenType.IN) {
      this.advance();

      const fromExpr = this.parseExpression();

      // Check if there's a 'to' keyword (range) or not (values)
      if (this.current().type === TokenType.TO) {
        this.advance();
        const toExpr = this.parseExpression();

        // Optional step
        let stepExpr: Expression | undefined;
        if (this.current().type === TokenType.STEP) {
          this.advance();
          stepExpr = this.parseExpression();
        }

        const body = this.parseBlock();

        return {
          type: "for",
          variable,
          from: fromExpr,
          to: toExpr,
          ...(stepExpr === undefined ? {} : { step: stepExpr }),
          body,
        };
      } else {
        // for i in values
        const body = this.parseBlock();

        return {
          type: "for",
          variable,
          from: { type: "number", value: 0 },
          to: { type: "number", value: 0 },
          iterableValues: fromExpr,
          body,
        };
      }
    }

    // Old syntax: for <from>? to <to>
    let fromExpr: Expression = { type: "number", value: 1 };
    if (this.current().type === TokenType.NUMBER) {
      fromExpr = this.parseExpression();
    }

    this.expect(TokenType.TO);
    const toExpr = this.parseExpression();

    const body = this.parseBlock();

    return {
      type: "for",
      variable,
      from: fromExpr,
      to: toExpr,
      body,
    };
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

    // Check if this is a custom shape definition with a block
    if (this.current().type === TokenType.LBRACE) {
      // This is a custom shape definition
      this.advance(); // consume '{'

      const options: OptionNode[] = [];
      const body: SceneNode[] = [];

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

      this.expect(TokenType.RBRACE);

      return {
        type: "define",
        name,
        options,
        body,
      };
    }

    // Parse the value - could be a single expression or space-separated tuple
    const value = this.parseVectorOrExpression();

    return {
      type: "define",
      name,
      value,
    };
  }

  private parseDetail(): DetailNode {
    this.advance(); // consume 'detail'

    const value = this.parseExpression();

    return {
      type: "detail",
      value,
    };
  }

  private parseBackground(): BackgroundNode {
    this.advance(); // consume 'background'

    const value = this.parseExpression();

    return {
      type: "background",
      value,
    };
  }

  private parseTexture(): TextureNode {
    this.advance(); // consume 'texture'

    const value = this.parseExpression();

    return {
      type: "texture",
      value,
    };
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

    // Check for optional "path" keyword (e.g., "lathe path { ... }")
    let hasInlinePath = false;
    if (this.current().type === TokenType.PATH) {
      hasInlinePath = true;
      this.advance(); // consume "path"
    }

    // Parse properties and child nodes in the block
    this.expect(TokenType.LBRACE);
    this.skipNewlines();

    const properties: ShapeProperties = {};
    let path: PathNode | undefined;
    const children: SceneNode[] = [];

    // If we have inline path syntax (e.g., "lathe path { ... }"),
    // parse the content as path commands directly
    if (hasInlinePath) {
      const commands: PathCommand[] = [];

      while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
        const token = this.current();

        if (token.type === TokenType.POINT) {
          this.advance();
          const x = this.parsePathValue();
          // Y is optional - defaults to 0 if not provided
          let y: Expression = { type: "number", value: 0 };
          if (
            this.current().type === TokenType.NUMBER ||
            this.current().type === TokenType.MINUS ||
            this.current().type === TokenType.IDENTIFIER ||
            this.current().type === TokenType.LPAREN
          ) {
            y = this.parsePathValue();
          }
          commands.push({ type: "point", x, y });
        } else if (token.type === TokenType.CURVE) {
          this.advance();
          const x = this.parsePathValue();
          const y = this.parsePathValue();
          // Optional control points
          let controlX: Expression | undefined;
          let controlY: Expression | undefined;

          if (
            this.current().type === TokenType.NUMBER ||
            this.current().type === TokenType.MINUS ||
            this.current().type === TokenType.IDENTIFIER ||
            this.current().type === TokenType.LPAREN
          ) {
            controlX = this.parsePathValue();

            // Try to parse fourth value (control point y)
            if (
              this.current().type === TokenType.NUMBER ||
              this.current().type === TokenType.MINUS ||
              this.current().type === TokenType.IDENTIFIER ||
              this.current().type === TokenType.LPAREN
            ) {
              controlY = this.parsePathValue();
            }
          }
          commands.push({
            type: "curve",
            x,
            y,
            ...(controlX === undefined ? {} : { controlX }),
            ...(controlY === undefined ? {} : { controlY }),
          });
        } else {
          break;
        }

        this.skipNewlines();
      }

      path = {
        type: "path",
        commands,
      };
    } else {
      // Normal builder parsing
      while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
        const token = this.current();

        // Check for path definition (for extrude)
        if (token.type === TokenType.PATH && builderType === "extrude") {
          path = this.parsePath();
          this.skipNewlines();
          continue;
        }

        // Check for properties
        if (
          token.type === TokenType.SIZE ||
          token.type === TokenType.COLOR ||
          token.type === TokenType.OPACITY ||
          token.type === TokenType.POSITION ||
          token.type === TokenType.ROTATION ||
          token.type === TokenType.ORIENTATION
        ) {
          const props = this.parseProperties();
          Object.assign(properties, props);
          this.skipNewlines();
          continue;
        }

        // Otherwise, parse as child node
        const node = this.parseNode();
        if (node) {
          children.push(node);
        }
        this.skipNewlines();
      }
    }

    this.expect(TokenType.RBRACE);

    if (builderType === "extrude") {
      return {
        type: "extrude",
        ...(path === undefined ? {} : { path }),
        properties,
        ...(children.length > 0 ? { children } : {}),
      };
    } else {
      // For non-extrude builders, if there's an inline path, add it to children
      if (path) {
        children.unshift(path); // Add path as first child
      }
      return {
        type: builderType,
        properties,
        children,
      };
    }
  }

  private parsePathValue(): Expression {
    // Parse a single value for path commands
    // Operators bind regardless of whitespace (e.g., "1 / 5" is one value)
    // Space-separated non-operators are separate values (e.g., "0 radius 2" is three values)
    let left = this.parsePathPrimary();

    // Continue parsing operators to build up the expression
    while (true) {
      const token = this.current();

      // Check for binary operators
      if (
        token.type === TokenType.STAR ||
        token.type === TokenType.DIVIDE ||
        token.type === TokenType.PERCENT ||
        token.type === TokenType.PLUS ||
        (token.type === TokenType.MINUS && !this.isStartOfNewValue())
      ) {
        const operator = this.tokenTypeToOperator(token.type);
        if (!operator) break;
        this.advance();
        const right = this.parsePathPrimary();
        left = {
          type: "binary",
          operator,
          left,
          right,
        };
      } else {
        break;
      }
    }

    return left;
  }

  private isStartOfNewValue(): boolean {
    // Check if current MINUS token starts a new negative number value
    // vs being a subtraction operator
    const token = this.current();
    if (token.type !== TokenType.MINUS) return false;

    // If there's preceding whitespace and next is a number, it's likely a new value
    return (
      !!token.precedingWhitespace &&
      (this.peek().type === TokenType.NUMBER || this.peek().type === TokenType.IDENTIFIER || this.peek().type === TokenType.LPAREN)
    );
  }

  private parsePathPrimary(): Expression {
    const token = this.current();

    // Handle parenthesized expressions - these can contain full expressions with spaces
    if (token.type === TokenType.LPAREN) {
      this.advance();
      const expr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return expr;
    }

    // Handle unary minus (negative numbers)
    if (token.type === TokenType.MINUS) {
      this.advance();
      return {
        type: "unary",
        operator: "-",
        operand: this.parsePathPrimary(),
      };
    }

    // Handle numbers
    if (token.type === TokenType.NUMBER) {
      const value = token.value as number;
      this.advance();
      return {
        type: "number",
        value,
      };
    }

    // Handle identifiers (variables) and function calls
    if (token.type === TokenType.IDENTIFIER) {
      const name = token.value as string;
      this.advance();

      // Function call: only if '(' immediately follows with NO space
      if (this.current().type === TokenType.LPAREN && !this.current().precedingWhitespace) {
        this.advance();
        const args: Expression[] = [];

        if (this.current().type !== TokenType.RPAREN) {
          args.push(this.parseExpression());
          while (this.current().type === TokenType.COMMA) {
            this.advance();
            args.push(this.parseExpression());
          }
        }

        this.expect(TokenType.RPAREN);

        return {
          type: "call",
          name,
          args,
        };
      }

      // Simple identifier
      return {
        type: "identifier",
        name,
      };
    }

    throw new ParseError(`Expected path value, got ${token.type}`, token.line, token.column);
  }

  private parsePath(): PathNode {
    this.advance(); // consume 'path'

    this.expect(TokenType.LBRACE);
    this.skipNewlines();

    const commands: PathCommand[] = [];

    while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
      const token = this.current();

      switch (token.type) {
        case TokenType.DEFINE: {
          // Handle define statements inside path blocks
          // These don't produce path commands, just variable definitions
          this.parseDefine();
          break;
        }

        case TokenType.DETAIL: {
          this.advance();
          const value = this.parseExpression();
          commands.push({ type: "detail", value });
          break;
        }

        case TokenType.POINT: {
          this.advance();
          const x = this.parsePathValue();
          // Y is optional - defaults to 0 if not provided
          let y: Expression = { type: "number", value: 0 };
          if (
            this.current().type === TokenType.NUMBER ||
            this.current().type === TokenType.MINUS ||
            this.current().type === TokenType.IDENTIFIER ||
            this.current().type === TokenType.LPAREN
          ) {
            y = this.parsePathValue();
          }
          commands.push({ type: "point", x, y });
          break;
        }

        case TokenType.CURVE: {
          this.advance();
          const x = this.parsePathValue();
          const y = this.parsePathValue();
          // Optional control points
          let controlX: Expression | undefined;
          let controlY: Expression | undefined;

          // Check if there's a potential third value (control point x)
          if (
            this.current().type === TokenType.NUMBER ||
            this.current().type === TokenType.MINUS ||
            this.current().type === TokenType.IDENTIFIER ||
            this.current().type === TokenType.LPAREN
          ) {
            controlX = this.parsePathValue();

            // Try to parse fourth value (control point y)
            if (
              this.current().type === TokenType.NUMBER ||
              this.current().type === TokenType.MINUS ||
              this.current().type === TokenType.IDENTIFIER ||
              this.current().type === TokenType.LPAREN
            ) {
              controlY = this.parsePathValue();
            }
          }

          commands.push({
            type: "curve",
            x,
            y,
            ...(controlX === undefined ? {} : { controlX }),
            ...(controlY === undefined ? {} : { controlY }),
          });
          break;
        }

        case TokenType.ROTATE: {
          this.advance();
          const angle = this.parseExpression();
          commands.push({ type: "rotate", angle });
          break;
        }

        case TokenType.TRANSLATE: {
          this.advance();
          const x = this.parsePathValue();
          const y = this.parsePathValue();
          commands.push({ type: "translate", x, y });
          break;
        }

        case TokenType.FOR: {
          // Handle for loops inside path - expand them inline
          this.advance(); // consume 'for'

          // Check if there's a variable name (for i in 1 to 5) or direct range (for 1 to 5)
          let variable = "_i"; // Default variable name
          if (this.current().type === TokenType.IDENTIFIER && this.peek(1).type === TokenType.IN) {
            variable = this.current().value as string;
            this.advance(); // consume variable
            this.expect(TokenType.IN); // consume 'in'
          }

          const from = this.parseExpression();
          this.expect(TokenType.TO);
          const to = this.parseExpression();

          const step = this.current().type === TokenType.STEP ? (this.advance(), this.parseExpression()) : { type: "number" as const, value: 1 };

          // Parse the body commands
          this.expect(TokenType.LBRACE);
          this.skipNewlines();

          const bodyCommands: PathCommand[] = [];
          while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
            const cmd = this.current();
            switch (cmd.type) {
              case TokenType.POINT: {
                this.advance();
                const x = this.parsePathValue();
                // Y is optional - defaults to 0 if not provided
                let y: Expression = { type: "number", value: 0 };
                if (
                  this.current().type === TokenType.NUMBER ||
                  this.current().type === TokenType.MINUS ||
                  this.current().type === TokenType.IDENTIFIER ||
                  this.current().type === TokenType.LPAREN
                ) {
                  y = this.parsePathValue();
                }
                bodyCommands.push({ type: "point", x, y });
                break;
              }
              case TokenType.CURVE: {
                this.advance();
                const x = this.parsePathValue();
                const y = this.parsePathValue();
                // Optional control points
                let controlX: Expression | undefined;
                let controlY: Expression | undefined;

                // Check if there's a potential third value (control point x)
                if (
                  this.current().type === TokenType.NUMBER ||
                  this.current().type === TokenType.MINUS ||
                  this.current().type === TokenType.IDENTIFIER ||
                  this.current().type === TokenType.LPAREN
                ) {
                  controlX = this.parsePathValue();

                  // Try to parse fourth value (control point y)
                  if (
                    this.current().type === TokenType.NUMBER ||
                    this.current().type === TokenType.MINUS ||
                    this.current().type === TokenType.IDENTIFIER ||
                    this.current().type === TokenType.LPAREN
                  ) {
                    controlY = this.parsePathValue();
                  }
                }

                bodyCommands.push({
                  type: "curve",
                  x,
                  y,
                  ...(controlX === undefined ? {} : { controlX }),
                  ...(controlY === undefined ? {} : { controlY }),
                });
                break;
              }
              case TokenType.ROTATE: {
                this.advance();
                const angle = this.parseExpression();
                bodyCommands.push({ type: "rotate", angle });
                break;
              }
              case TokenType.TRANSLATE: {
                this.advance();
                const x = this.parsePathValue();
                const y = this.parsePathValue();
                bodyCommands.push({ type: "translate", x, y });
                break;
              }
              default:
                throw new ParseError(`Unexpected token in path for loop: ${cmd.type}`, cmd.line, cmd.column);
            }
            this.skipNewlines();
          }

          this.expect(TokenType.RBRACE);

          // Add the for loop command - it will be expanded during rendering
          commands.push({
            type: "for",
            variable,
            from,
            to,
            step,
            commands: bodyCommands,
          });
          break;
        }

        default:
          throw new ParseError(`Unexpected token in path: ${token.type}`, token.line, token.column);
      }

      this.skipNewlines();
    }

    this.expect(TokenType.RBRACE);

    return {
      type: "path",
      commands,
    };
  }

  private parseNode(): SceneNode | null {
    this.skipNewlines();

    const token = this.current();

    type ShapePrimitive = "cube" | "sphere" | "cylinder" | "cone" | "torus" | "circle" | "square" | "polygon";
    type CSGOperation = "union" | "difference" | "intersection" | "xor" | "stencil";
    type BuilderType = "extrude" | "loft" | "lathe" | "fill" | "hull";
    type TransformType = "color" | "rotate" | "translate" | "scale" | "orientation";

    // Map token types to shape names
    const shapeMap: Record<string, ShapePrimitive> = {
      [TokenType.CUBE]: "cube",
      [TokenType.SPHERE]: "sphere",
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
    };

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

      case TokenType.BACKGROUND:
        return this.parseBackground();

      case TokenType.TEXTURE:
        return this.parseTexture();

      case TokenType.PATH:
        return this.parsePath();

      case TokenType.RBRACE:
      case TokenType.EOF:
        return null;

      case TokenType.IDENTIFIER: {
        // Custom shape invocation (e.g., "cog { teeth 8 }")
        const name = token.value as string;
        this.advance();

        const properties: Record<string, unknown> = {};

        if (this.current().type === TokenType.LBRACE) {
          this.expect(TokenType.LBRACE);
          this.skipNewlines();

          // Parse option overrides (e.g., "teeth 8")
          while (this.current().type !== TokenType.RBRACE && this.current().type !== TokenType.EOF) {
            // Check for standard properties first
            if (
              this.current().type === TokenType.POSITION ||
              this.current().type === TokenType.ROTATION ||
              this.current().type === TokenType.SIZE ||
              this.current().type === TokenType.COLOR ||
              this.current().type === TokenType.OPACITY
            ) {
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

      default:
        throw new ParseError(`Unexpected token: ${token.type}`, token.line, token.column);
    }
  }

  parse(): SceneNode[] {
    const nodes: SceneNode[] = [];

    while (this.current().type !== TokenType.EOF) {
      const node = this.parseNode();
      if (node) {
        nodes.push(node);
      }
      this.skipNewlines();
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
