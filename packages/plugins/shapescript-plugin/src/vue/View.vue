<template>
  <div class="present3d-container" data-testid="shapescript-view">
    <div class="header">
      <h1>{{ selectedResult.title || t.untitled }}</h1>
      <div class="controls">
        <button class="control-btn" @click="resetCamera">
          <span class="material-icons">refresh</span>
          {{ t.resetCamera }}
        </button>
        <button class="control-btn" @click="toggleWireframe">
          <span class="material-icons">{{ showWireframe ? "grid_off" : "grid_on" }}</span>
          {{ t.wireframe }}
        </button>
        <button class="control-btn" @click="toggleGrid">
          <span class="material-icons">{{ showGrid ? "visibility_off" : "visibility" }}</span>
          {{ t.grid }}
        </button>
        <!-- Disabled while the source panel holds unapplied edits: the export
             is built from the APPLIED script, which is also what the viewport
             renders, so a dirty editor would otherwise download a model the
             user is no longer looking at. -->
        <button class="control-btn" :disabled="!canExport" data-testid="shapescript-download-usdz" @click="downloadUsdz">
          <span class="material-icons">download</span>
          {{ t.downloadUsdz }}
        </button>
      </div>
    </div>

    <div v-if="parseError" class="error" data-testid="shapescript-parse-error">
      <strong>{{ t.parseError }}</strong> {{ parseError }}
    </div>

    <div v-if="saveError" class="error" data-testid="shapescript-save-error">
      <strong>{{ t.saveError }}</strong> {{ saveError }}
    </div>

    <div v-if="exportError" class="error" data-testid="shapescript-export-error">
      <strong>{{ t.exportError }}</strong> {{ exportError }}
    </div>

    <div v-if="sceneWarnings.length" class="notice" data-testid="shapescript-warnings">
      <strong>{{ t.sceneWarnings }}</strong> {{ sceneWarnings.join(" · ") }}
    </div>

    <pre
      v-if="printOutput.length"
      class="notice output"
      data-testid="shapescript-output"
    ><strong>{{ t.printOutput }}</strong> {{ printOutput.join("\n") }}</pre>

    <div ref="viewport" class="viewport" data-testid="shapescript-viewport" />

    <details class="script-source">
      <summary>{{ t.editSource }}</summary>
      <!-- `aria-label`, because the only visible text near this control is the
           <summary> that toggles the panel — a screen reader otherwise
           announces an unlabelled text area. -->
      <textarea v-model="editableScript" class="script-editor" spellcheck="false" :aria-label="t.scriptEditorLabel" @input="handleScriptEdit" />
      <button class="apply-btn" :disabled="!hasChanges" @click="applyScript">
        {{ t.applyChanges }}
      </button>
    </details>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useRuntime } from "gui-chat-protocol/vue";
import type { ToolResult } from "gui-chat-protocol";
import type { PresentShapeScriptData } from "../core/types";
import { readLoadShapeResult, readSaveShapeResult } from "../core/contract";
import { parseShapeScript } from "../shapescript/parser";
import { astToThreeJS, sceneInfoOf } from "../shapescript/toThreeJS";
import { removeAndDispose, disposeObject3D } from "../shapescript/dispose";
import { shapeScriptToUsdz, USDZ_EXTENSION, USDZ_MIME_TYPE } from "../export/usdz";
import { slugify } from "../core/paths";
import { useT } from "../lang";

interface CameraState {
  position?: { x: number; y: number; z: number };
  target?: { x: number; y: number; z: number };
}

/** `viewState` is rehydrated from a session's JSONL, which nothing validates on
 *  the way in: a legacy or hand-edited entry can carry a missing axis or a
 *  string. `camera.position.set(undefined, …)` yields NaN coordinates, and a
 *  NaN camera renders an empty viewport with no error to explain it. */
function readVec3(value: unknown): { x: number; y: number; z: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, z } = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return finite(x) && finite(y) && finite(z) ? { x, y, z } : null;
}

const props = defineProps<{
  selectedResult: ToolResult<PresentShapeScriptData>;
}>();

const emit = defineEmits<{
  updateResult: [result: ToolResult<PresentShapeScriptData>];
}>();

const t = useT();

const { dispatch } = useRuntime();

const editableScript = ref(props.selectedResult.data?.script ?? "");

// State
const viewport = ref<HTMLDivElement | null>(null);
const parseError = ref<string | null>(null);
/** Commands the script used that this viewer does not draw (`texture`, `camera`, …). */
const sceneWarnings = ref<string[]>([]);
/** The script's `print` lines. */
const printOutput = ref<string[]>([]);
const saveError = ref<string | null>(null);
const exportError = ref<string | null>(null);
const exporting = ref(false);
/** Bumped by every operation that establishes what the source now IS, so an
 *  older in-flight read can tell that it has been superseded. Not a ref: no
 *  template reads it, and reactivity would only invite a watcher. */
let sourceGeneration = 0;
const showWireframe = ref(false);
const showGrid = ref(true);

// Check if script has been modified
const hasChanges = computed(() => {
  return editableScript.value !== props.selectedResult.data?.script;
});

/** Download USDZ is offered only for a model there is something to export
 *  from: an applied, non-empty, valid script with no unapplied edits. An
 *  empty script is a valid way to clear the scene, but an empty USDZ helps
 *  nobody, so the button disables rather than clicking through to nothing
 *  (CodeRabbit on #3065). */
const canExport = computed(() => !exporting.value && !parseError.value && !hasChanges.value && Boolean(props.selectedResult.data?.script));

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let animationId: number;
let gridHelper: THREE.GridHelper;
let sceneObjects: THREE.Object3D[] = [];
let cameraChangeTimeout: number | null = null;
let resizeObserver: ResizeObserver | null = null;

// Lifecycle
onMounted(() => {
  initScene();
  loadShapeScript();
  animate();
  // Restore camera state after everything is initialized
  nextTick(() => {
    restoreCameraState();
  });
  void refreshFromDisk();
});

/** Re-read a file-backed source, so an edit made outside this view — by the
 *  agent, or in an editor — is what gets rendered rather than the copy frozen
 *  into the tool result when it was created. Only the drift case emits: an
 *  unchanged file must not rewrite conversation state on every open.
 *
 *  A failure is deliberately silent. The result already carries a renderable
 *  script, so the view works; raising a banner for a file the user did not
 *  just ask to save would report a problem they cannot act on. */
async function refreshFromDisk(): Promise<void> {
  const filePath = props.selectedResult.data?.filePath;
  if (!filePath) return;
  // The read is in flight while the user can still hit Apply. Without this
  // token a load that started BEFORE the save resolves after it, and the
  // pre-save script is emitted over the freshly-written one — the edit
  // silently reverts in the session (CodeRabbit on #3056).
  const token = ++sourceGeneration;
  try {
    const { script } = await dispatch({ kind: "loadShape", path: filePath }, readLoadShapeResult);
    // Superseded by an edit or an Apply while the read was in flight.
    if (token !== sourceGeneration) return;
    if (script === props.selectedResult.data?.script) return;
    editableScript.value = script;
    emit("updateResult", { ...props.selectedResult, data: { script, filePath } });
  } catch {
    // Keep the script the result carries.
  }
}

onUnmounted(() => {
  cleanup();
});

// Watch for script changes
watch(
  () => props.selectedResult.data?.script,
  () => {
    loadShapeScript();
  },
);

// Watch for wireframe toggle - reload scene with new setting
watch(showWireframe, () => {
  loadShapeScript();
});

// Watch for grid toggle
watch(showGrid, (value) => {
  if (gridHelper) {
    gridHelper.visible = value;
  }
});

// Methods
function initScene() {
  if (!viewport.value) return;

  // Create scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(DEFAULT_BACKGROUND);

  // Create camera
  const width = viewport.value.clientWidth;
  const height = viewport.value.clientHeight;
  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
  camera.position.set(5, 5, 10);
  camera.lookAt(0, 0, 0);

  // Create renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  viewport.value.appendChild(renderer.domElement);

  // Add controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Save camera state when user moves the camera
  controls.addEventListener("change", handleCameraChange);

  // Add lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(10, 10, 10);
  scene.add(directionalLight);

  // Add grid helper
  gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
  gridHelper.visible = showGrid.value;
  scene.add(gridHelper);

  // Handle window resize
  window.addEventListener("resize", handleResize);

  // Watch for viewport size changes (e.g., when details panel opens/closes)
  resizeObserver = new ResizeObserver(() => {
    handleResize();
  });
  resizeObserver.observe(viewport.value);
}

function handleResize() {
  if (!viewport.value) return;

  const width = viewport.value.clientWidth;
  const height = viewport.value.clientHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
}

// `scene.remove` only drops the reference; the GPU buffers live until each
// geometry and material is disposed, and this runs again on every script edit
// and wireframe toggle, so the leak ends in a lost WebGL context.
function clearScene() {
  sceneObjects.forEach((obj) => removeAndDispose(scene, obj));
  sceneObjects = [];
}

const DEFAULT_BACKGROUND = 0x1a1a1a;

function renderScript(script: string) {
  const group = astToThreeJS(parseShapeScript(script), { wireframe: showWireframe.value });
  scene.add(group);
  sceneObjects.push(group);
  const info = sceneInfoOf(group);
  sceneWarnings.value = info.warnings;
  printOutput.value = info.logs;
  // `background r g b` from the script, else the viewer's own dark ground.
  scene.background = info.background ? new THREE.Color(info.background[0], info.background[1], info.background[2]) : new THREE.Color(DEFAULT_BACKGROUND);
}

function loadShapeScript() {
  try {
    clearScene();
    sceneWarnings.value = [];
    printOutput.value = [];
    const script = props.selectedResult.data?.script;
    // An empty script is valid and clears the scene — reached when a result
    // moves from an INVALID script to an empty one, where leaving the previous
    // error on screen described geometry that is no longer there.
    if (script) renderScript(script);
    parseError.value = null;
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : "Unknown error";
    console.error("ShapeScript parse error:", error);
  }
}

function animate() {
  animationId = requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function resetCamera() {
  camera.position.set(5, 5, 10);
  camera.lookAt(0, 0, 0);
  controls.reset();
}

function restoreCameraState() {
  if (!camera || !controls) {
    return;
  }

  if (!props.selectedResult?.viewState?.cameraState) {
    return;
  }

  const state = props.selectedResult.viewState.cameraState as CameraState;

  const position = readVec3(state.position);
  if (position) {
    camera.position.set(position.x, position.y, position.z);
  }

  const target = readVec3(state.target);
  if (target) {
    controls.target.set(target.x, target.y, target.z);
  }

  camera.updateProjectionMatrix();
  controls.update();
}

function saveCameraState() {
  const cameraState = {
    position: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    },
    target: {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    },
  };

  return cameraState;
}

function handleCameraChange() {
  // Debounce camera state updates to avoid excessive emits
  if (cameraChangeTimeout !== null) {
    clearTimeout(cameraChangeTimeout);
  }

  cameraChangeTimeout = window.setTimeout(() => {
    updateCameraState();
  }, 500); // Wait 500ms after user stops moving camera
}

function updateCameraState() {
  const updatedResult: ToolResult<PresentShapeScriptData> = {
    ...props.selectedResult,
    viewState: {
      // Spread first: `viewState` is a free-form bag, so replacing it outright
      // would drop whatever else the host or a future feature persisted there.
      ...props.selectedResult.viewState,
      cameraState: saveCameraState(),
    },
  };

  emit("updateResult", updatedResult);
}

/** How long the object URL outlives the click. The download is started
 *  asynchronously by the browser, and revoking the URL before it has opened
 *  the blob cancels it in some engines (codex on #3065); a minute is far past
 *  any such window and the blob is a few hundred kilobytes. */
const OBJECT_URL_REVOKE_DELAY_MS = 60_000;

/** Hand the browser a file to save. */
function triggerBlobDownload(bytes: Uint8Array<ArrayBuffer>, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: USDZ_MIME_TYPE }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
}

/** Build the USDZ in the browser from the script the viewport is rendering —
 *  the APPLIED one — with no round trip and no file layer, so it works on a
 *  host with neither. The button is disabled unless `canExport`, and this
 *  re-checks so a stale click cannot export a model that differs from the one
 *  on screen. The scene is rebuilt solid rather than reusing the on-screen
 *  objects, which may be wireframe. */
async function downloadUsdz() {
  const script = props.selectedResult.data?.script;
  if (!script || !canExport.value) return;
  exporting.value = true;
  exportError.value = null;
  try {
    const bytes = await shapeScriptToUsdz(script);
    triggerBlobDownload(bytes, `${slugify(props.selectedResult.title)}${USDZ_EXTENSION}`);
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : String(error);
  } finally {
    exporting.value = false;
  }
}

function toggleWireframe() {
  showWireframe.value = !showWireframe.value;
}

function toggleGrid() {
  showGrid.value = !showGrid.value;
}

function cleanup() {
  if (cameraChangeTimeout !== null) {
    clearTimeout(cameraChangeTimeout);
  }
  sceneObjects.forEach((obj) => removeAndDispose(scene, obj));
  sceneObjects = [];
  if (animationId) {
    cancelAnimationFrame(animationId);
  }
  if (renderer) {
    renderer.dispose();
  }
  if (controls) {
    controls.removeEventListener("change", handleCameraChange);
    controls.dispose();
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
  window.removeEventListener("resize", handleResize);
}

function handleScriptEdit() {
  // The edit itself is not applied — that is the Apply button's job. What this
  // does do is take ownership of the buffer: a `loadShape` started at mount can
  // still be in flight, and without invalidating it here the disk copy lands on
  // top of whatever the user has just typed (codex on #3056).
  sourceGeneration++;
}

async function applyScript() {
  const script = editableScript.value;
  try {
    // Run the same semantic/geometry validation as the tool before saving.
    disposeObject3D(astToThreeJS(parseShapeScript(script)));
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : "Invalid ShapeScript";
    console.error("Script validation failed:", error);
    return;
  }
  parseError.value = null;

  // Persist BEFORE updating the result: the file is the source of truth for a
  // file-backed model, so a result that advanced past a failed write would
  // render a script the next `loadShape` cannot find. A host with no file
  // layer leaves `filePath` unset and the result stays the only copy.
  const filePath = props.selectedResult.data?.filePath;
  const token = ++sourceGeneration;
  if (filePath) {
    try {
      await dispatch({ kind: "saveShape", path: filePath, script }, readSaveShapeResult);
    } catch (error) {
      saveError.value = error instanceof Error ? error.message : String(error);
      return;
    }
  }
  // Another apply (or a refresh) landed while this one was writing — that one
  // owns the result now.
  if (token !== sourceGeneration) return;
  saveError.value = null;

  // Update the result (preserve existing viewState); the watch re-renders.
  const updatedResult: ToolResult<PresentShapeScriptData> = {
    ...props.selectedResult,
    data: filePath ? { script, filePath } : { script },
  };
  emit("updateResult", updatedResult);
}

// Watch for external changes to selectedResult (when user clicks different result)
watch(
  () => props.selectedResult.data?.script,
  (newScript) => {
    // `undefined` means "no data yet" and keeps whatever is in the box; an
    // empty STRING is a valid script that cleared the scene, and leaving the
    // old source visible invited the user to re-apply what they just removed.
    if (newScript !== undefined) editableScript.value = newScript;
  },
);

// Watch for selectedResult changes to restore camera state
watch(
  () => props.selectedResult,
  () => {
    nextTick(() => {
      restoreCameraState();
    });
  },
);
</script>

<style scoped>
.present3d-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
  color: #ffffff;
}

.header {
  padding: 1rem;
  background: #2a2a2a;
  border-bottom: 1px solid #444;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
}

.controls {
  display: flex;
  gap: 0.5rem;
}

.control-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 1rem;
  background: #3a3a3a;
  color: #ffffff;
  border: 1px solid #555;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background 0.2s;
}

.control-btn:hover {
  background: #4a4a4a;
}

.control-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.control-btn:disabled:hover {
  background: #3a3a3a;
}

.control-btn .material-icons {
  font-size: 1.2rem;
}

.viewport {
  flex: 1;
  min-height: 0;
  position: relative;
}

.error {
  padding: 1rem;
  background: #ff000020;
  color: #ff6666;
  font-family: monospace;
  border-bottom: 1px solid #ff000040;
}

.notice {
  padding: 0.5rem 1rem;
  background: #ffaa0020;
  color: #e0b060;
  font-family: monospace;
  font-size: 0.85rem;
  border-bottom: 1px solid #ffaa0040;
}

.output {
  margin: 0;
  background: #ffffff10;
  color: #cccccc;
  white-space: pre-wrap;
}

.script-source {
  padding: 0.5rem;
  background: #00000040;
  border-top: 1px solid #444;
  font-family: monospace;
  font-size: 0.85rem;
}

.script-source summary {
  cursor: pointer;
  user-select: none;
  padding: 0.5rem;
  background: #2a2a2a;
  border-radius: 4px;
}

.script-source[open] summary {
  margin-bottom: 0.5rem;
}

.script-source summary:hover {
  background: #3a3a3a;
}

.script-editor {
  width: 100%;
  min-height: 150px;
  padding: 1rem;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #aaa;
  font-family: "Courier New", monospace;
  font-size: 0.9rem;
  resize: vertical;
  margin-bottom: 0.5rem;
}

.script-editor:focus {
  outline: none;
  border-color: #666;
  background: #222;
}

.apply-btn {
  padding: 0.5rem 1rem;
  background: #4caf50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background 0.2s;
}

.apply-btn:hover {
  background: #45a049;
}

.apply-btn:active {
  background: #3d8b40;
}

.apply-btn:disabled {
  background: #cccccc;
  color: #666666;
  cursor: not-allowed;
  opacity: 0.6;
}

.apply-btn:disabled:hover {
  background: #cccccc;
}
</style>
