import * as THREE from "three";

// Three.js does not free GPU memory when an object leaves the scene graph:
// `scene.remove(group)` drops the reference, but every BufferGeometry, Material
// and Texture it owns keeps its WebGL buffers until `.dispose()` is called on
// each one. A View that re-parses on every script edit or wireframe toggle
// therefore leaks a whole scene's worth of buffers per rebuild, and enough
// rebuilds cost the tab its WebGL context ("Context Lost") with no error before
// it. Both surfaces rebuild on a watcher, so both need this.

/** The GPU-backed resources reachable from an object tree. Sharing is the whole
 *  reason this exists: `Object3D.clone()` shares geometry and material with its
 *  source, and `three-bvh-csg` hands the last operand straight back as the
 *  result when there is only one, so "dispose the operands" can free what the
 *  surviving object still draws with. */
interface Resources {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
}

function emptyResources(): Resources {
  return { geometries: new Set(), materials: new Set(), textures: new Set() };
}

function materialsOf(mesh: Partial<THREE.Mesh>): THREE.Material[] {
  const { material } = mesh;
  if (Array.isArray(material)) return material;
  return material instanceof THREE.Material ? [material] : [];
}

function collectInto(root: THREE.Object3D, into: Resources): Resources {
  root.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>;
    if (mesh.geometry instanceof THREE.BufferGeometry) into.geometries.add(mesh.geometry);
    for (const material of materialsOf(mesh)) {
      into.materials.add(material);
      // Textures are not walked by `Material.dispose()`, and the maps a
      // MeshStandardMaterial can carry are typed loosely — check each value
      // rather than naming every slot.
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) into.textures.add(value);
      }
    }
  });
  return into;
}

function disposeResources(resources: Resources, keep: Resources): void {
  for (const geometry of resources.geometries) if (!keep.geometries.has(geometry)) geometry.dispose();
  for (const texture of resources.textures) if (!keep.textures.has(texture)) texture.dispose();
  for (const material of resources.materials) if (!keep.materials.has(material)) material.dispose();
}

/** Release the GPU-side resources of `root` and everything under it. The object
 *  must already be detached (or about to be) — this does not touch parents. */
export function disposeObject3D(root: THREE.Object3D): void {
  disposeResources(collectInto(root, emptyResources()), emptyResources());
}

/** Free every object in `scratch` except the resources `keep` still draws with.
 *
 *  For intermediates that never reach the scene — the cloned meshes and Brushes
 *  a CSG block builds, and the operands each `evaluate()` consumes. Nothing
 *  disposes those otherwise, since scene teardown only walks what was added to
 *  the scene. `keep` is excluded by RESOURCE, not by identity, because the
 *  survivor routinely shares a geometry or material with a discarded operand. */
export function disposeScratch(scratch: readonly THREE.Object3D[], keep: THREE.Object3D): void {
  const kept = collectInto(keep, emptyResources());
  const discarded = emptyResources();
  for (const object of scratch) {
    if (object === keep) continue;
    collectInto(object, discarded);
  }
  disposeResources(discarded, kept);
}

/** Detach `root` from `parent` and free it. Safe with a null/undefined root so
 *  callers can hand over a ref that has not been filled in yet. */
export function removeAndDispose(parent: THREE.Object3D | undefined, root: THREE.Object3D | null | undefined): void {
  if (!root) return;
  parent?.remove(root);
  disposeObject3D(root);
}
