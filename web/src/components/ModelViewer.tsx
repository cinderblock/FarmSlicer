import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, TransformControls } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import * as THREE from "three";

// THREE.Clock deprecation comes from @react-three/fiber v9 internals.
// Tracked upstream: https://github.com/pmndrs/react-three-fiber/issues/3153
// Fixed in R3F v10 (not yet stable).
console.info(
  "[FarmSlicer] THREE.Clock deprecation warning below is from @react-three/fiber v9 internals.\n" +
    "Tracked: https://github.com/pmndrs/react-three-fiber/issues/3153",
);

type ArrangeMode = "view" | "translate" | "rotate";

const defaultMaterial = new THREE.MeshStandardMaterial({ color: "#4a9eff" });

function parseModel(data: ArrayBuffer, filename: string): THREE.Object3D {
  const ext = filename.toLowerCase().split(".").pop();

  if (ext === "stl") {
    const geo = new STLLoader().parse(data);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, defaultMaterial);
  }

  if (ext === "3mf") {
    const group = new ThreeMFLoader().parse(data);
    let hasMeshes = false;
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        hasMeshes = true;
        const mesh = child as THREE.Mesh;
        if (!mesh.material) mesh.material = defaultMaterial;
      }
    });
    if (!hasMeshes) throw new Error("3MF file contains no geometry");
    return group;
  }

  throw new Error(`Unsupported format: .${ext}`);
}

function placeOnBuildPlate(obj: THREE.Object3D) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  obj.position.set(
    obj.position.x - center.x,
    obj.position.y - box.min.y,
    obj.position.z - center.z,
  );
}

function dropToPlate(obj: THREE.Object3D) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box.min.y;
}

function BuildPlate() {
  return (
    <Grid
      args={[256, 256]}
      cellSize={10}
      cellThickness={0.5}
      cellColor="#404040"
      sectionSize={50}
      sectionThickness={1}
      sectionColor="#606060"
      fadeDistance={400}
      position={[0, -0.01, 0]}
    />
  );
}

function Scene({
  model,
  mode,
}: {
  model: THREE.Object3D | null;
  mode: ArrangeMode;
}) {
  const orbitRef = useRef<any>(null);
  const tcRef = useRef<any>(null);
  const [sceneObj, setSceneObj] = useState<THREE.Object3D | null>(null);
  const { raycaster, camera, pointer } = useThree();
  const dragPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    [],
  );
  const drag = useRef({ active: false, offset: new THREE.Vector3() });

  // TransformControls ↔ OrbitControls interlock
  useEffect(() => {
    const tc = tcRef.current;
    if (!tc) return;
    const cb = (e: { value: boolean }) => {
      if (orbitRef.current) orbitRef.current.enabled = !e.value;
    };
    tc.addEventListener("dragging-changed", cb);
    return () => tc.removeEventListener("dragging-changed", cb);
  }, [mode, sceneObj]);

  // Auto-drop to plate after rotation
  useEffect(() => {
    const tc = tcRef.current;
    if (!tc || mode !== "rotate" || !model) return;
    const onEnd = () => dropToPlate(model);
    tc.addEventListener("mouseUp", onEnd);
    return () => tc.removeEventListener("mouseUp", onEnd);
  }, [mode, model]);

  // Direct click-drag: pointer down on model starts XZ-plane drag
  const onPointerDown = useCallback(
    (e: any) => {
      if (mode !== "translate" || !model) return;
      e.stopPropagation();
      const hit = new THREE.Vector3();
      if (e.ray.intersectPlane(dragPlane, hit)) {
        drag.current.offset.subVectors(model.position, hit);
        drag.current.active = true;
        if (orbitRef.current) orbitRef.current.enabled = false;
      }
    },
    [mode, model, dragPlane],
  );

  // Frame-loop drag: follow pointer while dragging
  useFrame(() => {
    if (!drag.current.active || !model) return;
    raycaster.setFromCamera(pointer, camera);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, hit)) {
      model.position.x = hit.x + drag.current.offset.x;
      model.position.z = hit.z + drag.current.offset.z;
    }
  });

  // End drag on global pointer up
  useEffect(() => {
    const onUp = () => {
      if (drag.current.active) {
        drag.current.active = false;
        if (orbitRef.current) orbitRef.current.enabled = true;
      }
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, []);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[100, 100, 100]} intensity={1} />
      <directionalLight position={[-100, 50, -100]} intensity={0.3} />
      <BuildPlate />
      {model && (
        <primitive
          ref={setSceneObj}
          object={model}
          onPointerDown={mode === "translate" ? onPointerDown : undefined}
        />
      )}
      {sceneObj && mode !== "view" && (
        <TransformControls ref={tcRef} object={sceneObj} mode={mode} />
      )}
      <OrbitControls ref={orbitRef} makeDefault />
    </>
  );
}

export default function ModelViewer({
  onModelLoaded,
}: {
  onModelLoaded?: (file: File) => void;
}) {
  const [model, setModel] = useState<THREE.Object3D | null>(null);
  const [mode, setMode] = useState<ArrangeMode>("view");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFile = useCallback(
    (file: File) => {
      setError("");
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result;
        if (!data || !(data instanceof ArrayBuffer)) return;
        try {
          const obj = parseModel(data, file.name);
          placeOnBuildPlate(obj);
          setModel(obj);
          onModelLoaded?.(file);
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "Failed to load model",
          );
        }
      };
      reader.readAsArrayBuffer(file);
    },
    [onModelLoaded],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    },
    [loadFile],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!model) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      switch (e.key.toLowerCase()) {
        case "q":
          setMode("view");
          break;
        case "w":
          setMode("translate");
          break;
        case "e":
          setMode("rotate");
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [model]);

  return (
    <div
      className={`model-viewer ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.3mf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) loadFile(file);
        }}
      />

      {!model && (
        <div className="drop-prompt" onClick={() => inputRef.current?.click()}>
          <p>Drop a model file here or click to browse</p>
          <p className="hint">STL, 3MF</p>
          {error && (
            <p className="hint" style={{ color: "var(--error)" }}>
              {error}
            </p>
          )}
        </div>
      )}

      {model && (
        <div className="viewer-toolbar">
          <button
            className={mode === "view" ? "active" : ""}
            onClick={() => setMode("view")}
            title="View (Q)"
          >
            View
          </button>
          <button
            className={mode === "translate" ? "active" : ""}
            onClick={() => setMode("translate")}
            title="Move (W)"
          >
            Move
          </button>
          <button
            className={mode === "rotate" ? "active" : ""}
            onClick={() => setMode("rotate")}
            title="Rotate (E)"
          >
            Rotate
          </button>
          <span className="toolbar-sep" />
          <button
            onClick={() => model && dropToPlate(model)}
            title="Drop model to build plate"
          >
            Drop to Plate
          </button>
          <button
            onClick={() => inputRef.current?.click()}
            title="Load a different model"
          >
            Replace
          </button>
        </div>
      )}

      <Canvas camera={{ position: [150, 150, 150], fov: 50 }}>
        <Scene model={model} mode={mode} />
      </Canvas>
    </div>
  );
}
