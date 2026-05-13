import { useRef, useState, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, Center } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";

function StlModel({ geometry }: { geometry: THREE.BufferGeometry }) {
  return (
    <Center>
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#4a9eff" />
      </mesh>
    </Center>
  );
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

export default function ModelViewer({
  onModelLoaded,
}: {
  onModelLoaded?: (file: File) => void;
}) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result;
        if (!data || !(data instanceof ArrayBuffer)) return;

        if (file.name.toLowerCase().endsWith(".stl")) {
          const loader = new STLLoader();
          const geo = loader.parse(data);
          geo.computeVertexNormals();
          setGeometry(geo);
          onModelLoaded?.(file);
        }
      };
      reader.readAsArrayBuffer(file);
    },
    [onModelLoaded]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    },
    [loadFile]
  );

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
        accept=".stl,.3mf,.obj,.step"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) loadFile(file);
        }}
      />

      {!geometry && (
        <div className="drop-prompt" onClick={() => inputRef.current?.click()}>
          <p>Drop a model file here or click to browse</p>
          <p className="hint">STL, 3MF, OBJ, STEP</p>
        </div>
      )}

      <Canvas camera={{ position: [150, 150, 150], fov: 50 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[100, 100, 100]} intensity={1} />
        <directionalLight position={[-100, 50, -100]} intensity={0.3} />
        <BuildPlate />
        {geometry && <StlModel geometry={geometry} />}
        <OrbitControls makeDefault />
      </Canvas>
    </div>
  );
}
