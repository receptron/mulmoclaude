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
sphere {
    size radius
    color red
}

### Control Flow:

For loops with variables:
for i in 1 to 5 {
    cube {
        position (i * 2) 0 0
        size 1
    }
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
Colour: rgb(r g b [a]), hsb(h s b [a]); strings: join, split, trim

Two call spellings, both as upstream: C-like max(0 (j - 1)) with NO space before the parenthesis, or the
bare form max 0 (j - 1) / sqrt 9 / sin pi / 2, where the function takes every value after it. Separate
arguments with spaces; commas also work here (max(0, j - 1)) but NOT in the upstream ShapeScript app.
Inside a larger expression parenthesise a bare call: (sqrt 9) + (sqrt 16).
Custom functions: define hyp(a b) { sqrt(a * a + b * b) } — parameters, optional defines, then the result
expression; they compute values, not shapes.
Write ONE statement per line. This parser accepts "define a 1 define b 2" on one line; the upstream app
rejects it, and "size 2 1 radius 0.5" on one line reads radius as a fourth size component in both.

Examples:
for i in 1 to 8 {
    define angle (i * 0.785)  // 45 degrees in radians
    cube { position (cos(angle) * 3) 0 (sin(angle) * 3) }
}

### Primitives & Properties:

Shapes: cube, sphere, icosphere, cylinder, cone, torus, circle, square, roundrect (radius 0–0.5 of the smaller side), polygon (sides 3–256)
Properties: position X Y Z, orientation ROLL YAW PITCH (alias: rotation), size X Y Z, detail N, smoothing N, name "label"
Materials (as properties or as scoped commands): color, opacity, metallicity, roughness, glow, material NAME
- color takes 1–4 values: luminance, luminance+alpha, RGB, RGBA. Also hex #F00 / #FF0000 / #FF000080, the names
  black blue green cyan red magenta purple yellow white orange gray/grey, hsb(...), and "color red 0.5" to set alpha.
- opacity multiplies through nested scopes (opacity 0.5 twice = 0.25); glow is an emissive colour; smoothing 0 = flat shading.
- define shiny material { color blue metallicity 1 roughness 0.1 } bundles properties; apply with material shiny.
- texture "file.png" and background "file.png" are accepted with a warning (not drawn); background R G B sets the scene colour.
- camera { … } and light { … } blocks are accepted and skipped with a warning.

UNITS (same as upstream ShapeScript — https://shapescript.info/mac/):
- size is the DIAMETER of sphere/icosphere/cylinder/cone/circle/polygon/torus (a bare sphere fits the unit cube); for cube/square it is the edge length. size 1 2 means 1 2 1 (the third value repeats the first).
- orientation / rotate use HALF-TURNS in roll (Z), yaw (Y), pitch (X) order: 0.5 = 90°, 1 = 180°. Positive is clockwise. A lone value is a roll: orientation 0.25 = 45° about Z. Angle-axis also works: orientation 0.5 0 1 0.
- rotate / translate / scale as commands are relative and accumulate; orientation as a command is absolute.
- SCOPE: a shape block, group, builder or custom block resets transforms and materials at its closing brace.
  for / if / switch bodies do NOT: a translate inside a loop carries on after it (upstream's rule). Symbols
  (define) are scoped by every block.
- Trig FUNCTIONS (sin, cos, …) still take radians. Convert with pi: a half-turn value h is h * pi radians.

### CSG Operations:
union, difference, intersection, xor, stencil

Example:
difference {
    sphere {
        size 2
        color (1 0.5 0)
    }
    cube { size 1.5 }
}

### Paths:
path { point X Y … } — coordinates are ABSOLUTE in the path's frame. Close a path by repeating the first point.
A bare path draws as a LINE (stroke), as upstream; use fill / extrude / lathe / loft to make a surface or solid.
- arc { angle A } inside a path: A half-turns clockwise from +Y, radius size/2 (default 0.5), with optional
  position / orientation / size — e.g. two quarter arcs and two points make a rounded slab.
- curve X Y is a quadratic Bézier CONTROL point: the outline passes through the point commands on either side, not through it. Two curves in a row get an implicit on-curve midpoint, so eight curves in an octagon draw a circle.
- A path may carry position / orientation / size of its own (path { position 0 0 2 orientation 0 0.5 0 point … }); that is how a loft section is placed in 3D. Give loft and extrude PATH children, not fill{} meshes — the upstream app rejects a mesh there.
- rotate (half-turns) / translate / scale inside a path move the frame for later points:
  path {
      for 0 to 8 {
          curve 0 1
          rotate 1 / 8
      }
  }  // semicircle

### Builders:
- extrude: extrude polygon { sides 3 } / extrude { … } or an inline path (size X Y scale the profile, size Z = depth, default 1):
  extrude path {
      point 0 0
      point 1 0
      point 0 1
      point 0 0
  }
- fill: fill { square } or fill path { ... }
- lathe (revolves the XY profile about Y):
  lathe path {
      point 0 0
      point 1 0
      curve 1.5 1
      point 1 2
      point 0 2
  }
- loft (closed planar sections joined with caps):
  loft {
      square
      translate 0 0 2
      circle
  }
- hull (convex envelope):
  hull {
      cube { position -1 0 0 }
      cube { position 1 0 0 }
  }
- stencil preserves the first shape and paints its surface with later shapes' materials.
Loft sections must each have one perimeter and enclose an area; extrude/fill primitive profiles must lie in XY.
A material command inside a builder block (extrude { color red … }) colours the result; size on a builder or
group scales it. Not supported: extrude along/twist, minkowski, inset, svgpath, text.
- mesh { polygon { point x y z … } … }: a mesh from explicit faces; polygon { color red point a point b point c }
  takes 3D points (a tuple works: point v) and a colour per face. Faces may come from a function: mesh { for f in faces { face f } }.

### Additional Expressions:
- Constants: pi, true, false (tau exists here but NOT in the upstream app; write 2 * pi)
- Scientific notation and unary plus: 1e-3, +2
- Ranges as values: define loops 1 to 5 step 2, then for i in loops { … }, for i in loops step 1, and
  "if 3 in loops"; the in operator also tests tuples (2 in (1 2 3)) and strings.
- Tuple/vector members: .x .y .z, .width .height .depth, .roll .yaw .pitch, .red .green .blue .alpha, .hue .saturation .brightness
- Tuple/string length: value.count; zero-based indexing values[0], negative from the end values[-1], by name values["y"];
  ordinals: v.first v.second … v.last, v.allButFirst, v.allButLast
- String literals, join(...), split(...), trim(...); min/max also accept tuples
- print a b … records output that is returned with the tool result; assert condition stops the script when false
- Custom shapes with options:
define post {
    option height 2
    cylinder { size 0.2 height }
}
post { height 3 }
- Random numbers: rnd (0–1) and seed N (scoped to the enclosing block, same generator as upstream)
- Shapes as values: define ico icosphere { detail 0 } then ico (places it), ico.polygons (faces, each with
  .center .points .bounds), ico.triangles, ico.bounds (.min .max .center .size .width .height .depth), ico.volume.
- for / if as expressions: define scales for i in 1 to 3 { i / 3 }; define c if big { red } else { white }
- Functions may build shapes: define face(data) { polygon { … } } and are called bare as statements: face data

### Compatibility:
This plugin implements the documented modeling subset, not all upstream ShapeScript syntax; units, scoping,
materials and path semantics follow upstream, so a script written against the upstream docs renders the
same here. Not supported (each is refused by name): import, text/font, minkowski, inset, svgpath,
extrude along/twist, object values and paths as values. Textures, cameras and lights are accepted but
not drawn.

### Comments:
// Single-line comment
/* Multi-line
   comment */

## COMPLETE EXAMPLES:

Linear arrangement with expressions:
define spacing 1.5
for i in 1 to 4 {
    cylinder {
        position ((i - 2.5) * spacing) 0 0
        size 0.4 1
    }
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
        sphere {
            size 2
            color (1 0 0)
        }
        sphere { size 1.7 }
    }
} else {
    sphere {
        size 2
        color (1 0 0)
    }
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
