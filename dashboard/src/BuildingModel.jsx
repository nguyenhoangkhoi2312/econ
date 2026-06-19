import React, { useRef, useMemo, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html, Edges } from '@react-three/drei';
import * as THREE from 'three';
import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg';
import buildingData from './building-data.json';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import AirflowVectorField from './AirflowVectorField';

// ========== CSG Helper (three-bvh-csg Evaluator/Brush API) ==========
// three-bvh-csg has no static `CSG` helper; it exposes an Evaluator that
// operates on Brush meshes whose world matrices define their placement.
const csgEvaluator = new Evaluator();
csgEvaluator.attributes = ['position', 'normal'];

function meshToBrush(mesh) {
  mesh.updateMatrix();
  const brush = new Brush(mesh.geometry);
  brush.position.copy(mesh.position);
  brush.quaternion.copy(mesh.quaternion);
  brush.scale.copy(mesh.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

// Subtract one or more tool meshes from a base mesh; returns baked geometry
// in the base mesh's transformed (world) space, matching the old CSG.toMesh.
function csgSubtract(baseMesh, toolMeshes) {
  if (!toolMeshes || toolMeshes.length === 0) {
    baseMesh.updateMatrix();
    return baseMesh.geometry.clone().applyMatrix4(baseMesh.matrix);
  }
  let result = meshToBrush(baseMesh);
  toolMeshes.forEach((tool) => {
    result = csgEvaluator.evaluate(result, meshToBrush(tool), SUBTRACTION);
  });
  let resultGeom = result.geometry;
  resultGeom = BufferGeometryUtils.mergeVertices(resultGeom, 1e-4);
  resultGeom.computeVertexNormals();
  return resultGeom;
}

// ========== Module-level CSG geometry cache ==========
// CSG is expensive and the tower has only ~5 distinct floor shapes across its
// 14 levels (the 8 typical-office floors are identical). Keying the result on a
// structural signature means each unique wall/plate runs CSG exactly once and
// the geometry is shared by every floor that matches — cutting initial CSG cost
// by ~3x. Geometries live for the app lifetime (bounded set), so no disposal is
// needed; the cache itself prevents the unbounded-leak case.
const _geometryCache = new Map();
function getCachedGeometry(signature, build) {
  let geom = _geometryCache.get(signature);
  if (!geom) {
    geom = build();
    _geometryCache.set(signature, geom);
  }
  return geom;
}

// ========== STEP 1: CSG-Based Wall with Window Cutouts ==========
function WallWithWindows({ position: [x, y, z], width, height, depth, rotation, windows = [], isActive, viewMode = 'hybrid' }) {
  const meshRef = useRef();
  
  const wallGeometry = useMemo(() => {
    const signature = `wall|${width}|${height}|${depth}|${JSON.stringify(windows)}`;
    return getCachedGeometry(signature, () => {
      const wallBox = new THREE.BoxGeometry(width, height, depth);
      wallBox.translate(0, height / 2, 0); // Bake the Y shift into the geometry directly!
      const wallMesh = new THREE.Mesh(wallBox);

      const windowMeshes = windows.map((window) => {
        const windowBox = new THREE.BoxGeometry(window.width, window.height, depth + 0.5);
        windowBox.translate(window.x, window.y, 0); // Bake local window pos into geometry!
        const windowMesh = new THREE.Mesh(windowBox);
        return windowMesh;
      });

      return csgSubtract(wallMesh, windowMeshes);
    });
  }, [width, height, depth, windows]);
  
  const isLogical = viewMode === 'logical';
  const opacity = isLogical ? 0.05 : (isActive ? 0.2 : 0.05);

  return (
    <mesh
      ref={meshRef}
      position={[x, y, z]}
      rotation={[0, -rotation, 0]}
      geometry={wallGeometry}
      dispose={null}
    >
      <meshStandardMaterial 
        color={isActive ? "#888888" : "#222222"}
        roughness={0.8}
        metalness={0.2}
        transparent={true}
        opacity={opacity}
        wireframe={isLogical && isActive}
      />
    </mesh>
  );
}

// ========== STEP 2: Exterior Walls Generator ==========
function ExteriorWalls({ floor, isActive, viewMode = 'hybrid' }) {
  const walls = useMemo(() => {
    const polygon = floor.geometry.exteriorPolygon;
    const wallSegments = [];
    
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i];
      const end = polygon[(i + 1) % polygon.length];
      
      // Convert from 2D coordinates [x, y] to 3D [x, 0, -z] centered around (20, 20)
      const sx = start[0] - 20;
      const sz = -start[1] + 20;
      const ex = end[0] - 20;
      const ez = -end[1] + 20;

      const width = Math.sqrt((ex - sx) ** 2 + (ez - sz) ** 2);
      const angle = Math.atan2(ez - sz, ex - sx);
      
      const windowSpacing = floor.floorType === 'typical-office' ? 4.0 : 6.0;
      const windows = [];
      let currentX = windowSpacing / 2;
      while (currentX < width - windowSpacing / 2) {
        windows.push({
          x: currentX - width / 2,
          y: 1.0 + (floor.height - 1.5) / 2, // Bottom sill at 1m from floor
          width: 2.0,
          height: floor.height - 1.5,
        });
        currentX += windowSpacing;
      }

      wallSegments.push({
        position: [(sx + ex) / 2, 0, (sz + ez) / 2],
        width,
        height: floor.height,
        depth: floor.geometry.wallThickness,
        rotation: angle,
        windows: windows,
      });
    }
    
    return wallSegments;
  }, [floor]);
  
  return (
    <group>
      {walls.map((wall, idx) => (
        <WallWithWindows
          key={`wall-${idx}`}
          position={wall.position}
          width={wall.width}
          height={wall.height}
          depth={wall.depth}
          rotation={wall.rotation}
          windows={wall.windows}
          isActive={isActive}
          viewMode={viewMode}
        />
      ))}
    </group>
  );
}

// ========== STEP 3: Floor Plate with Core Cutout ==========
function FloorPlate({ floor, isActive, onClick, simState, viewMode = 'hybrid' }) {
  const [hovered, setHovered] = useState(false);

  const hasAlert = useMemo(() => {
    if (!simState || !simState.zones) return false;
    return floor.zones.some(z => {
        const alertState = simState.zones[z.zoneId]?.alert;
        return alertState === true || alertState === 'REMEDIATING';
    });
  }, [floor.zones, simState]);

  const geometry = useMemo(() => {
    const g = floor.geometry;
    const signature = `plate_native|${JSON.stringify(g.exteriorPolygon)}|${JSON.stringify(g.corePolygon)}|${g.wallThickness}`;
    return getCachedGeometry(signature, () => {
      const exteriorShape = new THREE.Shape();
      g.exteriorPolygon.forEach((p, idx) => {
        if (idx === 0) exteriorShape.moveTo(p[0] - 20, p[1] - 20);
        else exteriorShape.lineTo(p[0] - 20, p[1] - 20);
      });
      exteriorShape.lineTo(g.exteriorPolygon[0][0] - 20, g.exteriorPolygon[0][1] - 20);

      // Natively subtract the core hole (No CSG needed, solves triangulation artifacts!)
      if (g.corePolygon && g.corePolygon.length > 0) {
        const corePath = new THREE.Path();
        g.corePolygon.forEach((p, idx) => {
          if (idx === 0) corePath.moveTo(p[0] - 20, p[1] - 20);
          else corePath.lineTo(p[0] - 20, p[1] - 20);
        });
        corePath.lineTo(g.corePolygon[0][0] - 20, g.corePolygon[0][1] - 20);
        exteriorShape.holes.push(corePath);
      }

      const exteriorGeom = new THREE.ExtrudeGeometry(exteriorShape, {
        depth: g.wallThickness,
        bevelEnabled: false,
      });
      
      // Bake rotation and Y shift into the geometry
      exteriorGeom.rotateX(-Math.PI / 2);
      exteriorGeom.translate(0, -g.wallThickness, 0);

      // Return perfectly indexed geometry to prevent EdgesGeometry from drawing internal diagonals
      return exteriorGeom;
    });
  }, [floor]);
  
  const isLogical = viewMode === 'logical';
  const baseOpacity = isLogical ? 0.05 : (isActive ? 0.4 : 0.3);
  const opacity = hasAlert ? 0.6 : (hovered ? 0.6 : baseOpacity);

  return (
    <group>
      <mesh
        geometry={geometry}
        dispose={null}
        onClick={(e) => { e.stopPropagation(); onClick(floor.level); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <meshStandardMaterial 
          color={hasAlert ? "#aa0000" : (isActive ? "#dddddd" : hovered ? "#555555" : "#333333")}
          roughness={0.9}
          transparent={true}
          opacity={opacity}
          polygonOffset={true}
          polygonOffsetFactor={2}
          wireframe={isLogical && isActive}
        />
        <Edges color={hasAlert ? "#ff0000" : (isActive ? "#ffffff" : hovered ? "#00ffff" : "#444444")} threshold={15} />
      </mesh>

      {/* Floating Live Data Label */}
      {(isActive || hovered || hasAlert) && (
        <Html position={[-25, floor.height / 2, 20]} center zIndexRange={[100, 0]} style={{ transition: 'all 0.2s', pointerEvents: 'none' }}>
          <div style={{ 
            color: hasAlert ? '#ff3333' : (isActive ? '#fff' : '#00ffff'), 
            background: hasAlert ? 'rgba(50,0,0,0.85)' : 'rgba(0,0,0,0.85)', 
            border: `1px solid ${hasAlert ? '#ff0000' : (isActive ? '#fff' : '#00ffff')}`, 
            padding: '6px 12px', fontSize: '11px', fontFamily: 'monospace', whiteSpace: 'nowrap', 
            textShadow: hasAlert ? '0 0 10px rgba(255,0,0,0.8)' : '0 0 5px rgba(0,229,255,0.5)',
            transform: hasAlert ? 'scale(1.1)' : 'scale(1)',
            transition: 'all 0.3s'
          }}>
            <strong style={{ fontSize: '12px' }}>{hasAlert ? '⚠️ ' : ''}[ L{floor.level} ]</strong><br/>
            {floor.name}<br/>
            <span style={{ color: hasAlert ? '#ff5555' : '#00e5ff' }}>
              {hasAlert ? 'CRITICAL FAULT' : `ZONES: ${floor.zones.length}`}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}

// ========== STEP 4: Zone Renderer with Thermal Heatmap ==========
function ZoneRenderer({ zone, isActive, simState, isHovered, onHover, isSelected, onSelect, viewMode = 'hybrid' }) {
  const meshRef = useRef();
  const zoneSim = simState.zones[zone.zoneId];
  const alertState = zoneSim?.alert;
  const temperature = zoneSim ? zoneSim.temp : zone.thermalProperties.setpoint;
  const setpoint = zone.thermalProperties.setpoint;
  const deadband = zone.thermalProperties.deadband;

  const thickness = 3.8;
  const cx = zone.centroid.x - 20;
  const cy = -(zone.centroid.y - 20);

  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    zone.polygon.forEach((p, idx) => {
      if (idx === 0) shape.moveTo(p[0] - 20, p[1] - 20);
      else shape.lineTo(p[0] - 20, p[1] - 20);
    });
    shape.lineTo(zone.polygon[0][0] - 20, zone.polygon[0][1] - 20);
    
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: thickness,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 3,
      curveSegments: 12,
    });

    geom.rotateX(-Math.PI / 2);
    geom.computeVertexNormals();
    return geom.toNonIndexed();
  }, [zone, thickness]);

  const isPhysical = viewMode === 'physical';

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        temperature: { value: temperature },
        setpoint: { value: setpoint },
        deadband: { value: deadband },
        opacity: { value: isActive ? (isHovered ? 0.9 : 0.65) : 0.15 },
        isPhysical: { value: isPhysical ? 1.0 : 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float temperature;
        uniform float setpoint;
        uniform float deadband;
        uniform float opacity;
        uniform float isPhysical;
        varying vec2 vUv;
        
        vec3 heatmap(float deviation) {
          float amount = clamp(deviation, -1.0, 3.0);
          vec3 cool = vec3(0.0, 0.5, 1.0);  // Blue
          vec3 good = vec3(0.0, 1.0, 0.0);  // Green
          vec3 warn = vec3(1.0, 1.0, 0.0);  // Yellow
          vec3 hot = vec3(1.0, 0.0, 0.0);   // Red
          
          if (amount < 0.0) return mix(good, cool, -amount);
          if (amount < 1.0) return mix(good, warn, amount);
          return mix(warn, hot, min(1.0, amount - 1.0));
        }
        
        void main() {
          float deviation = (temperature - setpoint) / deadband;
          vec3 heatColor = heatmap(deviation);
          vec3 physColor = vec3(0.2, 0.2, 0.2);
          vec3 finalColor = mix(heatColor, physColor, isPhysical);
          float finalOpacity = mix(opacity, opacity * 0.1, isPhysical);
          gl_FragColor = vec4(finalColor, finalOpacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }, [isActive, isHovered, isPhysical]);

  useFrame((state) => {
    if (material && material.uniforms.temperature) {
      const liveTemp = simState.zones[zone.zoneId]?.temp || setpoint;
      material.uniforms.temperature.value = THREE.MathUtils.lerp(
        material.uniforms.temperature.value,
        liveTemp,
        0.05
      );
      if (alertState === true) {
        material.uniforms.opacity.value = 0.65 + 0.3 * Math.sin(state.clock.elapsedTime * 8);
      } else {
        material.uniforms.opacity.value = isActive ? (isHovered ? 0.9 : 0.65) : 0.15;
      }
    }
  });

  return (
    <group position={[0, 0.01, 0]}>
      <mesh 
        ref={meshRef} 
        geometry={geometry}
        onClick={(e) => {
          if (isActive) {
            e.stopPropagation();
            onSelect(zone.zoneId);
          }
        }}
        onPointerOver={(e) => {
          if (isActive) {
            e.stopPropagation();
            onHover(zone.zoneId);
            document.body.style.cursor = 'pointer';
          }
        }}
        onPointerOut={(e) => {
          if (isActive) {
            onHover(null);
            document.body.style.cursor = 'auto';
          }
        }}
      >
        <primitive object={material} attach="material" />
        <Edges color={(isHovered || isSelected) && isActive ? "#ffffff" : (alertState === true ? "#ff0000" : "#222222")} threshold={15} />
      </mesh>

      {/* VIRTUAL IOT SENSORS (Only visible when drilled down into the room) */}
      {isActive && isSelected && (
        <group position={[cx, 1.5, cy]}>
          {/* Smart Thermostat */}
          <mesh position={[-1.5, 0, 0]}>
            <boxGeometry args={[0.3, 0.5, 0.1]} />
            <meshBasicMaterial color="#00e5ff" />
            <pointLight distance={3} intensity={0.5} color="#00e5ff" />
          </mesh>
          {/* Air Quality / CO2 Monitor */}
          <mesh position={[1.5, 0, 0]}>
            <boxGeometry args={[0.4, 0.3, 0.1]} />
            <meshBasicMaterial color="#00ff00" />
            <pointLight distance={3} intensity={0.5} color="#00ff00" />
          </mesh>
          {/* Ceiling Occupancy Camera */}
          <mesh position={[0, 2.0, 0]}>
            <sphereGeometry args={[0.2, 16, 16]} />
            <meshBasicMaterial color="#ff00ff" />
          </mesh>
        </group>
      )}

      {isActive && alertState && (
        <mesh position={[cx, 15, cy]}>
          <cylinderGeometry args={[1, 1, 30, 16]} />
          <meshBasicMaterial 
            color={alertState === 'REMEDIATING' ? "#ffff00" : "#ff0000"} 
            transparent 
            opacity={0.3} 
            blending={THREE.AdditiveBlending} 
            depthWrite={false} 
          />
        </mesh>
      )}
      
      {isActive && isHovered && (
        <Html position={[cx, 2.5, cy]} center zIndexRange={[100, 0]}>
          <div style={{
            background: 'rgba(0,0,0,0.8)',
            border: '1px solid #00e5ff',
            padding: '4px 8px',
            borderRadius: '4px',
            color: '#00e5ff',
            fontFamily: 'monospace',
            fontSize: '10px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap'
          }}>
            Asset: {zone.bim_asset_id}
          </div>
        </Html>
      )}
    </group>
  );
}

function DynamicControls({ targetX, targetY, targetZ, isZoomed }) {
  const controlsRef = useRef();
  const { camera } = useThree();
  
  useFrame(() => {
    if (controlsRef.current) {
      if (isZoomed) {
        controlsRef.current.target.lerp(new THREE.Vector3(targetX, targetY, targetZ), 0.06);
        camera.position.lerp(new THREE.Vector3(targetX + 8, targetY + 6, targetZ + 8), 0.06);
      } else {
        controlsRef.current.target.lerp(new THREE.Vector3(0, 15, 0), 0.06);
      }
      controlsRef.current.update();
    }
  });

  return <OrbitControls ref={controlsRef} />;
}

// ========== STEP 4.5: Physical Infrastructure Layer ==========
function InfrastructureLayer({ floor, viewMode }) {
  // Only render physical infrastructure in 'physical' or 'hybrid' modes
  // If 'logical', we might want to fade them, but user asked for semantic transparency:
  // "Physical mode: opaque geometry... Logical mode: geometry becomes semi-transparent or wireframed"
  const isLogical = viewMode === 'logical';
  const isHybrid = viewMode === 'hybrid';
  
  const opacity = isLogical ? 0.15 : (isHybrid ? 0.4 : 1.0);
  const wireframe = isLogical;

  return (
    <group position={[-20, 0.05, -20]}>
      {/* Procedural Server Racks in Server Rooms */}
      {floor.zones.filter(z => z.type === 'server_room').map(zone => {
        const racks = [];
        // Place a few racks based on zone centroid
        for(let i=0; i<4; i++) {
          racks.push(
            <mesh key={`rack-${i}`} position={[zone.centroid.x - 2 + i*1.2, 1, zone.centroid.y]}>
              <boxGeometry args={[0.8, 2, 1.2]} />
              <meshStandardMaterial color="#333355" transparent opacity={opacity} wireframe={wireframe} />
              {!isLogical && <Edges color="#111122" threshold={15} />}
            </mesh>
          );
        }
        return <group key={zone.zoneId}>{racks}</group>;
      })}

      {/* Procedural HVAC Main Trunk */}
      <mesh position={[20, 3.5, 20]}>
        <boxGeometry args={[30, 0.4, 0.8]} />
        <meshStandardMaterial color="#00e5ff" transparent opacity={opacity * 0.8} wireframe={wireframe} />
      </mesh>
      <mesh position={[20, 3.5, 20]}>
        <boxGeometry args={[0.8, 0.4, 20]} />
        <meshStandardMaterial color="#00e5ff" transparent opacity={opacity * 0.8} wireframe={wireframe} />
      </mesh>

      {/* Procedural Electrical Cable Trays */}
      <mesh position={[20, 3.2, 18]}>
        <boxGeometry args={[28, 0.1, 0.4]} />
        <meshStandardMaterial color="#ffaa00" transparent opacity={opacity} wireframe={wireframe} />
      </mesh>
    </group>
  );
}


export function SingleFloorLayout({ floor, isActive, simState, activeScenario, faultTarget, onFloorClick, selectedZone, setSelectedZone, hoveredZone, setHoveredZone, viewMode = 'hybrid' }) {
  return (
    <>
      <FloorPlate floor={floor} isActive={isActive} onClick={onFloorClick} simState={simState} viewMode={viewMode} />
      {isActive && <ExteriorWalls floor={floor} isActive={isActive} viewMode={viewMode} />}
      <group>
        {floor.zones.map((zone) => (
          <ZoneRenderer
            key={zone.zoneId}
            zone={zone}
            isActive={isActive}
            simState={simState}
            isHovered={hoveredZone === zone.zoneId}
            onHover={setHoveredZone}
            isSelected={selectedZone === zone.zoneId}
            onSelect={setSelectedZone}
            viewMode={viewMode}
          />
        ))}
      </group>
      {isActive && <InfrastructureLayer floor={floor} viewMode={viewMode} />}
    </>
  );
}

// ========== STEP 5: Complete Production Building Component ==========
export default function BuildingModel({ simState, activeFloor, onFloorClick, showAirflow, selectedZone, setSelectedZone, viewMode = 'hybrid' }) {
  const [hoveredZone, setHoveredZone] = useState(null);
  const floors = buildingData.floors;

  const targetCoords = useMemo(() => {
    if (!selectedZone) return { x: 0, y: 0, z: 0 };
    for (const f of floors) {
      const z = f.zones.find(zone => zone.zoneId === selectedZone);
      if (z) {
        let yOffset = f.level > activeFloor ? 30.0 : (f.level === activeFloor ? 5.0 : 0.0);
        return {
          x: z.centroid.x - 30,
          y: f.elevation + yOffset + 1.5,
          z: z.centroid.y - 20
        };
      }
    }
    return { x: 0, y: 0, z: 0 };
  }, [selectedZone, activeFloor, floors]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
      <Canvas camera={{ position: [50, 40, 50], fov: 45 }}>
        <color attach="background" args={['#000000']} />
        <ambientLight intensity={0.4} />
        <directionalLight position={[10, 20, 10]} intensity={1.2} />
        
        <DynamicControls 
          targetX={targetCoords.x} 
          targetY={targetCoords.y} 
          targetZ={targetCoords.z} 
          isZoomed={!!selectedZone} 
        />

        <group position={[-30, 0, -20]}>
          {floors.map((floor) => {
            const isActive = floor.level === activeFloor;
            
            let yOffset = 0;
            if (floor.level > activeFloor) {
                yOffset = 30.0;
            } else if (floor.level === activeFloor) {
                yOffset = 5.0;
            }

            const displayElevation = floor.elevation + yOffset;

            return (
              <group 
                key={`floor-${floor.level}`} 
                position={[0, displayElevation, 0]}
                onClick={(e) => {
                  e.stopPropagation();
                  onFloorClick(floor.level);
                }}
              >
                <SingleFloorLayout
                  floor={floor}
                  isActive={isActive}
                  simState={simState}
                  selectedZone={selectedZone}
                  setSelectedZone={setSelectedZone}
                  hoveredZone={hoveredZone}
                  setHoveredZone={setHoveredZone}
                  onFloorClick={onFloorClick}
                  viewMode={viewMode}
                />
              </group>
            );
          })}
        </group>
        
        <gridHelper args={[100, 100, '#333333', '#111111']} position={[0, -0.1, 0]} />
      </Canvas>
    </div>
  );
}
