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
      </div>
    </div>

    <div v-if="parseError" class="error" data-testid="shapescript-parse-error">
      <strong>{{ t.parseError }}</strong> {{ parseError }}
    </div>

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
import type { ToolResult } from "gui-chat-protocol";
import type { PresentShapeScriptData } from "../core/types";
import { parseShapeScript } from "../shapescript/parser";
import { astToThreeJS } from "../shapescript/toThreeJS";
import { removeAndDispose } from "../shapescript/dispose";
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

const editableScript = ref(props.selectedResult.data?.script ?? "");

// State
const viewport = ref<HTMLDivElement | null>(null);
const parseError = ref<string | null>(null);
const showWireframe = ref(false);
const showGrid = ref(true);

// Check if script has been modified
const hasChanges = computed(() => {
  return editableScript.value !== props.selectedResult.data?.script;
});

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
});

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
  scene.background = new THREE.Color(0x1a1a1a);

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

function loadShapeScript() {
  try {
    // Clear previous scene objects — and free them. `scene.remove` only drops
    // the reference; the GPU buffers live until each geometry / material is
    // disposed, and this runs again on every script edit and wireframe toggle,
    // so the leak ends in a lost WebGL context.
    sceneObjects.forEach((obj) => removeAndDispose(scene, obj));
    sceneObjects = [];

    // Parse ShapeScript into AST
    const script = props.selectedResult.data?.script;
    if (!script) return;
    const ast = parseShapeScript(script);

    // Convert AST to Three.js objects
    const group = astToThreeJS(ast, { wireframe: showWireframe.value });

    // Add to scene
    scene.add(group);
    sceneObjects.push(group);

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
  // Just update the local state, don't apply yet
  // User needs to click "Apply Changes" button
}

function applyScript() {
  try {
    // Try to parse the script first to validate it
    parseShapeScript(editableScript.value);

    // If parsing succeeds, update the result (preserve existing viewState)
    const updatedResult: ToolResult<PresentShapeScriptData> = {
      ...props.selectedResult,
      data: {
        script: editableScript.value,
      },
    };

    emit("updateResult", updatedResult);

    // The loadShapeScript will be called automatically via the watch
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : "Invalid ShapeScript";
    console.error("Script validation failed:", error);
  }
}

// Watch for external changes to selectedResult (when user clicks different result)
watch(
  () => props.selectedResult.data?.script,
  (newScript) => {
    if (newScript) editableScript.value = newScript;
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
