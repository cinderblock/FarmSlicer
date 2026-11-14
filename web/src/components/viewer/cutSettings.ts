// What the cut tool does (viewer/CutTool.tsx), and where its plane is.

import * as THREE from "three";
import { DEFAULT_CONNECTOR, type ConnectorSpec } from "../../model/cut";

export interface CutSettings {
  /** Height of the plane's centre above the plate (mm). */
  height: number;
  /** Tilt about the scene's X and Y axes (degrees). */
  tiltX: number;
  tiltY: number;
  /** How far the plane is moved along its normal from that point (mm): a steep plane moves sideways with it. */
  shift: number;
  /** Which halves to keep. */
  keep: "both" | "upper" | "lower";
  /** Turn the upper half over onto its cut face. */
  layUpper: boolean;
  /** Connectors between the halves (none: count 0). */
  connector: ConnectorSpec;
  count: number;
}

export const DEFAULT_CUT: CutSettings = {
  height: 10,
  tiltX: 0,
  tiltY: 0,
  shift: 0,
  keep: "both",
  layUpper: true,
  connector: DEFAULT_CONNECTOR,
  count: 0,
};

/** The point the plane goes through, in the scene, for a part centred at (`x`, `y`). */
export function cutPivot(s: CutSettings, x: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, s.height).addScaledVector(cutNormal(s), s.shift);
}

/** The plane's normal in the scene: up, tilted. */
export function cutNormal(s: CutSettings): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(s.tiltX))
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(s.tiltY));
}
