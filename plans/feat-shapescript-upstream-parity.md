# ShapeScript plugin: upstream parity tracker

**Status**: phase 1 in progress (semantic mismatches)
**Upstream**: [nicklockwood/ShapeScript](https://github.com/nicklockwood/ShapeScript) 1.11.4 (2026-09-04)
**Ours**: `packages/plugins/shapescript-plugin` (ported from `@gui-chat-plugin/present3d`)
**Last updated**: 2026-09-10

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

## Phase 2 — commands that parse but fail to render

- `background` and `texture` parse into AST nodes but the converter throws
  "Unsupported command". Upstream scripts use `background` routinely. Accept `background` as
  a scene-level colour and ignore `texture` with a diagnostic rather than an error.

## Phase 3 — missing language features (by likely impact on generated scripts)

- **Materials**: hex colours (`#FF0000`), HSB colours, named colours (`red`, `green`, …),
  `material` blocks, `glow`, `metallicity`, `roughness`, `opacity` textures, `normals`.
- **Primitives**: `icosphere` (1.11.0).
- **Builders**: `minkowski`; `extrude` options `along`, `twist`, `axisAligned`, `miterLimit`;
  `inset` (1.11.0).
- **Paths**: `arc`, `roundrect`, `svgpath`, `angle`, nested / compound paths with holes,
  `path.color`, 3D path points.
- **Rotation values**: `rotation` function, quaternion-style multiplication of rotations,
  `{ yaw 0.5 }` / `{ axis … angle … }` block syntax (1.11.0 – 1.11.2).
- **Object syntax** for `color`, `size`, `point`, `path`, `polygon`, `mesh` (1.11.0).
- **Expressions**: ranges as values (`1 to 5`), partial ranges, bare function calls without
  parentheses (`max 0 1`), `if` / `switch` / `for` inside expressions (1.10.0), `split`,
  `bounds` members, mesh members (`polygons`, `triangles`), string `lines` / `words` /
  `characters`.
- **Custom functions** with return values (we only have custom shapes with `option`s).
- **Scene**: `text` / `font`, `light`, `camera`, `import`, raw `mesh`, `smoothing`, `name`,
  `debug`, `print`, `assert`, `focus`.

## Things we have that upstream does not

USDZ export, server-side PNG rendering, deterministic server/browser double evaluation,
explicit node / vertex / iteration / wall-clock limits, the `torus` and `polygon` primitives.
Keep these; they are the product, not the gap.

## Compatibility note for phase 1

The unit changes are **breaking for saved `.shape` files** written against the old
conventions (spheres shrink by half, rotations change). That is why the plugin goes to
`2.0.0`. MulmoTerminal consumes the same package and shares workspace data, so it must
pick up the same major (see `project_mulmoterminal_host_route_port` memory).
