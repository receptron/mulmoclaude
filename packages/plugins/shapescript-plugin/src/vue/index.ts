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

## ShapeScript Language Features (FULL SUPPORT):

### Variables & Expressions:
- Define variables: define radius 2, define spacing 1.5
- Use expressions: position (i * 2) 0 0, size (radius * 1.5)
- Math operators: +, -, *, /, % with proper precedence
- Parentheses for grouping: (2 + 3) * 4

### Control Flow:

For loops with variables (use loop variable in calculations):
for i in 1 to 5 {
    cube { position (i * 2 - 6) 0 0 size 1 }
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

CRITICAL: Function calls require NO space between name and (
- sin(x) ✓ correct
- sin (x) ✗ wrong - this is NOT a function call!

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
        cube { position (x * 0.3) y (z * 0.3) size 0.2 }
    }
}

### Primitives & CSG:
Shapes: cube, sphere, cylinder, cone, torus
CSG: union, difference, intersection, xor, stencil
Properties: position, rotation, size, color, opacity

Keep visualizations clear, well-organized, and leverage the full power of expressions and control flow.`;

export const plugin: ToolPlugin<PresentShapeScriptData, unknown, PresentShapeScriptArgs> = {
  ...pluginCore,
  viewComponent: View,
  previewComponent: Preview,
  samples,
  systemPrompt: SYSTEM_PROMPT,
};

export type { PresentShapeScriptData, PresentShapeScriptArgs, PresentShapeScriptResult, PresentShapeScriptRenderedResult } from "../core/types";

export { TOOL_NAME, TOOL_DEFINITION } from "../core/definition";
export { executePresentShapeScript, pluginCore } from "../core/plugin";

export { samples } from "../core/samples";

export { View, Preview };

// Re-export ShapeScript utilities
export { parseShapeScript } from "../shapescript/parser";
export { astToThreeJS } from "../shapescript/toThreeJS";
export type { SceneNode } from "../shapescript/types";

export default { plugin };
