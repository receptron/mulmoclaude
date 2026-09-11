import * as THREE from "three";
import type { RGBA } from "./evaluator";

/** The value types that hold geometry, shared by the evaluator (members) and
 *  the converter (building and placing them). */

export type Point3 = [number, number, number];

/** A `polygon { point … }`, or one face of a mesh value. */
export interface PolygonValue {
  kind: "polygon";
  points: Point3[];
  /** Per-vertex colours when the polygon block set `color`; one per point. */
  colors?: RGBA[];
}

/** A shape used as a value. The geometry is in the shape's own frame, with
 *  the transform it was declared with already applied. */
export interface MeshValue {
  kind: "mesh";
  geometry: THREE.BufferGeometry;
  /** Kept when the mesh was built from polygons, so `.polygons` returns them
   *  in the order the script (or Euclid) produced them. */
  polygons?: PolygonValue[];
  name?: string;
}

/** `shape.bounds` / `polygon.bounds`. */
export interface BoundsValue {
  kind: "bounds";
  min: Point3;
  max: Point3;
}

/** A vertex of a polygon, from `polygon.points`. */
export interface PointValue {
  kind: "point";
  position: Point3;
  color?: RGBA;
}

export function boundsOf(points: readonly Point3[]): BoundsValue {
  const min: Point3 = [Infinity, Infinity, Infinity];
  const max: Point3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  return points.length ? { kind: "bounds", min, max } : { kind: "bounds", min: [0, 0, 0], max: [0, 0, 0] };
}

export function centerOf(points: readonly Point3[]): Point3 {
  const sum: Point3 = [0, 0, 0];
  for (const point of points) {
    sum[0] += point[0];
    sum[1] += point[1];
    sum[2] += point[2];
  }
  const n = Math.max(1, points.length);
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** Every triangle of a geometry as a polygon, in buffer order. */
export function trianglesOf(geometry: THREE.BufferGeometry): PolygonValue[] {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const count = index?.count ?? position.count;
  const triangles: PolygonValue[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const points = [0, 1, 2].map((j) => {
      const vertex = index ? index.getX(i + j) : i + j;
      return [position.getX(vertex), position.getY(vertex), position.getZ(vertex)] as Point3;
    });
    triangles.push({ kind: "polygon", points });
  }
  return triangles;
}

export function meshPolygons(mesh: MeshValue): PolygonValue[] {
  return mesh.polygons ?? trianglesOf(mesh.geometry);
}

export function meshPoints(mesh: MeshValue): Point3[] {
  const position = mesh.geometry.getAttribute("position");
  const points: Point3[] = [];
  for (let i = 0; i < position.count; i++) points.push([position.getX(i), position.getY(i), position.getZ(i)]);
  return points;
}

/** Signed volume of a closed triangle mesh. */
export function meshVolume(mesh: MeshValue): number {
  let volume = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const triangle of trianglesOf(mesh.geometry)) {
    a.fromArray(triangle.points[0]!);
    b.fromArray(triangle.points[1]!);
    c.fromArray(triangle.points[2]!);
    volume += a.dot(b.cross(c));
  }
  return Math.abs(volume) / 6;
}

/** Triangulate a planar polygon (convex or not) into index triples. */
export function triangulatePolygon(points: readonly Point3[]): [number, number, number][] {
  if (points.length < 3) return [];
  if (points.length === 3) return [[0, 1, 2]];
  // Newell's normal, then a 2D basis in the polygon's plane for ShapeUtils.
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    normal.x += (current[1] - next[1]) * (current[2] + next[2]);
    normal.y += (current[2] - next[2]) * (current[0] + next[0]);
    normal.z += (current[0] - next[0]) * (current[1] + next[1]);
  }
  if (normal.lengthSq() < 1e-18) return [];
  normal.normalize();
  const helper = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(normal, helper).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  const flat = points.map((point) => {
    const p = new THREE.Vector3().fromArray(point);
    return new THREE.Vector2(p.dot(u), p.dot(v));
  });
  return THREE.ShapeUtils.triangulateShape(flat, []).map(([a, b, c]) => [a!, b!, c!]);
}

/** Euclid's icosahedron, vertex for vertex and face for face, so that
 *  `icosphere.polygons` indexes the same way upstream's scripts expect. */
export function icosphereGeometry(radius: number, subdivisions: number): { geometry: THREE.BufferGeometry; polygons: PolygonValue[] } {
  const t = 1 + Math.sqrt(2) / 2;
  const raw: Point3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  // Euclid scales to the radius and pitches by atan(t); its pitch is the
  // negated X rotation in three's terms (see `rotationOf`).
  const frame = new THREE.Matrix4()
    .makeRotationX(-Math.atan(t))
    .multiply(new THREE.Matrix4().makeScale(1 / Math.sqrt(t * t + 1), 1 / Math.sqrt(t * t + 1), 1 / Math.sqrt(t * t + 1)));
  const v = raw.map((point) => new THREE.Vector3().fromArray(point).applyMatrix4(frame));
  const faces: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  let triangles: THREE.Vector3[][] = faces.map((face) => face.map((i) => v[i]!.clone()));
  for (let level = 0; level < subdivisions; level++) {
    triangles = triangles.flatMap(([a, b, c]) => {
      const ab = a!.clone().lerp(b!, 0.5);
      const bc = b!.clone().lerp(c!, 0.5);
      const ca = c!.clone().lerp(a!, 0.5);
      return [
        [a!, ab, ca],
        [ab, b!, bc],
        [bc, c!, ca],
        [ab, bc, ca],
      ];
    });
  }
  const polygons: PolygonValue[] = triangles.map((triangle) => ({
    kind: "polygon",
    points: triangle.map((point) => point.clone().normalize().multiplyScalar(radius).toArray() as Point3),
  }));
  return { geometry: geometryFromPolygons(polygons, false), polygons };
}

/** A flat-shaded, non-indexed geometry from polygons, with per-vertex
 *  colours when any polygon carries them. */
export function geometryFromPolygons(polygons: readonly PolygonValue[], withColors: boolean): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  for (const polygon of polygons) {
    for (const [a, b, c] of triangulatePolygon(polygon.points)) {
      for (const i of [a, b, c]) {
        positions.push(...polygon.points[i]!);
        uvs.push(0, 0);
        if (withColors) {
          const [r = 0.8, g = 0.8, b2 = 0.8] = polygon.colors?.[i] ?? polygon.colors?.[0] ?? [];
          colors.push(r, g, b2);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  if (withColors) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}
