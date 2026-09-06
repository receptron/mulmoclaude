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
| `.`           | `TOOL_NAME`, `TOOL_DEFINITION`, `executePresentShapeScript`, `pluginCore`, `samples`, `parseShapeScript`, `astToThreeJS` |
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

## ShapeScript language

- **Primitives**: `cube`, `sphere`, `cylinder`, `cone`, `torus`, `circle`, `square`, `polygon`
- **Properties**: `position X Y Z`, `rotation X Y Z`, `size X Y Z`, `color R G B` (0–1), `opacity`
- **CSG**: `union`, `difference`, `intersection`, `xor`, `stencil`
- **Builders**: `extrude`, `loft`, `lathe`, `fill`, `hull`
- **Variables & expressions**: `define`, arithmetic / comparison / boolean operators, parentheses
- **Control flow**: `for … in … to … step`, `if` / `else`, `switch` / `case`
- **Built-ins**: `round floor ceil abs sign sqrt pow min max`, `sin cos tan asin acos atan atan2`
  (radians), `dot cross length normalize sum`

A function call takes **no space** before its parenthesis: `sin(x)` is a call, `sin (x)` is not.

## Scripts

```bash
yarn build      # vite build + d.ts emit
yarn typecheck  # vue-tsc --noEmit
yarn lint
yarn test       # node:test — tool execute + parser + Three.js conversion
```
