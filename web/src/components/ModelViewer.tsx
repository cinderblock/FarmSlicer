import { useRef, useState, useCallback, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, TransformControls } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import * as THREE from "three";

// @react-three/fiber v9 uses THREE.Clock internally; no stable fix until v10
const _origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("THREE.Clock")) return;
  _origWarn.apply(console, args);
};

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
  const orbitRef = useRef<ReturnType<typeof OrbitControls> | null>(null);
  const tcRef = useRef<any>(null);

  useEffect(() => {
    const tc = tcRef.current;
    if (!tc) return;
    const onDrag = (e: { value: boolean }) => {
      if (orbitRef.current)
        (orbitRef.current as unknown as { enabled: boolean }).enabled =
          !e.value;
    };
    tc.addEventListener("dragging-changed", onDrag);
    return () => tc.removeEventListener("dragging-changed", onDrag);
  }, [mode, model]);

  useEffect(() => {
    const tc = tcRef.current;
    if (!tc || mode !== "rotate" || !model) return;
    const onEnd = () => dropToPlate(model);
    tc.addEventListener("mouseUp", onEnd);
    return () => tc.removeEventListener("mouseUp", onEnd);
  }, [mode, model]);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[100, 100, 100]} intensity={1} />
      <directionalLight position={[-100, 50, -100]} intensity={0.3} />
      <BuildPlate />
      {model &&
        (mode !== "view" ? (
          <TransformControls
            ref={tcRef}
            mode={mode}
            showY={mode === "rotate"}
          >
            <primitive object={model} />
          </TransformControls>
        ) : (
          <primitive object={model} />
        ))}
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
