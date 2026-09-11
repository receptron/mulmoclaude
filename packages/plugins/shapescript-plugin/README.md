# @mulmoclaude/shapescript-plugin

`presentShapeScript` — interactive 3D visualizations authored in the **ShapeScript** language.
The plugin ships its own ShapeScript parser / evaluator and a Three.js renderer (CSG via
`three-bvh-csg`), so a model is described as text and rendered in the chat canvas.

Ported from [`@gui-chat-plugin/present3d`](https://github.com/receptron/GUIChatPluginPresent3D)
(MIT, same authors). The tool is named `presentShapeScript` here — the upstream `present3D`
name, and the `Present3D*` type names, are renamed throughout.

## Exports

| Entry         | Contents                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.`           | `TOOL_NAME`, `TOOL_DEFINITION`, `executePresentShapeScript`, `pluginCore`, `samples`, `parseShapeScript`, `astToThreeJS`, `executeShapeScriptDispatch` + the `artifacts/shapes` path rules |
| `.` (export) | `shapeScriptToUsdz`, `sceneToUsdz`, `USDZ_MIME_TYPE`, `USDZ_EXTENSION`, and the **`exportShapeScriptUsdz`** tool (`executeExportShapeScriptUsdz`, `EXPORT_USDZ_*`). Browser-safe: it needs no canvas, so the View's "Download USDZ" button and a host's MCP tool run the same code. |
| `./render`    | **server-only** — `renderShapeScriptSheet` and the render page. Rasterises a model to a PNG with Puppeteer's headless Chromium (an OPTIONAL peer); a host without one gets `RenderUnavailableError` carrying the install hint. |
| `./vue`       | the `ToolPlugin` (View + Preview + `SYSTEM_PROMPT`), plus everything on `.`                                              |
| `./style.css` | the compiled component styles (Vite lib mode does not auto-inject them)                                                  |

```ts
import type { ToolContext } from "gui-chat-protocol";
import { executePresentShapeScript } from "@mulmoclaude/shapescript-plugin";

// The handler does not read the context; the host passes its own.
const context = {} as ToolContext;

const result = await executePresentShapeScript(context, {
  title: "Circular Pattern",
  script: `
define count 12
for i in 1 to count {
    define angle ((i / count) * 6.283)
    cube {
        position (cos(angle) * 3) 0 (sin(angle) * 3)
        color (i / count) 0.5 (1 - i / count)
        size 0.5
    }
}`,
});
```

## USDZ export

`exportShapeScriptUsdz` writes a model out as a USDZ archive (AR Quick Look on Apple devices, or
any USD viewer). A host wires it against the same `{ files: { artifacts, byPath? } }` context shape
`executeShapeScriptDispatch` takes — a full `FileOps`, or just `read` / `write` / `exists`
(`ShapeFileOps`) — no browser, no `node:*`:

```ts
import { executeExportShapeScriptUsdz, EXPORT_USDZ_TOOL_NAME, EXPORT_USDZ_DESCRIPTION, EXPORT_USDZ_SCHEMA, EXPORT_USDZ_PROMPT } from "@mulmoclaude/shapescript-plugin";

// register { name: EXPORT_USDZ_TOOL_NAME, description: EXPORT_USDZ_DESCRIPTION, inputSchema: EXPORT_USDZ_SCHEMA }
const { message, filePath } = await executeExportShapeScriptUsdz({ files: shapeFiles }, args);
```

The file lands at `artifacts/shapes/<slug>-<epoch-ms>-<token>.usdz`. The View's **Download USDZ**
button builds the same archive in the browser with `shapeScriptToUsdz` and saves it locally.
USDZ units are metres, so `size 1` is one metre in AR.

## ShapeScript language

- **Primitives**: `cube`, `sphere`, `icosphere`, `cylinder`, `cone`, `torus`, `circle`, `square`,
  `roundrect`, `polygon`
- **Properties**: `position X Y Z`, `orientation ROLL YAW PITCH` (alias `rotation`), `size X Y Z`,
  `detail`, `smoothing`, `name`
- **Materials** (as properties or scoped commands): `color`, `opacity`, `metallicity`, `roughness`,
  `glow`, `material NAME`; `texture` is accepted with a warning
- **CSG**: `union`, `difference`, `intersection`, `xor`, `stencil`
- **Builders**: `extrude`, `loft`, `lathe`, `fill`, `hull`
- **Variables & expressions**: `define`, arithmetic / comparison / boolean operators, `in`, ranges,
  parentheses, custom functions
- **Control flow**: `for … in …`, `if` / `else`, `switch` / `case`
- **Built-ins**: `round floor ceil abs sign sqrt pow min max`, `sin cos tan asin acos atan atan2`
  (radians), `dot cross length normalize sum`, `rgb hsb`, `join split trim`, `rnd`
- **Commands**: `detail N`, `seed N`, `smoothing N`, `background`, `print`, `assert`, and the relative
  `rotate` / `translate` / `scale`; `camera` / `light` blocks are skipped with a warning

A call is either C-like, with **no space** before its parenthesis (`sin(x)`; `sin (x)` is not a
call), or bare, as upstream: `max 0 (j - 1)`, `sqrt 9`, `sin pi / 2` — the function takes every
value after it, so parenthesise it inside a larger expression: `(sqrt 9) + (sqrt 16)`. Arguments are
a value list; commas (`max(0, j - 1)`) also work here but not in the upstream app. This parser also
accepts several statements on one line (`define a 1 define b 2`); upstream requires one per line, so
portable scripts keep to that.

## Storage

A new `script` is saved to `artifacts/shapes/<slug>-<epoch-ms>.shape` and the
result names it as `data.filePath`; pass `path` instead of `script` to present a
source that already exists — a `.shape` this tool wrote, or any other on disk —
and it is rendered in place rather than copied. The two are mutually exclusive.
The View's source editor writes edits back to that same file (dispatch kinds
`loadShape` / `saveShape`), and refreshes from disk on open, so a model the agent
rewrote is what the user sees.

All file access goes through the host's generic gui-chat-protocol capability:
`files.artifacts` for `artifacts/shapes/**`, `files.byPath` for anything else.
A host that supplies neither keeps the pre-1.1 behaviour — the script travels
inside the tool result and nothing is written — rather than failing.

## Validation and errors

`executePresentShapeScript` checks arguments, parses the source, evaluates expressions,
and builds geometry headlessly before returning success. Temporary geometry is disposed.
Failures are returned as values, with **no `data` field**, so the host does not open a
broken visualization. The same diagnostic is available as `error` and `jsonData.error`
(the latter is included in the calling agent's tool response):

```ts
const result = await executePresentShapeScript(context, {
  title: "Example", script: "cube { size missing }",
});
if ("error" in result) {
  console.log(result.error.code, result.error.message);
  // EVALUATION_ERROR, "Undefined variable: missing"
}
```

Codes: `INVALID_ARGUMENT`, `PARSE_ERROR`, `EVALUATION_ERROR`, `LIMIT_EXCEEDED`.
Parse diagnostics include `line` and `column` when available. Invalid input does not
throw from the tool handler. Successful results retain their existing `{ title, data: { script } }`
contract. Validation executes the script, including geometry construction; the browser
constructs it again for display. The source editor also validates geometry before saving.

## Builders and additional expressions

```text
// Loft joins sections and caps the ends; hull forms a convex envelope.
loft {
    square
    translate 0 0 2
    circle
}
hull {
    cube { position -1 0 0 }
    cube { position 1 0 0 }
}
extrude { polygon { sides 5 } }
fill { square }
lathe path {
    point 0 0
    point 1 0
    curve 1.5 1
    point 1 2
    point 0 2
}

// Paths: absolute points, Bézier control points, a frame moved by rotate/translate/scale.
extrude path {
    point 0 0
    point 1 0
    point 1 1
    point 0 1
    point 0 0
}
fill path {
    for 0 to 8 {
        curve 0 1
        rotate 1 / 8
    }
}

// Stencil changes surface material without cutting away the first shape.
stencil {
    cube { color 1 0 0 }
    cube {
        position 0.5 0 0
        color 0 1 0
    }
}

define offsets ((1 2 3), (4 5 6))
cube { position offsets[0].x offsets[1].y offsets.count }

// Materials, as upstream: hex and named colours, alpha, PBR properties, bundles.
define brass material {
    color #d4a017
    metallicity 1
    roughness 0.3
}
material brass
sphere
cube {
    position 2
    color red 0.5      // red at 50% alpha
    glow orange * 0.3  // emissive
}

// Ranges, the `in` operator, custom functions and bare calls.
define steps 0 to 1 step 0.25
define ease(t) { t * t * (3 - 2 * t) }
for t in steps {
    if t in 0.25 to 0.75 {
        cube {
            position (t * 4) (ease t) 0
            size max 0.1 (t / 2)
        }
    }
}

// A rounded slab from two arcs, extruded; a bare path draws as a line.
extrude path {
    arc { angle -0.5 }
    point -0.5 0
    point 1.5 0
    arc {
        position 1 0
        orientation 0.5
        angle -0.5
    }
    curve 0 0.5
}
```

Also supported: `pi` (no `tau`, as upstream; write `2 * pi`), `true`, `false`, scientific notation, unary `+`,
short-circuit `and`/`or`, string literals, `join`/`split`/`trim`, tuple arguments to `min`/`max`,
zero-based tuple/string subscripts (negative from the end, or by name: `v["y"]`), `.count`, ordinal
members `.first` … `.tenth`, `.last`, `.allButFirst`, `.allButLast`, vector `.x/.y/.z/.w`, size
`.width/.height/.depth`, rotation `.roll/.yaw/.pitch`, color `.red/.green/.blue/.alpha` (or
`.r/.g/.b/.a`) and `.hue/.saturation/.brightness`, custom shape definitions with options (placed
and coloured through `position` / `orientation` / `size` / `color` / `material` on the call), and
`polygon { sides N }` (integer 3–256). Lathe samples curved profiles (drawn on either side of the
axis), and inline builder paths use the same parser as nested paths, including loops and
definitions. A `material` command inside a builder block applies to the builder's result, and
`size` on a builder or group scales it (an extrude's Z is its depth). `print` lines and the
commands that were skipped come back on the root group's `userData` (`sceneInfoOf(group)`) and in
the tool result message.

## Units and path semantics — same as upstream

Since 2.0.0 the plugin follows the [upstream ShapeScript](https://shapescript.info/mac/)
conventions, so a script written against the upstream docs renders the same here:

- `size` is the **diameter** of `sphere`, `cylinder`, `cone`, `circle`, `polygon` and `torus`
  (a bare `sphere` fits the unit cube) and the edge length of `cube` / `square`.
- `orientation` (alias `rotation`) and `rotate` take **half-turns** as `roll yaw pitch` —
  rotations about Z, Y and X applied in that order, `0.5` = 90°, positive clockwise (Euclid's
  sign). A lone value is a roll; four values are `angle x y z`. Trig *functions* still use radians.
- Path `point` / `curve` coordinates are **absolute** in the path's frame; `rotate`, `translate`
  and `scale` inside a path move that frame for later points. `curve` is a quadratic Bézier
  **control point** — the outline passes through the neighbouring `point`s, and two `curve`s in
  a row get an implicit on-curve midpoint (eight in an octagon draw a circle). A path block may
  carry `position` / `orientation` / `size` of its own, which is how a `loft` section is placed in
  3D; `lathe` refuses a placed profile.
- `rnd` uses upstream's generator (`x = x · 1664525 + 1013904223 mod 2³²`, seed 0) and `seed N`
  reseeds it for the enclosing block only.
- **Scope** (2.1.0): a shape block, `group`, builder or custom block resets transforms and
  materials at its closing brace; `for` / `if` / `switch` bodies scope only symbols, so a
  `translate` inside a loop carries on after it, as upstream's scope rules say.
- A **bare `path`** draws as a line (2.1.0), as upstream; `fill` / `extrude` / `lathe` / `loft`
  make a surface or solid of it.
- `size 1 2` pads to `1 2 1` (Euclid's `Vector(size:)`), so `cylinder { size 1 2 }` is a
  cylinder of diameter 1 and height 2.
- `extrude` is centred on its profile plane, spanning ±depth/2 (2.1.0; it ran 0…depth
  before), and a lathe always faces outward whichever way its profile is drawn.

Deviations that remain: an *open* path whose first or last point is a `curve` treats it as a
corner (upstream extrapolates a tangent), path points are 2D, nested sub-paths (holes) are not
supported, and `smoothing` is flat (0) or smooth rather than an angle threshold. The gap list
lives in [`plans/feat-shapescript-upstream-parity.md`](../../../plans/feat-shapescript-upstream-parity.md).

## Compatibility and limits

This is the plugin's documented modeling subset, **not complete compatibility with
upstream ShapeScript**.

Loft accepts ordered, closed planar sections with one perimeter each, resamples differing
vertex counts, interpolates linearly, and triangulates the end caps. Sections must enclose
a volume. Hull accepts geometry from child meshes and filled paths. Primitive profiles
for fill/extrude must lie in XY; holes, twisted extrusion (`twist`) and arbitrary 3D path
commands are not implemented. `extrude … along` sweeps a section along a path (mitred at
corners, capped at the ends of an open path); an open path extrudes to a two-sided wall, as
upstream. `minkowski { a b }` is the hull of two convex solids' vertex sums, and for a
non-convex operand the merged per-face hulls (overlapping shells, not a boolean union — fine to
draw, not to feed to another boolean); `inset(mesh d)` slides every vertex to where its faces'
offset planes meet. `text "Hello"` lays glyph outlines out as upstream does — left margin at
x = 0, first baseline at y = 0, one world unit per line, `size` scaling it, `wrapwidth` and
`linespacing` as options, values interpolated (`text "Bob has " apples " apples"`) — in a bundled
Helvetica-like face (Helvetiker; `font` is accepted and skipped with a warning, and a character
the face lacks draws as `?`). Bare `text` draws outlines; `fill` and `extrude` turn it into faces
and solids, holes included, and it is a value with `.bounds`. `import`, `svgpath`, `object` values
and paths as values are refused with a message naming the feature. Textures,
normal maps, `camera` and `light` blocks are accepted and skipped with a warning that the
tool result and the View both report. Unsupported commands and failed CSG operations return
errors instead of silently substituting different geometry. As with other polygonal CSG
engines, degenerate or self-intersecting inputs may fail.

The upstream project's own example scripts are test fixtures
(`test/fixtures/upstream-examples/`, MIT): all nine — Ball, Chessboard, Cog, Dodecahedron, Earth,
Fillet, Spirals, Spring and Train — render.

## Shapes as values, meshes and polygons

Since 2.2.0 a shape is a value, as upstream: `define ico icosphere { detail 0 }` keeps its mesh, `ico`
places it (with `position` / `orientation` / `size` on the call), and its members are readable —
`polygons` and `triangles` (each with `.center`, `.points`, `.bounds`), `bounds` (`.min` `.max`
`.center` `.size` `.width` `.height` `.depth`) and `volume`. The icosphere follows Euclid's
construction face for face, so scripts that index its faces (upstream's Dodecahedron) get the same
faces. `for v in … { expr }` and `if c { a } else { b }` are expressions, a function may build
shapes (`define face(data) { polygon { … } }`) and be called bare as a statement (`face data`), and
`mesh { … }` assembles the polygons its body produces — `polygon { color red … }` with one `point` per line
with 3D points, a tuple per point allowed — into one flat-shaded, vertex-coloured mesh. A value a
statement produces that is not a shape is an "unused value" error, as upstream. Paths as values and
`object` values remain unsupported.


`rnd` and `rand()` draw from a seeded generator (`randomSeed`, default
`DEFAULT_RANDOM_SEED` = 0, overridable in-script with `seed`) rather than `Math.random()`:
one script is evaluated twice — once on the server, which validates it, and again in the
browser, which renders it — and an unseeded generator lets those two runs take different
branches.

Conversion limits cover nodes (100,000), loop/path work (100,000 iterations), detail (3–256),
aggregate vertices (5,000,000, including CSG intermediates), and a coarse 30-second wall-clock
budget checked between nodes — it refuses to start the next node once the budget is spent, but
cannot interrupt one long boolean. Every one is overridable through `ConversionOptions`.

Measured, those ceilings bind in different places: a grid of 22,500 cubes is ~540k vertices and
converts in under 200 ms, 930 spheres at `detail 64` reach the vertex budget, and the wall clock
is in practice the CSG budget alone — 240k vertices of plain geometry take ~95 ms, while 100
boolean subtractions take 5.3 s. Remember the script is built TWICE, once on the server to
validate it and once in the browser to draw it, and that the browser's copy is what the user's
tab has to keep rendering.

## Scripts

```bash
yarn build      # vite build + d.ts emit
yarn typecheck  # vue-tsc --noEmit
yarn lint
yarn test       # node:test — tool execute + parser + Three.js conversion
```
