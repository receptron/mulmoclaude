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

- **Primitives**: `cube`, `sphere`, `cylinder`, `cone`, `torus`, `circle`, `square`, `polygon`
- **Properties**: `position X Y Z`, `orientation ROLL YAW PITCH` (alias `rotation`), `size X Y Z`, `color R G B` (0–1), `opacity`
- **CSG**: `union`, `difference`, `intersection`, `xor`, `stencil`
- **Builders**: `extrude`, `loft`, `lathe`, `fill`, `hull`
- **Variables & expressions**: `define`, arithmetic / comparison / boolean operators, parentheses
- **Control flow**: `for … in … to … step`, `if` / `else`, `switch` / `case`
- **Built-ins**: `round floor ceil abs sign sqrt pow min max`, `sin cos tan asin acos atan atan2`
  (radians), `dot cross length normalize sum`, `rnd`, `seed N`

A function call takes **no space** before its parenthesis: `sin(x)` is a call, `sin (x)` is not.

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
lathe path { point 0 0 point 1 0 curve 1.5 1 point 1 2 point 0 2 }

// Paths: absolute points, Bézier control points, a frame moved by rotate/translate/scale.
extrude path { point 0 0 point 1 0 point 1 1 point 0 1 point 0 0 }
fill path { for 0 to 8 { curve 0 1 rotate 1 / 8 } }

// Stencil changes surface material without cutting away the first shape.
stencil {
    cube { color 1 0 0 }
    cube { position 0.5 0 0 color 0 1 0 }
}

define offsets ((1 2 3), (4 5 6))
cube { position offsets[0].x offsets[1].y offsets.count }
```

Also supported: `pi`, `tau`, `true`, `false`, scientific notation, unary `+`,
short-circuit `and`/`or`, string literals, `join`/`trim`, tuple arguments to `min`/`max`,
zero-based tuple/string subscripts, `.count`, vector `.x/.y/.z/.w`, color
`.red/.green/.blue/.alpha` (or `.r/.g/.b/.a`), custom shape definitions with options,
and `polygon { sides N }` (integer 3–256). Lathe samples curved profiles, and inline
builder paths use the same parser as nested paths, including loops and definitions.

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
  a row get an implicit on-curve midpoint (eight in an octagon draw a circle).
- `rnd` uses upstream's generator (`x = x · 1664525 + 1013904223 mod 2³²`, seed 0) and `seed N`
  reseeds it for the enclosing block only.

Deviations that remain: an *open* path whose first or last point is a `curve` treats it as a
corner (upstream extrapolates a tangent), and path points are 2D. The gap list lives in
[`plans/feat-shapescript-upstream-parity.md`](../../../plans/feat-shapescript-upstream-parity.md).

## Compatibility and limits

This is the plugin's documented modeling subset, **not complete compatibility with
upstream ShapeScript**.

Loft accepts ordered, closed planar sections with one perimeter each, resamples differing
vertex counts, interpolates linearly, and triangulates the end caps. Sections must enclose
a volume. Hull accepts geometry from child meshes and filled paths. Primitive profiles
for fill/extrude must lie in XY; holes, swept/twisted extrusion, and arbitrary 3D path
commands are not implemented. Imports, textures, text/fonts, lights/camera declarations,
arbitrary objects, and general user-defined functions remain outside this subset.
Unsupported commands and failed CSG operations return errors instead of silently
substituting different geometry. As with other polygonal CSG engines, degenerate or
self-intersecting inputs may fail.

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
