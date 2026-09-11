// The HTML the headless browser renders a ShapeScript model in.
//
// The model is BUILT in node (the plugin's `astToThreeJS` runs headlessly — it
// only touches three.js data structures, never a GL context) and crosses into
// the page as `Object3D.toJSON()`. Only rasterisation happens here, so the page
// needs three.js itself and nothing else.
//
// three is IMPORTED rather than inlined: `three.module.js` re-exports
// `./three.core.js`, and a specifier relative to nothing cannot resolve in an
// inline module. The driver serves both files from node_modules on a fake
// origin it intercepts, so the page never touches the network.

/** One camera angle: where it sits on the sphere around the model, in degrees. */
export interface ViewAngle {
  /** Rotation around Y, from +Z toward +X. */
  azimuth: number;
  /** Rotation above the XZ plane. 90 looks straight down. */
  elevation: number;
  /** Caption drawn under the tile, so the reader knows which way they are looking. */
  label: string;
}

export interface RenderPageOptions {
  /** URL the driver serves `three.module.js` from. */
  threeUrl: string;
  /** `group.toJSON()` of the built model. */
  sceneJson: unknown;
  views: readonly ViewAngle[];
  /** Pixel size of ONE tile. The sheet is tiled to fit every view. */
  width: number;
  height: number;
  /** Multiplier on the auto-fit camera distance. >1 moves the camera closer. */
  zoom: number;
  projection: "perspective" | "orthographic";
}

/** Tile the views into the squarest grid that holds them (1→1x1, 2→2x1, 4→2x2). */
export function gridFor(count: number): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

/** The first half of the page's module script: parse the model, size the
 *  sheet, and light the scene. Split from `drawScript` only because one
 *  template literal of the whole browser program is unreadable. */
function sceneScript(threeUrl: string, config: string, grid: string): string {
  return `import { AmbientLight, Box3, Color, DirectionalLight, GridHelper, MathUtils, ObjectLoader, OrthographicCamera, PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer } from ${JSON.stringify(threeUrl)};

const config = ${config};
const { columns, rows } = ${grid};
const sheet = document.getElementById("sheet");
const context = sheet.getContext("2d");
sheet.width = config.width * columns;
sheet.height = config.height * rows;
context.fillStyle = "#ffffff";
context.fillRect(0, 0, sheet.width, sheet.height);

const model = new ObjectLoader().parse(config.scene);

// Framing is derived from the model's own bounding sphere, so one zoom value
// means the same thing for a 0.1-unit bead and a 500-unit building.
const bounds = new Box3().setFromObject(model);
const sphere = bounds.getBoundingSphere(new Sphere());
const radius = sphere.radius > 0 && isFinite(sphere.radius) ? sphere.radius : 1;

// An alpha buffer, so a translucent \`background r g b a\` blends over the sheet's white paper.
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
renderer.setPixelRatio(1);
renderer.setSize(config.width, config.height, false);
// The script's own \`background r g b [a]\` when it set one, else white paper.
const background = Array.isArray(model.userData?.background) ? model.userData.background : null;
if (background) renderer.setClearColor(new Color(background[0], background[1], background[2]), background[3] ?? 1);
else renderer.setClearColor(0xffffff, 1);

const scene = new Scene();
scene.add(model);
// A headlight plus fill and ambient: a single light leaves faces pointing away
// from it black, which reads as a hole rather than a surface.
const headlight = new DirectionalLight(0xffffff, 2.2);
const fill = new DirectionalLight(0xffffff, 0.8);
fill.position.set(-1, 0.5, -1);
scene.add(headlight, fill, new AmbientLight(0xffffff, 0.9));

// A ground grid gives absolute orientation — without it a symmetric model
// renders identically from several angles.
const floor = new GridHelper(radius * 4, 12, 0xc0c0c0, 0xe4e4e4);
floor.position.y = bounds.min.y;
scene.add(floor);
`;
}

/** The second half: frame each requested angle and draw it into the sheet. */
function drawScript(): string {
  return `
const aspect = config.width / config.height;
const distance = (radius * 3.2) / Math.max(config.zoom, 0.01);

function cameraFor(angle) {
  const phi = MathUtils.degToRad(90 - angle.elevation);
  const theta = MathUtils.degToRad(angle.azimuth);
  const eye = new Vector3().setFromSphericalCoords(distance, phi, theta).add(sphere.center);
  const far = distance + radius * 10;
  let camera;
  if (config.projection === "orthographic") {
    const halfHeight = (radius * 1.3) / Math.max(config.zoom, 0.01);
    camera = new OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.01, far);
  } else {
    camera = new PerspectiveCamera(35, aspect, Math.max(distance / 100, 0.01), far);
  }
  camera.position.copy(eye);
  camera.lookAt(sphere.center);
  return camera;
}

config.views.forEach((angle, index) => {
  const camera = cameraFor(angle);
  headlight.position.copy(camera.position);
  renderer.render(scene, camera);
  const x = (index % columns) * config.width;
  const y = Math.floor(index / columns) * config.height;
  context.drawImage(renderer.domElement, x, y);
  // Caption last, so it is never painted over by the next tile.
  context.font = "16px system-ui, sans-serif";
  context.fillStyle = "#111111";
  context.fillText(angle.label, x + 12, y + config.height - 12);
  context.strokeStyle = "#d0d0d0";
  context.strokeRect(x + 0.5, y + 0.5, config.width - 1, config.height - 1);
});

renderer.dispose();
window.__shapeSheet = sheet.toDataURL("image/png");`;
}

/** Assemble the page. `JSON.stringify` is the only interpolation into script
 *  context — the caller's numbers and labels never reach the page as code. */
export function buildRenderPage(options: RenderPageOptions): string {
  const { threeUrl, sceneJson, views, width, height, zoom, projection } = options;
  const config = JSON.stringify({ views, width, height, zoom, projection, scene: sceneJson });
  const script = `${sceneScript(threeUrl, config, JSON.stringify(gridFor(views.length)))}\n${drawScript()}`;
  return `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;background:#ffffff}</style>
<canvas id="sheet"></canvas>
<script type="module">
${script}
</script>`;
}
