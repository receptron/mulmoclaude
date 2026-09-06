<template>
  <div class="preview-container" data-testid="shapescript-preview">
    <div ref="previewViewport" class="preview-viewport" />
    <div class="preview-title">
      {{ displayTitle }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from "vue";
import * as THREE from "three";
import type { ToolResult } from "gui-chat-protocol";
import type { PresentShapeScriptData } from "../core/types";
import { parseShapeScript } from "../shapescript/parser";
import { astToThreeJS } from "../shapescript/toThreeJS";
import { removeAndDispose } from "../shapescript/dispose";
import { useT } from "../lang";

const props = defineProps<{
  result: ToolResult<PresentShapeScriptData>;
}>();

const t = useT();

const displayTitle = computed(() => {
  return props.result.title || t.value.untitled;
});

const previewViewport = ref<HTMLDivElement | null>(null);

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let animationId: number;
let sceneGroup: THREE.Group | null = null;

onMounted(() => {
  initPreview();
});

onUnmounted(() => {
  cleanup();
});

// Watch for script changes and reload the scene
watch(
  () => props.result.data?.script,
  () => {
    reloadScene();
  },
);

function initPreview() {
  if (!previewViewport.value) return;

  try {
    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2a3a);

    // Create camera
    const width = previewViewport.value.clientWidth || 200;
    const height = previewViewport.value.clientHeight || 150;

    camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(4, 4, 8);
    camera.lookAt(0, 0, 0);

    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    previewViewport.value.appendChild(renderer.domElement);

    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 5, 5);
    scene.add(directionalLight);

    // Parse and add ShapeScript objects
    if (!props.result.data?.script) return;
    const ast = parseShapeScript(props.result.data.script);
    sceneGroup = astToThreeJS(ast, { wireframe: false });
    scene.add(sceneGroup);

    // Start slow rotation animation
    animate();
  } catch (error) {
    console.error("Preview render error:", error);
  }
}

function animate() {
  animationId = requestAnimationFrame(animate);

  // Slowly rotate the camera around the scene
  const time = Date.now() * 0.0005;
  camera.position.x = Math.cos(time) * 8;
  camera.position.z = Math.sin(time) * 8;
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
}

function reloadScene() {
  if (!scene || !props.result.data?.script) return;

  try {
    // Remove old objects — and free them. `scene.remove` only drops the
    // reference; the GPU buffers live until each geometry / material is
    // disposed, and this runs again on every script change.
    removeAndDispose(scene, sceneGroup);
    sceneGroup = null;

    // Parse and create new objects
    const ast = parseShapeScript(props.result.data.script);
    sceneGroup = astToThreeJS(ast, { wireframe: false });
    scene.add(sceneGroup);
  } catch (error) {
    console.error("Preview reload error:", error);
  }
}

function cleanup() {
  if (animationId) {
    cancelAnimationFrame(animationId);
  }
  removeAndDispose(scene, sceneGroup);
  sceneGroup = null;
  if (renderer) {
    renderer.dispose();
  }
}
</script>

<style scoped>
.preview-container {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 150px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 8px;
  overflow: hidden;
}

.preview-viewport {
  width: 100%;
  height: 100%;
}

.preview-title {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0.5rem;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 0.75rem;
  font-weight: 500;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
