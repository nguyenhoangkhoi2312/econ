import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import buildingData from './building-data.json';

// Curl noise helper
function makeNoise() {
  const fract = (v) => v - Math.floor(v);
  const hash = (x, y, z) => fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453);
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const valueNoise = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = smooth(xf), v = smooth(yf), w = smooth(zf);
    const c = (i, j, k) => hash(xi + i, yi + j, zi + k);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1; // [-1, 1]
  };

  // Compute curl noise by finite difference of a vector potential
  return (x, y, z) => {
    const e = 0.1;
    // Vector potential fields (using offset inputs to decorrelate)
    const p1 = (vx, vy, vz) => valueNoise(vx, vy, vz);
    const p2 = (vx, vy, vz) => valueNoise(vx + 43.2, vy + 12.3, vz + 9.8);
    const p3 = (vx, vy, vz) => valueNoise(vx - 23.4, vy + 41.5, vz - 17.6);

    const dP3dy = (p3(x, y + e, z) - p3(x, y - e, z)) / (2 * e);
    const dP2dz = (p2(x, y, z + e) - p2(x, y, z - e)) / (2 * e);
    
    const dP1dz = (p1(x, y, z + e) - p1(x, y, z - e)) / (2 * e);
    const dP3dx = (p3(x + e, y, z) - p3(x - e, y, z)) / (2 * e);

    const dP2dx = (p2(x + e, y, z) - p2(x - e, y, z)) / (2 * e);
    const dP1dy = (p1(x, y + e, z) - p1(x, y - e, z)) / (2 * e);

    return new THREE.Vector3(dP3dy - dP2dz, dP1dz - dP3dx, dP2dx - dP1dy);
  };
}

function pointInPolygon(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    let xi = poly[i][0] - 20, zi = 20 - poly[i][1];
    let xj = poly[j][0] - 20, zj = 20 - poly[j][1];
    let intersect = ((zi > pz) !== (zj > pz))
        && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export default function AirflowVectorField({ simState, activeFloor, selectedZone }) {
  const meshRef = useRef();
  const curlNoise = useMemo(() => makeNoise(), []);

  // 1. Determine bounding box for the target
  const { bounds, count, gridPositions, vavCentroids } = useMemo(() => {
    let targetZones = [];
    let floors = buildingData.floors;
    const floor = floors.find(f => f.level === activeFloor);
    if (!floor) return { count: 0 };
    
    if (selectedZone) {
      const z = floor.zones.find(z => z.zoneId === selectedZone);
      if (z) targetZones = [z];
    } else {
      targetZones = floor.zones;
    }

    if (targetZones.length === 0) return { count: 0 };

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    targetZones.forEach(z => {
      z.polygon.forEach(p => {
        const x = p[0] - 20;
        const zCoord = 20 - p[1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (zCoord < minZ) minZ = zCoord;
        if (zCoord > maxZ) maxZ = zCoord;
      });
    });

    const maxY = floor.height || 4;

    const resX = selectedZone ? 12 : 30;
    const resY = 5;
    const resZ = selectedZone ? 12 : 30;

    let validPositions = [];
    for (let x = 0; x < resX; x++) {
      for (let y = 0; y < resY; y++) {
        for (let z = 0; z < resZ; z++) {
          const px = minX + (x / (resX - 1)) * (maxX - minX);
          const py = 0.5 + (y / (resY - 1)) * (maxY - 1);
          const pz = minZ + (z / (resZ - 1)) * (maxZ - minZ);
          
          let insideAny = false;
          for (const zone of targetZones) {
             if (pointInPolygon(px, pz, zone.polygon)) {
                insideAny = true; 
                break;
             }
          }
          if (insideAny) {
             validPositions.push(px, py, pz);
          }
        }
      }
    }

    const count = validPositions.length / 3;
    const gridPositions = new Float32Array(validPositions);

    const vavCentroids = targetZones.map(z => ({
      x: z.centroid.x - 20,
      z: 20 - z.centroid.y,
      vavId: z.hvacMapping?.vavId,
      zoneId: z.zoneId,
      temp: simState?.zones?.[z.zoneId]?.temp || 24,
      setpoint: z.thermalProperties?.setpoint || 24,
      deadband: z.thermalProperties?.deadband || 2.0
    }));

    return { bounds: { minX, maxX, minZ, maxZ, maxY }, count, gridPositions, vavCentroids };
  }, [activeFloor, selectedZone, simState]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);

  useFrame((state) => {
    if (!meshRef.current || count === 0) return;
    const time = state.clock.elapsedTime * 0.5;

    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      const x = gridPositions[ix];
      const y = gridPositions[ix + 1];
      const z = gridPositions[ix + 2];

      const s = 0.15;
      const curl = curlNoise(x * s, y * s + time, z * s);
      
      let bias = new THREE.Vector3(0.5, -0.1, 0.5); // Natural cross-room supply -> return flow
      let closestVavDist = Infinity;
      let closestVav = null;

      vavCentroids.forEach(vav => {
        const dx = x - vav.x;
        const dz = z - vav.z;
        const dist = Math.sqrt(dx*dx + dz*dz);
        if (dist < closestVavDist) {
          closestVavDist = dist;
          closestVav = vav;
        }
      });

      if (closestVav && closestVavDist < 12) {
        // Strong jet from supply
        const dir = new THREE.Vector3(x - closestVav.x, -0.2, z - closestVav.z).normalize();
        bias.add(dir.multiplyScalar(Math.max(0, 2.0 - closestVavDist/6)));
      }

      curl.add(bias).normalize();

      // Speed is proportional to the curl magnitude before normalize, but we just use fixed length and color by temp deviation
      let speed = curl.length(); 

      dummy.position.set(x, y, z);
      
      // Orient arrow along velocity
      const target = new THREE.Vector3(x + curl.x, y + curl.y, z + curl.z);
      dummy.lookAt(target);
      dummy.rotateX(Math.PI / 2); // Cylinder points up by default

      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      // Color by temp deviation of closest VAV
      let deviation = 0;
      if (closestVav) {
        deviation = (closestVav.temp - closestVav.setpoint) / closestVav.deadband;
      }
      
      // Map deviation to cool(cyan) -> warm(orange/red)
      // Deviation 0 -> cyan (cool)
      // Deviation 1 -> yellow/orange
      // Deviation 1.5 -> red
      let r = THREE.MathUtils.clamp(deviation * 0.8 + 0.2, 0, 1);
      let g = THREE.MathUtils.clamp(1.0 - Math.abs(deviation), 0, 1);
      let b = THREE.MathUtils.clamp(1.0 - deviation, 0, 1);

      color.setRGB(r, g, b);
      meshRef.current.setColorAt(i, color);
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  if (count === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[null, null, count]} renderOrder={2}>
      <coneGeometry args={[0.25, 0.9, 8]} />
      <meshStandardMaterial transparent opacity={0.85} depthTest={false} depthWrite={false} />
    </instancedMesh>
  );
}
