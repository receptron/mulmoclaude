import "../style.css";

import type { ToolPlugin } from "gui-chat-protocol/vue";
import type { PresentShapeScriptData, PresentShapeScriptArgs } from "../core/types";
import { pluginCore } from "../core/plugin";
import { TOOL_NAME } from "../core/definition";
import { samples } from "../core/samples";
import View from "./View.vue";
import Preview from "./Preview.vue";

export const SYSTEM_PROMPT = `Use the ${TOOL_NAME} tool to create interactive 3D visualizations when the user requests:
- 3D models or shapes
- Mathematical visualizations (surfaces, functions, geometric patterns)
- Molecular or atomic structures
- Data visualization in 3D (scatter plots, surface plots)
- Architectural layouts
- Game boards or 3D game states
- Any spatial or geometric concepts

## Supported ShapeScript Features:

### Variables & Expressions:
- Define variables: define radius 2, define spacing 1.5
- Use expressions: position (i * 2) 0 0, size (radius * 1.5)
- Math operators: +, -, *, /, % with proper precedence
- Parentheses for grouping: (2 + 3) * 4

### Control Flow:

For loops with variables (use loop variable in calculations):
for i in 1 to 5 {
    cube {
        position (i * 2 - 6) 0 0
        size 1
    }
}

For loops with step:
for i in 0 to 10 step 2 {
    sphere { position 0 i 0 }
}

If/else conditionals:
if x > 0 {
    sphere
} else {
    cube
}

Switch statements for multiple cases

### Built-in Functions:
- Math: round, floor, ceil, abs, sign, sqrt, pow, min, max
- Trig: sin, cos, tan, asin, acos, atan, atan2 (radians!)
- Vector: dot, cross, length, normalize, sum

Calls: C-like max(0 (j - 1)) with NO space before the parenthesis, or bare max 0 (j - 1) / sqrt 9 as upstream.
Separate arguments with spaces. Commas work here but not in the upstream app.
Custom functions compute values: define hyp(a b) { sqrt(a * a + b * b) }
One statement per line; the upstream app rejects two statements on one line.

### Best Practices:
1. Use variables for repeated values
2. Use loop variables (i) for positioning and calculations
3. Use trig functions for circular/spiral patterns
4. Use conditionals for parametric designs
5. Keep code readable with meaningful variable names

### Common Patterns:

Linear arrangement:
for i in 1 to 5 {
    cube { position (i * 2) 0 0 }
}

Circular pattern:
define count 12
for i in 1 to count {
    define angle ((i / count) * 6.283)
    cube { position (cos(angle) * 3) 0 (sin(angle) * 3) }
}

Parametric surface:
for x in -5 to 5 {
    for z in -5 to 5 {
        define y (sin(x * 0.5) * cos(z * 0.5))
        cube {
            position (x * 0.3) y (z * 0.3)
            size 0.2
        }
    }
}

### Primitives & CSG:
Shapes: cube, sphere, icosphere, cylinder, cone, torus, circle, square, roundrect, polygon
CSG: union, difference, intersection, xor, stencil
Properties: position, orientation (alias rotation), size, detail, smoothing, name
Materials: color (1–4 values, hex #FF0000, names like red/orange/gray, hsb(...)), opacity, metallicity, roughness, glow,
material NAME (from define NAME material { … }); background R G B sets the scene colour.
Scope: shape blocks, groups, builders and custom blocks reset transforms/materials at their closing brace;
for / if / switch bodies do not (a translate in a loop carries on after it).

### Units (upstream ShapeScript conventions):
- size = DIAMETER for sphere/cylinder/cone/circle/polygon/torus, edge length for cube/square. A bare sphere fits the unit cube.
- orientation / rotate = HALF-TURNS as roll yaw pitch (Z, Y, X): 0.5 = 90°. A lone value is a roll. Trig functions still use radians.
- Path point/curve coordinates are absolute; curve is a Bézier control point; rotate/translate/scale inside a path move the frame.
- A path can carry its own position/orientation/size; give loft/extrude path children (not fill{}), as the upstream app requires.

Builders: extrude, fill, lathe, loft, hull. Example:
loft {
    square
    translate 0 0 2
    circle
}
Stencil preserves the first shape's volume and paints the intersecting surface.
Constants: pi, true, false (avoid tau, upstream lacks it; write 2 * pi). Tuple/string access: values[0], values[-1], vector.x, value.count.
Ranges are values (define r 1 to 5 step 2; for i in r; if 3 in r). A bare path draws as a line; fill/extrude it for a surface.
Polygon supports sides (3–256). String literals and join/split/trim are supported. print records output for you.
Use the tool schema for exact syntax and builder limits. This is a modeling subset of upstream ShapeScript;
imports, text/fonts, minkowski/inset/svgpath/along and object values are refused by name;
shapes are values (define ico icosphere { detail 0 }; ico.polygons, .bounds, .volume), for/if work as expressions,
functions may build shapes, and mesh { polygon { point … } } builds a mesh from explicit faces;
textures, cameras and lights are accepted but not drawn (the result reports them).
If presentShapeScript returns an error diagnostic, correct the script and retry; no visualization was created.

Keep visualizations clear, well-organized, and use expressions and control flow.`;

export const plugin: ToolPlugin<PresentShapeScriptData, unknown, PresentShapeScriptArgs> = {
  ...pluginCore,
  viewComponent: View,
  previewComponent: Preview,
  samples,
  systemPrompt: SYSTEM_PROMPT,
};

export type {
  PresentShapeScriptData,
  PresentShapeScriptArgs,
  PresentShapeScriptResult,
  PresentShapeScriptRenderedResult,
  PresentShapeScriptErrorResult,
  PresentShapeScriptExecutionResult,
  ShapeScriptDiagnostic,
} from "../core/types";

export { TOOL_NAME, TOOL_DEFINITION } from "../core/definition";
export { executePresentShapeScript, pluginCore } from "../core/plugin";
export { isShapeScriptDispatchArgs, readLoadShapeResult, readSaveShapeResult } from "../core/contract";
export type { ShapeScriptDispatchArgs } from "../core/contract";

export { samples } from "../core/samples";

export { View, Preview };

// Re-export ShapeScript utilities
export { parseShapeScript } from "../shapescript/parser";
export { astToThreeJS } from "../shapescript/toThreeJS";
export type { SceneNode } from "../shapescript/types";

export default { plugin };
