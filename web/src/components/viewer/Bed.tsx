// The build plate from the printer profile: plate, 10/50 mm grid clipped to
// its outline, the printable volume's edges and the slicer's origin.

import { useMemo } from "react";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { SceneBed } from "./part";

const GRID_MINOR = 10;
const GRID_MAJOR = 50;

/** Where the line x = c (or y = c) crosses the bed outline: [from, to] or null. */
function clip(polygon: THREE.Vector2[], c: number, vertical: boolean): [number, number] | null {
  const hits: number[] = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = vertical ? polygon[i] : new THREE.Vector2(polygon[i].y, polygon[i].x);
    const b = vertical ? polygon[j] : new THREE.Vector2(polygon[j].y, polygon[j].x);
    if (a.x === b.x || (c - a.x) * (c - b.x) > 0) continue;
    hits.push(a.y + ((c - a.x) / (b.x - a.x)) * (b.y - a.y));
  }
  if (hits.length < 2) return null;
  return [Math.min(...hits), Math.max(...hits)];
}

export default function Bed({ bed }: { bed: SceneBed }) {
  const { plate, minor, major, outline, volume, origin } = useMemo(() => {
    const plate = new THREE.ShapeGeometry(new THREE.Shape(bed.polygon));
    const minor: THREE.Vector3[] = [];
    const major: THREE.Vector3[] = [];
    // Grid lines at round slicer coordinates (scene = slicer - centre).
    for (const vertical of [true, false]) {
      const lo = vertical ? bed.min.x : bed.min.y;
      const hi = vertical ? bed.max.x : bed.max.y;
      const shift = vertical ? bed.center.x : bed.center.y;
      for (let s = Math.ceil((lo + shift) / GRID_MINOR) * GRID_MINOR; s <= hi + shift; s += GRID_MINOR) {
        const c = s - shift;
        const span = clip(bed.polygon, c, vertical);
        if (!span) continue;
        const list = s % GRID_MAJOR === 0 ? major : minor;
        list.push(
          vertical ? new THREE.Vector3(c, span[0], 0) : new THREE.Vector3(span[0], c, 0),
          vertical ? new THREE.Vector3(c, span[1], 0) : new THREE.Vector3(span[1], c, 0),
        );
      }
    }
    const outline = [...bed.polygon, bed.polygon[0]].map((p) => new THREE.Vector3(p.x, p.y, 0));
    const volume: THREE.Vector3[] = [];
    if (bed.height > 0) {
      for (let i = 0; i < bed.polygon.length; i++) {
        const a = bed.polygon[i];
        const b = bed.polygon[(i + 1) % bed.polygon.length];
        volume.push(new THREE.Vector3(a.x, a.y, bed.height), new THREE.Vector3(b.x, b.y, bed.height));
      }
      // Vertical edges only at a polygonal bed's corners, not every facet of a round one.
      if (bed.polygon.length <= 8)
        for (const p of bed.polygon) volume.push(new THREE.Vector3(p.x, p.y, 0), new THREE.Vector3(p.x, p.y, bed.height));
    }
    const origin = new THREE.Vector3(-bed.center.x, -bed.center.y, 0);
    return { plate, minor, major, outline, volume, origin };
  }, [bed]);

  const axis = Math.min(bed.max.x - bed.min.x, bed.max.y - bed.min.y) * 0.12;
  return (
    <group>
      <mesh geometry={plate} position={[0, 0, -0.05]} renderOrder={-1}>
        <meshStandardMaterial color="#1b222c" roughness={0.9} polygonOffset polygonOffsetFactor={1} />
      </mesh>
      {minor.length > 0 && <Line points={minor} segments color="#2a3442" lineWidth={1} />}
      {major.length > 0 && <Line points={major} segments color="#3b4859" lineWidth={1.2} />}
      <Line points={outline} color="#5d6f88" lineWidth={1.5} />
      {volume.length > 0 && <Line points={volume} segments color="#2f3b4d" lineWidth={1} transparent opacity={0.6} />}
      {/* The slicer's origin: X and Y axes like the desktop slicers draw them. */}
      <Line points={[origin, origin.clone().add(new THREE.Vector3(axis, 0, 0))]} color="#e5484d" lineWidth={2} />
      <Line points={[origin, origin.clone().add(new THREE.Vector3(0, axis, 0))]} color="#46a758" lineWidth={2} />
    </group>
  );
}
