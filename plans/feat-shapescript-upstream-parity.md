# ShapeScript plugin: upstream parity tracker

**Status**: phase 1 shipped in 2.0.0 (#3069); phase 2 and the first phase-3 batch in 2.1.0 (#3072); mesh values in 2.2.0
**Upstream**: [nicklockwood/ShapeScript](https://github.com/nicklockwood/ShapeScript) 1.11.4 (2026-09-04)
**Ours**: `packages/plugins/shapescript-plugin` (ported from `@gui-chat-plugin/present3d`)
**Last updated**: 2026-09-11

The plugin ships its own ShapeScript parser / evaluator / Three.js converter. It was ported
from the present3D plugin, which had invented its own unit conventions. The result is that a
script written against the upstream docs (which is what an LLM has read) renders wrong here
without any error. This file tracks every known gap so they can be closed in order.

## Phase 1 — semantic mismatches (silent wrong output)

These are the highest-value fixes: valid upstream scripts render, but incorrectly.

| # | Feature | Upstream | Ours (before) | Status |
|---|---|---|---|---|
| 1 | `rotation` / `orientation` property | `roll yaw pitch` in **half-turns** (0.5 = 90°), applied Z → Y → X, positive = clockwise | `x y z` in radians, XYZ order | fixed in this PR |
| 2 | `rotate` command (shapes + paths) | half-turns, same axis order | full turns (1 = 360°), XYZ order | fixed in this PR |
| 3 | `sphere` / `cylinder` / `cone` / `circle` / `polygon` `size` | **diameter** (default 1) | radius, so every curved shape rendered twice as large | fixed in this PR |
| 4 | path `point` / `curve` coordinates | absolute, in the path's local frame; `translate` / `rotate` / `scale` inside a path move that frame | relative steps from the pen | fixed in this PR |
| 5 | `curve x y` | a quadratic Bézier **control point**; consecutive controls get an implicit on-curve midpoint | an end point with an optional 4-arg control offset | fixed in this PR |
| 6 | `seed N` command | scoped reseed of the `rnd` sequence; LCG `x = x * 1664525 + 1013904223 mod 2^32`, default seed 0 | no keyword (tool option `randomSeed` only); mulberry32 | fixed in this PR |
| 7 | single-value rotation `orientation 0.25` | roll only (`0.25 0 0`) | uniform `0.25 0.25 0.25` | fixed in this PR |
| 8 | angle-axis rotation `orientation 0.5 0 1 0` | supported (1.11.0) | not supported | fixed in this PR |
| 9 | call arguments `max(0 (j - 1))` | space-separated (C-like parens) or bare `max 0 (j - 1)` | comma-separated only, so no script with a 2-arg call could open in both | parenthesised form fixed in this PR; bare form still unsupported |
| 10 | ordinal members `.first` … `.last`, `.allButFirst`, `.allButLast` | supported | only `[i]` and `.x/.y/.z` | fixed in this PR |
| 13 | `path { position … orientation … size … }` | transform options on a path, used to place loft sections | not parsed inside a path block | fixed in this PR (lathe profiles excepted) |
| 12 | `tau` constant | not defined (only `pi`) | defined | plugin extension, kept; docs steer the agent to `2 * pi` |
| 11 | statement separators | one statement per line (line break, `}` or EOF) | also accepts several per line | documented only; ours is a superset, so scripts written for upstream parse here |

Conventions that already matched and stay: trig functions in radians, `size` on `cube` /
`square` = edge length, single-value `size` = uniform, `translate` / `scale` as relative
transforms, `detail`, `rnd`.

Known remaining deviations inside phase 1 scope (documented in the README):

- An **open** path whose first or last point is a `curve` treats that point as a corner;
  upstream extrapolates a tangent. Closed all-curve paths (the octagon-circle idiom) match.
- `curve` and `point` take 2D coordinates; a third `z` component is not parsed.
- `torus` is a plugin extension (upstream has none). Its `size` is now the outer diameter so it
  follows the same rule as the other curved primitives.

Found while running the upstream examples (fixed in 2.1.0, also phase-1 class):

| # | Feature | Upstream | Ours (before) | Status |
|---|---|---|---|---|
| 14 | scope of `for` / `if` / `switch` | symbols only; transforms and materials carry on after the body (scope.md) | reset at the closing brace, so Chessboard's pieces marched off the board | fixed in 2.1.0 |
| 15 | bare `path` at scene level | drawn as a line | filled face | fixed in 2.1.0 |
| 16 | `size 1 2` | `1 2 1` (Euclid `Vector(size:)`) | `1 2 0`, refused by `cube` | fixed in 2.1.0 |
| 17 | `size` on a builder / group, `material` inside a builder block | scales the result; sets its material | ignored | fixed in 2.1.0 |
| 18 | options on a custom block call (`post { position 1 orientation 0.5 }`) | place the block's output | bound as symbols; `orientation` was a parse error | fixed in 2.1.0 |
| 19 | lathe profile on the −X side | same solid | inside-out | fixed in 2.1.0 |
| 20 | lathe profile drawn top-down | oriented outward (Euclid) | inside out, so `union` dropped it (Chessboard queens) | fixed in 2.1.0 |
| 21 | `extrude` depth placement | centred: ±depth/2 around the profile plane | 0…depth (Train running board offset) | fixed in 2.1.0 |

## Phase 2 — commands that parse but fail to render — DONE (2.1.0)

- `background R G B` is kept on the root group (`sceneInfoOf(group).background`) and both the
  View and the server render page paint it. A background image, `texture`, `camera` and
  `light` are accepted and skipped; the warnings travel on `userData`, in the tool result
  message ("Not rendered: …") and in the View.

## Phase 3 — missing language features (by likely impact on generated scripts)

Test fixtures: the upstream `Examples/` directory (`test/fixtures/upstream-examples/`, MIT).
All nine (Ball, Chessboard, Cog, Dodecahedron, Earth, Fillet, Spirals, Spring, Train) render.

Done in 2.1.0:

- **Materials**: hex, HSB (`hsb()`), named colours, alpha by count and `color red 0.5`,
  scoped multiplicative `opacity`, `metallicity` / `roughness` (PBR), `glow` (emissive),
  `material { … }` bundles and `material NAME`, `smoothing` (0 = flat), `name`.
- **Primitives**: `icosphere` (upstream's subdivision rule from `detail`).
- **Paths**: `arc { angle position orientation size }`, `roundrect { radius }`, builders
  taking one unwrapped child (`extrude circle`), 3D path points accepted when z = 0.
- **Expressions**: ranges as values (`1 to 5 step 2`, re-stepping, `in`), bare calls
  (`max 0 1`, `sin pi / 2`), custom functions with parameters and local defines, `split`,
  negative / named subscripts, size / rotation / HSB members.
- **Scene**: `print` (returned with the tool result), `assert`, `smoothing`, `name`;
  `camera` / `light` skipped with a warning; `import`, `text`, `font`, `mesh`, `minkowski`,
  `inset`, `svgpath`, `along`, `object`, `normals`, `focus`, `debug` refused by name.

Done in 2.2.0 (Dodecahedron):

- **Values**: shapes as values with `polygons` / `triangles` / `bounds` / `volume` members and
  polygon `center` / `points` / `bounds`; `for` and `if` as expressions; functions that build
  shapes, called bare as statements; `polygon { point … }` faces with colours; `mesh { … }`;
  the icosphere in Euclid's face order; line breaks inside parentheses.

Done in 2.3.0 (Fillet, Spirals):

- **Builders**: `minkowski` (hull of vertex sums for convex operands; merged per-face hulls for a
  non-convex one — overlapping shells rather than a boolean union), `inset(mesh d)` (offset-plane
  corners), `extrude … along` (mitred sweep, caps on open paths), open paths extruded to walls,
  `detail` as a value and `detail 0` in a path, shape values keep their colour.

Done in 2.4.0 (text):

- **Text**: `text` with upstream's layout (Helvetica metrics, one unit per line, `size`,
  `wrapwidth`, `linespacing`, interpolation) in a bundled Helvetiker face; `fill` / `extrude` of
  profiles with holes; `font` accepted and skipped. `Platonic Solids.shape` still needs
  `children` inside a custom block and `import`.

Open:

- **Blocks**: `children` in a custom block (`define solid { children … }` with shapes passed at
  the call site), `import`.
- **Builders**: `extrude` options `twist`, `axisAligned`, `miterLimit`; a boolean union of
  `minkowski` pieces for non-convex operands (they are merged shells today).
- **Values**: paths as values (`define p path { … }`, `path.points`), per-vertex colours between
  a polygon's points (a polygon takes one colour), `object` values.
- **Paths**: `svgpath`, nested / compound paths with holes, `path.color` gradients, 3D path
  points with z ≠ 0, `arc` outside a path.
- **Materials**: texture images (`texture`, `opacity` / `metallicity` / `roughness` textures,
  `normals`), `smoothing` as an angle threshold.
- **Rotation values**: `rotation` function, rotation multiplication, `{ yaw 0.5 }` /
  `{ axis … angle … }` block syntax (1.11.0 – 1.11.2).
- **Object syntax** for `color`, `size`, `point`, `path`, `polygon`, `mesh` (1.11.0); `object`
  values; partial ranges (`from 5`); range subscripts (`v[0 to 2]`); `if` / `switch` inside
  expressions; string `lines` / `words` / `characters`; `font` (a chosen face; one face is
  bundled), `fonts`; `light` / `camera` rendering.

## Things we have that upstream does not

USDZ export, server-side PNG rendering, deterministic server/browser double evaluation,
explicit node / vertex / iteration / wall-clock limits, the `torus` and `polygon` primitives.
Keep these; they are the product, not the gap.

## Compatibility note for phase 1

The unit changes are **breaking for saved `.shape` files** written against the old
conventions (spheres shrink by half, rotations change). That is why the plugin goes to
`2.0.0`. MulmoTerminal consumes the same package and shares workspace data, so it must
pick up the same major (see `project_mulmoterminal_host_route_port` memory).
