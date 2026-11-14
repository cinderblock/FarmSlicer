// What the cut tool does (viewer/CutTool.tsx), and where its plane is.

import * as THREE from "three";
import { DEFAULT_CONNECTOR, type ConnectorSpec } from "../../model/cut";

export interface CutSettings {
  /** Height of the plane's centre above the plate (mm). */
  height: number;
  /** Tilt about the scene's X and Y axes (degrees). */
  tiltX: number;
  tiltY: number;
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
  keep: "both",
  layUpper: true,
  connector: DEFAULT_CONNECTOR,
  count: 0,
};

/** The plane's normal in the scene: up, tilted. */
export function cutNormal(s: CutSettings): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(s.tiltX))
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(s.tiltY));
}
