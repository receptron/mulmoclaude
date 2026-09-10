export const TOOL_NAME = "presentShapeScript";

export const TOOL_DEFINITION = {
  type: "function" as const,
  name: TOOL_NAME,
  description:
    "Display interactive 3D visualizations using ShapeScript with expressions, variables, control flow, and functions. A new `script` is saved to `artifacts/shapes/` and the returned `filePath` names it; pass `path` instead to present a source that already exists.",
  parameters: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "Title for the 3D visualization",
      },
      script: {
        type: "string",
        description: `ShapeScript code defining the 3D scene. Supported features and syntax are listed below. Syntax, evaluation, geometry and resource-limit errors are returned as diagnostics; correct the script and retry.

## SYNTAX OVERVIEW:

### Expressions & Operators:
- Arithmetic: +, -, *, /, % with proper precedence
- Comparison: =, <>, <, <=, >, >=
- Boolean: and, or, not
- Parentheses for grouping: (2 + 3) * 4

### Variables:
define radius 2
define red (1 0 0)
sphere { size radius color red }

### Control Flow:

For loops with variables:
for i in 1 to 5 {
    cube { position (i * 2) 0 0 size 1 }
}

For loops with step:
for i in 0 to 10 step 2 {
    sphere { position 0 i 0 }
}

If/else conditionals:
define showSphere 1
if showSphere {
    sphere { size 2 }
} else {
    cube { size 2 }
}

Switch statements:
define shape 2
switch shape {
case 1
    cube
case 2
    sphere
else
    cone
}

### Built-in Functions:

Math: round, floor, ceil, abs, sign, sqrt, pow, min, max
Trig: sin, cos, tan, asin, acos, atan, atan2 (uses radians)
Vector: dot, cross, length, normalize, sum

IMPORTANT: Function calls require NO space between name and parenthesis:
- sin(x) ✓ function call
- sin (x) ✗ NOT a function call (identifier + parenthesized expression)
Separate arguments with spaces, as upstream does: max(0 (j - 1)), pow(2.718 (0 - x)). Commas also work
here (max(0, j - 1)) but NOT in the upstream ShapeScript app, so prefer spaces. Bare max 0 1 without
parentheses is not supported.
Write ONE statement per line. This parser accepts "define a 1 define b 2" on one line; the upstream app
rejects it, and a script that keeps to one statement per line opens in both.

Examples:
for i in 1 to 8 {
    define angle (i * 0.785)  // 45 degrees in radians
    cube { position (cos(angle) * 3) 0 (sin(angle) * 3) }
}

### Primitives & Properties:

Shapes: cube, sphere, cylinder, cone, torus, circle, square, polygon (sides 3–256)
Properties: position X Y Z, orientation ROLL YAW PITCH (alias: rotation), size X Y Z
Materials: color R G B (0-1), opacity (0-1)

UNITS (same as upstream ShapeScript — https://shapescript.info/mac/):
- size is the DIAMETER of sphere/cylinder/cone/circle/polygon/torus (a bare sphere fits the unit cube); for cube/square it is the edge length.
- orientation / rotate use HALF-TURNS in roll (Z), yaw (Y), pitch (X) order: 0.5 = 90°, 1 = 180°. Positive is clockwise. A lone value is a roll: orientation 0.25 = 45° about Z. Angle-axis also works: orientation 0.5 0 1 0.
- rotate / translate / scale as commands are relative and accumulate; orientation as a command is absolute.
- Trig FUNCTIONS (sin, cos, …) still take radians. Convert with pi: a half-turn value h is h * pi radians.

### CSG Operations:
union, difference, intersection, xor, stencil

Example:
difference {
    sphere { size 2 color (1 0.5 0) }
    cube { size 1.5 }
}

### Paths:
path { point X Y … } — coordinates are ABSOLUTE in the path's frame. Close a path by repeating the first point.
- curve X Y is a quadratic Bézier CONTROL point: the outline passes through the point commands on either side, not through it. Two curves in a row get an implicit on-curve midpoint, so eight curves in an octagon draw a circle.
- rotate (half-turns) / translate / scale inside a path move the frame for later points:
  path { for 0 to 8 { curve 0 1 rotate 1 / 8 } }  // semicircle

### Builders:
- extrude: extrude { polygon { sides 3 } } or extrude path { point 0 0 point 1 0 point 0 1 point 0 0 } (size Z = depth, default 1)
- fill: fill { square } or fill path { ... }
- lathe: lathe path { point 0 0 point 1 0 curve 1.5 1 point 1 2 point 0 2 } (revolves the XY profile about Y)
- loft: loft { square translate 0 0 2 circle } (closed planar sections joined with caps)
- hull: hull { cube { position -1 0 0 } cube { position 1 0 0 } } (convex envelope)
- stencil preserves the first shape and paints its surface with later shapes' materials.
Loft sections must each have one perimeter and enclose an area; extrude/fill primitive profiles must lie in XY.

### Additional Expressions:
- Constants: pi, tau, true, false
- Scientific notation and unary plus: 1e-3, +2
- Tuple/vector members: vector.x, vector.y, vector.z; color.red/green/blue/alpha
- Tuple/string length: value.count; zero-based indexing: values[0]; ordinals: v.first v.second … v.last, v.allButFirst, v.allButLast
- String literals, join(...), trim(...); min/max also accept tuples
- Custom shapes with options:
define post { option height 2 cylinder { size 0.2 height } }
post { height 3 }
- Random numbers: rnd (0–1) and seed N (scoped to the enclosing block, same generator as upstream)

### Compatibility:
This plugin implements the documented modeling subset, not all upstream ShapeScript syntax; units and
path semantics follow upstream, so a script written against the upstream docs renders the same here.
Function calls use name(...). Imports, textures, text/fonts, lights/cameras, arbitrary objects,
hex/named colours, and general user-defined functions are not supported.

### Comments:
// Single-line comment
/* Multi-line
   comment */

## COMPLETE EXAMPLES:

Linear arrangement with expressions:
define spacing 1.5
for i in 1 to 4 {
    cylinder { position ((i - 2.5) * spacing) 0 0 size 0.4 1 }
}

Circular pattern:
define count 12
for i in 1 to count {
    define angle ((i / count) * 6.283)  // 2 * PI
    cube {
        position (cos(angle) * 3) 0 (sin(angle) * 3)
        color (i / count) 0.5 (1 - i / count)
        size 0.5
    }
}

Conditional geometry:
define makeHollow 1
if makeHollow {
    difference {
        sphere { size 2 color (1 0 0) }
        sphere { size 1.7 }
    }
} else {
    sphere { size 2 color (1 0 0) }
}

Mathematical visualization:
for x in -5 to 5 {
    for z in -5 to 5 {
        define height (sin(x * 0.5) * cos(z * 0.5) * 2)
        cube {
            position (x * 0.3) height (z * 0.3)
            size 0.25 (abs(height) + 0.1) 0.25
            color (0.5 + height * 0.25) 0.3 (0.5 - height * 0.25)
        }
    }
}`,
      },
      path: {
        type: "string",
        description:
          "Path to an EXISTING ShapeScript source to present in place, instead of `script` — a `.shape` file this tool saved earlier (`artifacts/shapes/…`) or any other on disk. Provide either `script` or `path`, never both. Edits the user makes in the view write back to that same file.",
      },
    },
    required: ["title"],
  },
};
