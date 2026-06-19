import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Users, Wind, Box, Zap, AlertTriangle, Activity, Settings, Map, Camera, Cpu, Thermometer } from 'lucide-react';
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, applyEdgeChanges, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import BuildingModel, { SingleFloorLayout } from './BuildingModel';
import buildingData from './building-data.json';
import TelemetryPanel from './TelemetryPanel';
import GlobalMetricsPanel from './GlobalMetricsPanel';
import TelemetryLogs from './TelemetryLogs';
import MaintenanceDrawer from './MaintenanceDrawer';
import * as flatbuffers from 'flatbuffers';
import { SimState } from './telemetry';
import AirflowVectorField from './AirflowVectorField';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Canvas } from '@react-three/fiber';

const INTEGRATION_BY_TYPE = {
  'server-room': 1.05,
  'corridor': 0.95,
  'lobby': 0.90,
  'mechanical': 0.85,
  'retail': 0.75,
  'conference': 0.70,
  'office': 0.55,
};



const getInitialSimData = () => {
  const data = { scenario: 'peak', ahuPressure: 500, buildingLoadMw: 0, systemHealth: 100, totalOccupants: 0, vavs: {}, zones: {}, logs: [] };
  buildingData.floors.forEach(floor => {
    floor.zones.forEach(z => {
      // Use pre-calculated centroid from building-data.json if available
      let cx = 20, cy = 20;
      if (z.centroid) {
        cx = z.centroid.x;
        cy = z.centroid.y;
      }
      
      if (z.hvacMapping) {
        data.vavs[z.hvacMapping.vavId] = { id: z.hvacMapping.vavId, targetZone: z.zoneId, flow: 0 };
      }
      data.zones[z.zoneId] = {
        id: z.zoneId,
        level: floor.level,
        label: z.name,
        type: z.zoneType,
        bim_asset_id: z.bim_asset_id,
        temp: z.thermalProperties?.setpoint || 24.0,
        setpoint: z.thermalProperties?.setpoint || 24.0,
        deadband: z.thermalProperties?.deadband || 2.0,
        alert: false,
        occupancy: z.thermalProperties?.occupancy || (z.zoneType === 'server-room' ? 0 : Math.floor(Math.random() * 40) + 10),
        integration_score: INTEGRATION_BY_TYPE[z.zoneType] || 0.6,
        baseHeatGain: z.thermalProperties?.internalHeatLoad || 0,
        centroid: { x: cx, y: cy }
      };
    });
  });
  return data;
};

// --- P&ID ENGINEERING CUSTOM NODES ---
// Custom smoothstep implementation for heatmap color
const smoothstep = (min, max, value) => {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
};

const ThermalNode = ({ data, selected }) => {
  const setpoint = data.setpoint || 24.0;
  const deadband = data.deadband || 2.0;
  
  const deviation = (parseFloat(data.temp) - setpoint) / deadband;
  
  const rFloat = smoothstep(0.3, 1.0, deviation);
  const bFloat = smoothstep(0.3, 1.0, -deviation);
  const gFloat = 1.0 - Math.max(smoothstep(0.8, 1.5, deviation), smoothstep(0.8, 1.5, -deviation));

  const r = Math.round(rFloat * 255);
  const g = Math.round(gFloat * 255);
  const b = Math.round(bFloat * 255);

  const borderColor = `rgb(${r}, ${g}, ${b})`;
  const bgColor = `rgba(${r}, ${g}, ${b}, 0.1)`;

  return (
    <div className={`thermal-node ${selected ? 'selected' : ''} ${data.alert ? 'pulse-red-node' : ''}`} style={{ borderColor, backgroundColor: bgColor, transition: 'all 0.5s ease' }}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="thermal-label">{data.label}</div>
      <div className="thermal-value">{data.temp}°C</div>
      <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{data.occupancy} PAX</div>
      <div style={{ fontSize: '7px', color: 'var(--accent-blue)', opacity: 0.8, marginTop: '2px', wordBreak: 'break-all', fontFamily: 'monospace' }}>BIM: {data.bim_asset_id?.split('-')[0]}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
};

const AHUNode = ({ data, selected }) => (
  <div className={`node-ahu ${selected ? 'selected' : ''} ${data.status === 'FAULT' ? 'fault' : ''}`}>
    <div className="thermal-label" style={{ color: 'var(--accent-blue)' }}>{data.label}</div>
    <div className="thermal-value">SP: {data.pressure?.toFixed(0) || 500} Pa</div>
    <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>M: AUTO</div>
    <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
  </div>
);

const VAVNode = ({ data, selected }) => (
  <div className={`node-vav ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
    <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-primary)' }}>VAV</div>
    <div style={{ fontSize: '8px', color: 'var(--text-secondary)' }}>{data.flow.split(' ')[0]}</div>
    <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
  </div>
);

const FloorplanNode = ({ data }) => {
  return (
    <div style={{ width: 800, height: 600, pointerEvents: 'none', position: 'relative' }}>
      <svg width="100%" height="100%" viewBox="0 0 800 600" preserveAspectRatio="none">
        {data.zones && data.zones.map((z, i) => {
          const points = z.polygon.map(p => `${(p[0] - 30) * 22 + 400},${(p[1] - 20) * 22 + 300}`).join(' ');
          return <polygon key={i} points={points} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />;
        })}
      </svg>
    </div>
  );
};

const CameraNode = ({ selected }) => (
  <div className={`node-icon ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '4px', border: '1px solid var(--text-secondary)', borderRadius: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Camera size={12} color="var(--accent-blue)" />
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
  </div>
);

const SensorNode = ({ selected }) => (
  <div className={`node-icon ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '4px', border: '1px solid var(--accent-yellow)', borderRadius: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Thermometer size={12} color="var(--accent-yellow)" />
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
  </div>
);

const ElectricalPanelNode = ({ data, selected }) => (
  <div className={`node-panel ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '8px', border: '2px solid var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Zap size={16} color="var(--accent-red)" />
    <span style={{ fontSize: '8px', color: 'var(--text-primary)' }}>{data.label}</span>
    <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
  </div>
);

const CircuitNode = ({ selected }) => (
  <div className={`node-circuit ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '4px', border: '1px solid var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Cpu size={12} color="var(--accent-red)" />
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
    <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
  </div>
);

const nodeTypes = {
  zone: ThermalNode,
  ahu: AHUNode,
  vav: VAVNode,
  floorplan: FloorplanNode,
  camera: CameraNode,
  sensor: SensorNode,
  panel: ElectricalPanelNode,
  circuit: CircuitNode
};

const SCALE = 22; // Physical scaling multiplier

const buildTopologyFromSim = (simState, activeFloor, ontology) => {
  const nodes = [];
  const edges = [];

  const floorObj = buildingData.floors.find(f => f.level === activeFloor);
  const activeZonesData = floorObj ? floorObj.zones : [];

  const activeZones = Object.values(simState.zones)
    .filter(z => z.level === activeFloor);

  nodes.push({
    id: 'floorplan-bg', type: 'floorplan', position: { x: -400, y: -300 }, draggable: false,
    data: { zones: activeZonesData }, zIndex: -1
  });

  // AHU root, placed outside the North perimeter of the floor plan
  nodes.push({
    id: 'ahu-main', type: 'ahu', position: { x: -45, y: -25 * SCALE - 40 },
    data: { label: 'AHU-MAIN', status: simState.scenario === 'fault' ? 'FAULT' : 'NOMINAL', pressure: simState.ahuPressure }
  });

  const relationships = ontology ? ontology.relationships : [];
  
  // Electrical Panel for the floor
  const panelId = `panel-lvl${activeFloor}`;
  nodes.push({
    id: panelId, type: 'panel', position: { x: 250, y: -25 * SCALE - 40 },
    data: { label: `EP-L${activeFloor}` }
  });

  activeZones.forEach((z) => {
    // 1. Map physical 3D centroid coordinates to 2D React Flow canvas
    // Subtracting 30 (width/2) and 20 (depth/2) centers the building around 0,0
    const x = (z.centroid.x - 30) * SCALE;
    const y = (z.centroid.y - 20) * SCALE;

    const isServerFault = simState.scenario === 'fault' && z.type === 'server-room';
    const isRem = simState.scenario === 'remediating' && (z.type === 'server-room' || z.type === 'core');
    
    // 2. SVG Linear Gradient Vector Colors
    const gradientId = isServerFault ? 'flow-fault' : (isRem ? 'flow-rem' : 'flow-nominal');
    const markerColor = isServerFault ? 'var(--accent-red)' : (isRem ? 'var(--accent-yellow)' : 'var(--accent-green)');
    
    const edgeStyle = { stroke: `url(#${gradientId})`, strokeWidth: 2, strokeDasharray: isServerFault ? '4 4' : '5 5' };
    const markerEnd = { type: MarkerType.ArrowClosed, color: markerColor };
    const className = !isServerFault ? 'edge-flow-vector-fast' : 'edge-flow-vector';

    nodes.push({
      id: z.id, type: 'zone', position: { x: x - 60, y: y }, draggable: false,
      data: {
        label: z.label, temp: z.temp, setpoint: z.setpoint, deadband: z.deadband,
        occupancy: z.occupancy, alert: z.alert, integration_score: z.integration_score,
        bim_asset_id: z.bim_asset_id
      }
    });

    // Per-zone accessories: Camera, Sensor, Circuit
    const cameraId = `camera_${z.id}`;
    nodes.push({ id: cameraId, type: 'camera', position: { x: x + 60, y: y - 20 }, draggable: false, data: {} });
    edges.push({ id: `e-${z.id}-${cameraId}`, source: z.id, target: cameraId, style: { stroke: 'rgba(255,255,255,0.2)', strokeDasharray: '2 2' } });

    const sensorId = `sensor_temp_${z.id}`;
    nodes.push({ id: sensorId, type: 'sensor', position: { x: x + 60, y: y + 20 }, draggable: false, data: {} });
    edges.push({ id: `e-${z.id}-${sensorId}`, source: z.id, target: sensorId, style: { stroke: 'rgba(255,255,255,0.2)', strokeDasharray: '2 2' } });

    const circuitId = `circuit_${z.id}`;
    nodes.push({ id: circuitId, type: 'circuit', position: { x: x - 100, y: y + 20 }, draggable: false, data: {} });
    edges.push({ id: `e-${panelId}-${circuitId}`, source: panelId, target: circuitId, style: { stroke: 'var(--accent-red)', strokeWidth: 1.5 } });
    edges.push({ id: `e-${circuitId}-${z.id}`, source: circuitId, target: z.id, style: { stroke: 'var(--accent-red)', strokeWidth: 1.5 } });

    // 3. Topology mapping driven by Brick Schema semantic ontology!
    // Find what feeds this zone in the graph
    const feedsRel = relationships.find(r => r.target === z.id && r.predicate === 'brick:feeds' && r.source.startsWith('vav'));

    if (feedsRel) {
      const vavId = feedsRel.source;
      const v = simState.vavs[vavId];
      if (v) {
        // Draw the VAV node
        nodes.push({
          id: v.id, type: 'vav', position: { x: x - 15, y: y - 80 }, draggable: false,
          data: { label: v.id.toUpperCase(), flow: (v.flow || 0).toFixed(1) + ' m³/m' }
        });
        
        // Find what feeds the VAV (usually the AHU)
        const ahuRel = relationships.find(r => r.target === v.id && r.predicate === 'brick:feeds');
        const sourceAhu = ahuRel ? ahuRel.source : 'ahu-main';

        edges.push({ id: `e-${sourceAhu}-${v.id}`, source: sourceAhu, target: v.id, type: 'smoothstep', animated: true, className, style: edgeStyle, markerEnd, data: { isFlow: true } });
        edges.push({ id: `e-${v.id}-${z.id}`, source: v.id, target: z.id, type: 'smoothstep', animated: true, className, style: edgeStyle, markerEnd, data: { isFlow: true } });
      }
    } else {
      // Fallback if no relationship found
      edges.push({ id: `e-ahu-${z.id}`, source: 'ahu-main', target: z.id, type: 'smoothstep', animated: true, className, style: edgeStyle, markerEnd, data: { isFlow: true } });
    }
  });

  return { nodes, edges };
};



function App() {
  const [activeScenario, setActiveScenario] = useState('peak');
  const [autoPilot, setAutoPilot] = useState(true);
  const [activeFloor, setActiveFloor] = useState(6);
  const [selectedZone, setSelectedZone] = useState(null);
  const [faultTarget, setFaultTargetState] = useState('zone-server-lvl8');
  const faultTargetRef = useRef('zone-server-lvl8');
  
  const setFaultTarget = (v) => {
    setFaultTargetState(v);
    faultTargetRef.current = v;
  };
  const [showAiModal, setShowAiModal] = useState(false);
  const [panelSize, setPanelSize] = useState({ w: 600, h: 400 });
  const [activeLeftTab, setActiveLeftTab] = useState('ai');
  const [loadHistory, setLoadHistory] = useState([]);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [leftPanelSize, setLeftPanelSize] = useState({ w: 360 });
  const [showWindSim, setShowWindSim] = useState(true);
  const [windPanelSize, setWindPanelSize] = useState({ w: 400, h: 300 });
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [maintenanceTarget, setMaintenanceTarget] = useState(null);
  const [ontology, setOntology] = useState(null);
  const [viewMode, setViewMode] = useState('hybrid'); // 'physical' | 'hybrid' | 'logical'
  const ontologyRef = useRef(null); // fresh copy for the WebSocket handler's stale closure
  const lastHistUpdateRef = useRef(0);

  // Fetch Semantic Ontology on load
  useEffect(() => {
    fetch('http://localhost:8080/api/ontology')
      .then(res => res.json())
      .then(data => { setOntology(data); ontologyRef.current = data; })
      .catch(err => console.error("Failed to load Brick ontology:", err));
  }, []);

  // Initial topology
  const initialData = useMemo(() => getInitialSimData(), []);
  const initialTopo = useMemo(() => buildTopologyFromSim(initialData, 6, ontology), [initialData, ontology]);
  const [nodes, setNodes] = useState(initialTopo.nodes);
  const [edges, setEdges] = useState(initialTopo.edges);
  const [liveLogs, setLiveLogs] = useState([]);
  const [simData, setSimData] = useState(initialData);
  const wsRef = useRef(null);
  const logEndRef = useRef(null);
  const activeFloorRef = useRef(activeFloor);
  const activeScenarioRef = useRef(activeScenario);
  const simDataRef = useRef(initialData);

  const globalMetrics = useMemo(() => {
    if (!simData || !simData.zones) return { occupants: 0, avgTemp: 0 };
    let occupants = 0;
    let tempSum = 0;
    const zones = Object.values(simData.zones);
    zones.forEach(z => {
      occupants += (z.occupancy || 0);
      tempSum += parseFloat(z.temp) || 24.0;
    });
    return {
      occupants,
      avgTemp: zones.length ? (tempSum / zones.length).toFixed(1) : 0
    };
  }, [simData]);

  const selectedNode = nodes.find(n => n.selected);

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), []);
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);

  const loadScenario = (key) => {
    const baseScenario = key.startsWith('fault:') ? 'fault' : key;
    setActiveScenario(baseScenario);
    activeScenarioRef.current = baseScenario;
    // Jump the 3D view to the faulting zone's floor so the runaway is actually visible.
    if (key.startsWith('fault:')) {
      const zid = key.slice(6);
      const floor = buildingData.floors.find(f => f.zones.some(z => z.zoneId === zid));
      if (floor) {
        setActiveFloor(floor.level);
        setSelectedZone(zid);
      }
    }
    if (baseScenario === 'fault' && autoPilot) {
      setShowAiModal(true);
    } else {
      setShowAiModal(false);
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(key);
    }
  };

  const executeRemediation = () => {
    setShowAiModal(false);
    loadScenario('remediating');
    setTimeout(() => {
      loadScenario('peak');
    }, 8000);
  };

  // When activeFloor changes or ontology loads, completely rebuild the topology
  useEffect(() => {
    activeFloorRef.current = activeFloor;
    const topo = buildTopologyFromSim(simDataRef.current, activeFloor, ontology);
    setNodes(topo.nodes);
    setEdges(topo.edges);
  }, [activeFloor, ontology]);

  // Physics Engine Loop (WebSocket FlatBuffers Stream)
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080/ws');
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const buf = new flatbuffers.ByteBuffer(new Uint8Array(event.data));
      const state = SimState.getRootAsSimState(buf);
      
      const prevData = simDataRef.current;
      const newSimData = { ...prevData, logs: liveLogs };
      newSimData.zones = { ...prevData.zones };
      newSimData.vavs = { ...prevData.vavs };

      const zonesLen = state.zonesLength();
      for(let i = 0; i < zonesLen; i++) {
        const z = state.zones(i);
        const id = z.id();
        if (newSimData.zones[id]) {
            const temp = z.temp();
            const type = newSimData.zones[id].type || newSimData.zones[id].zoneType;
            let alert = false;
            const isFaultMode = activeScenarioRef.current === 'fault';
            const isRemediatingMode = activeScenarioRef.current === 'remediating';
            
            if (isFaultMode && id === faultTargetRef.current) {
                alert = true;
            } else if (isRemediatingMode && id === faultTargetRef.current) {
                alert = 'REMEDIATING';
            }
            newSimData.zones[id] = { ...newSimData.zones[id], temp, load: z.load(), alert };
        }
      }

      const vavsLen = state.vavsLength();
      for(let i = 0; i < vavsLen; i++) {
        const v = state.vavs(i);
        const id = v.id();
        if (newSimData.vavs[id]) {
            newSimData.vavs[id] = { ...newSimData.vavs[id], flow: v.airflow() };
        }
      }

      const g = state.global();
      if (g) {
        newSimData.buildingLoadMw = g.buildingLoadMw();
        
        // Force system health drop during faults for visual demonstration
        if (activeScenarioRef.current === 'fault') {
           newSimData.systemHealth = 68.4 + (Math.random() * 2);
        } else {
           newSimData.systemHealth = g.systemHealth();
        }
        
        newSimData.totalOccupants = g.totalOccupants();
        
        const nowMs = Date.now();
        if (nowMs - lastHistUpdateRef.current > 1000) {
          lastHistUpdateRef.current = nowMs;
          setLoadHistory(prev => {
            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            // Add a small pseudo-random walk / sensor noise to make the curves characteristic
            const pwrNoise = (Math.random() * 6 - 3); 
            const co2Noise = (Math.random() * 4 - 2);
            const pwrDraw = Number((g.buildingLoadMw() * 1000 + pwrNoise).toFixed(1));
            const avgCo2 = Math.round(400 + g.totalOccupants() * 0.85 + co2Noise);
            const newHist = [...prev, { time: timeStr, pwr: pwrDraw, co2: avgCo2 }];
            if (newHist.length > 60) newHist.shift();
            return newHist;
          });
        }
      }

      simDataRef.current = newSimData;
      setSimData(newSimData);

      // Carefully update React Flow nodes
      setNodes(nds => nds.map(n => {
        if (n.type === 'zone' && newSimData.zones[n.id]) {
            return { ...n, data: { ...n.data, temp: newSimData.zones[n.id].temp.toFixed(1), alert: newSimData.zones[n.id].alert } };
        }
        if (n.type === 'vav' && newSimData.vavs[n.id]) {
            return { ...n, data: { ...n.data, flow: newSimData.vavs[n.id].flow.toFixed(1) + ' m³/m' } };
        }
        if (n.type === 'ahu') {
            return { ...n, data: { ...n.data, pressure: newSimData.ahuPressure } };
        }
        return n;
      }));

      // Update edge styles without rebuilding the array
      setEdges(eds => eds.map(e => {
        if (!e.data?.isFlow) return e;

        const isFault = activeScenarioRef.current === 'fault';
        const isRem = activeScenarioRef.current === 'remediating';
        const gradientId = isFault ? 'flow-fault' : (isRem ? 'flow-rem' : 'flow-nominal');
        const markerColor = isFault ? 'var(--accent-red)' : (isRem ? 'var(--accent-yellow)' : 'var(--accent-green)');
        
        return {
           ...e,
           className: !isFault ? 'edge-flow-vector-fast' : 'edge-flow-vector',
           style: { ...e.style, stroke: `url(#${gradientId})`, strokeDasharray: isFault ? '4 4' : '5 5' },
           markerEnd: { type: MarkerType.ArrowClosed, color: markerColor }
        };
      }));
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveLogs]);

  const failingZone = (activeScenario === 'fault' || activeScenario === 'remediating') && faultTarget
    ? (simData.zones[faultTarget] || { label: faultTarget, temp: 0 }) 
    : Object.values(simData.zones).find(z => z.alert === true || z.alert === 'REMEDIATING') || { label: 'Unknown Zone', temp: 0 };

  return (
    <div className="hud-container">
      
      <div className="three-d-canvas-wrapper">
        <BuildingModel 
          simState={simData}
          activeFloor={activeFloor}
          onFloorClick={setActiveFloor}
          showAirflow={showWindSim}
          selectedZone={selectedZone}
          setSelectedZone={(zoneId) => {
            setSelectedZone(zoneId);
            setFaultTarget(zoneId);
          }}
          viewMode={viewMode}
        />
      </div>

      {/* AI INTERACTIVE MODAL (Non-blocking so user can watch the building fail) */}
      {showAiModal && (
        <div style={{ position: 'absolute', top: '24px', left: '24px', zIndex: 50 }}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--accent-red)', padding: '2rem', width: '450px', boxShadow: '0 10px 30px rgba(255,0,0,0.2)' }}>
            <h2 style={{ color: 'var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: 0 }}>
              <AlertTriangle size={24} /> ALARM DETECTED
            </h2>
            <p style={{ color: 'var(--text-primary)', lineHeight: 1.5, fontFamily: 'monospace' }}>
              ERR: THERMAL_RUNAWAY<br/>
              LOCATION: {failingZone ? failingZone.label : 'Unknown Zone'}<br/>
              ASSET: {failingZone ? failingZone.bim_asset_id : '---'}
            </p>
            <div style={{ background: '#000', padding: '1rem', margin: '1.5rem 0', border: '1px solid var(--border-glass)' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: '1px' }}>AI Override Recommendation</span>
              <p style={{ margin: '0.5rem 0 0 0', color: 'var(--text-secondary)', fontFamily: 'monospace', lineHeight: 1.4 }}>
                The system detects critical thermal runaway.<br/>
                Would you like AI Auto-Pilot to automatically alleviate the problem by routing 100% cooling capacity to {failingZone ? failingZone.label : 'this specific room'}?
              </p>
            </div>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button className="cmd-btn" onClick={() => setShowAiModal(false)}>IGNORE</button>
              <button className="cmd-btn active-fault" onClick={executeRemediation} style={{ background: 'var(--accent-red)' }}>EXECUTE RECOMMENDATION</button>
            </div>
          </div>
        </div>
      )}

      {/* LAYER 5: Micro-HUD for Drill-down */}
      {selectedZone && simData.zones[selectedZone] && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 40
        }}>
          {/* Cinematic Overlay gradient */}
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'radial-gradient(circle, transparent 30%, rgba(0,0,0,0.85) 100%)' }} />
          
          <div style={{
            position: 'absolute', top: '25%', right: '25%',
            background: 'rgba(10,10,10,0.95)', border: '1px solid var(--accent-blue)',
            padding: '1.5rem', borderRadius: '12px', width: '320px', pointerEvents: 'auto',
            boxShadow: '0 0 40px rgba(0, 163, 224, 0.15)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
              <h3 style={{ margin: 0, fontSize: '12px', color: 'var(--text-primary)', letterSpacing: '1px' }}>MICRO-TELEMETRY: {simData.zones[selectedZone].label.toUpperCase()}</h3>
              <button onClick={() => setSelectedZone(null)} style={{ background: 'transparent', border: '1px solid var(--accent-red)', borderRadius: '4px', padding: '4px 8px', color: 'var(--accent-red)', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold' }}>EXIT [X]</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}><Users size={14}/> Est. CO₂ Level</span>
                <span style={{ color: 'var(--accent-green)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                  {(simData.zones[selectedZone].occupancy * 15) + 400} ppm
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}><Activity size={14}/> Thermostat</span>
                <span style={{ color: 'var(--accent-blue)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                  {simData.zones[selectedZone].temp.toFixed(1)}°C / {simData.zones[selectedZone].setpoint.toFixed(1)}°C
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}><Zap size={14}/> Est. Cost Rate</span>
                <span style={{ color: 'var(--accent-yellow)', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '14px' }}>
                  ${(simData.zones[selectedZone].load * 0.12).toFixed(2)} / hr
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* LAYER 1: React Flow Topology in Bottom Right Corner */}
      <div 
        className="minimap-wrapper" 
        style={{ 
          position: 'absolute', width: panelSize.w, height: panelSize.h, bottom: '90px', right: '24px', padding: 0, overflow: 'visible', zIndex: 10
        }}
      >
        <div 
          className="resize-handle" 
          onPointerDown={(e) => {
            e.preventDefault();
            const startW = panelSize.w;
            const startH = panelSize.h;
            const startX = e.clientX;
            const startY = e.clientY;
            const onPointerMove = (moveEvent) => {
              const dx = startX - moveEvent.clientX;
              const dy = startY - moveEvent.clientY;
              setPanelSize({
                w: Math.max(360, Math.min(startW + dx, window.innerWidth * 0.9)),
                h: Math.max(260, Math.min(startH + dy, window.innerHeight * 0.9))
              });
            };
            const onPointerUp = () => {
              document.removeEventListener('pointermove', onPointerMove);
              document.removeEventListener('pointerup', onPointerUp);
            };
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
          }}
          style={{
            position: 'absolute', top: -10, left: -10, width: 20, height: 20, background: 'var(--accent-blue)', 
            cursor: 'nwse-resize', zIndex: 100, borderRadius: '50%', border: '2px solid #000'
          }} 
        />
        <div className="topology-panel" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', borderRadius: '12px', border: '1px solid var(--border-glass)', background: 'var(--bg-panel)' }}>
          <div className="panel-header" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, padding: '12px 16px', background: 'var(--bg-panel)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: 'var(--text-primary)', fontWeight: 'bold' }}>MAP LEVEL {activeFloor} TOPOLOGY</span>
            
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <button 
                 onClick={() => setShowWindSim(!showWindSim)}
                 style={{ 
                   background: 'transparent', 
                   border: '1px solid var(--accent-blue)', 
                   color: 'var(--accent-blue)', 
                   fontSize: '9px', 
                   padding: '4px 8px', 
                   cursor: 'pointer',
                   fontWeight: 'bold',
                   pointerEvents: 'auto'
                 }}
              >
                 {showWindSim ? '⏸ HIDE AIRFLOW' : '🌬 SHOW AIRFLOW'}
              </button>
              <span style={{ fontSize: '10px', color: 'var(--accent-blue)' }}>{nodes.length - 1} ACTIVE NODES</span>
            </div>
          </div>

          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(e, node) => {
              if (node.type === 'zone') setSelectedZone(node.id);
            }}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.1}
            maxZoom={1.5}
            translateExtent={[[-1600, -800], [1600, 800]]}
            nodesDraggable={false}
          >
            <Background gap={40} size={1} color="rgba(255,255,255,0.05)" />
            
            {/* SVG Defs for Airflow Vector Gradients */}
            <svg style={{ position: 'absolute', width: 0, height: 0 }}>
              <defs>
                <linearGradient id="flow-nominal" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#10b981" />
                </linearGradient>
                <linearGradient id="flow-fault" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#ef4444" />
                </linearGradient>
                <linearGradient id="flow-rem" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#eab308" />
                </linearGradient>
              </defs>
            </svg>
          </ReactFlow>
        </div>
      </div>

      {showWindSim && (
        <div 
          className="minimap-wrapper" 
          style={{ 
            position: 'absolute', width: windPanelSize.w, height: windPanelSize.h, bottom: `${90 + panelSize.h + 20}px`, right: '24px', padding: 0, overflow: 'visible', zIndex: 10
          }}
        >
          <div 
            className="resize-handle" 
            onPointerDown={(e) => {
              e.preventDefault();
              const startW = windPanelSize.w;
              const startH = windPanelSize.h;
              const startX = e.clientX;
              const startY = e.clientY;
              const onPointerMove = (moveEvent) => {
                const dx = startX - moveEvent.clientX;
                const dy = moveEvent.clientY - startY;
                setWindPanelSize({
                  w: Math.max(300, Math.min(startW + dx, window.innerWidth * 0.9)),
                  h: Math.max(200, Math.min(startH + dy, window.innerHeight * 0.9))
                });
              };
              const onPointerUp = () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
              };
              document.addEventListener('pointermove', onPointerMove);
              document.addEventListener('pointerup', onPointerUp);
            }}
            style={{
              position: 'absolute', bottom: -10, left: -10, width: 20, height: 20, background: 'var(--accent-blue)', 
              cursor: 'sw-resize', zIndex: 100, borderRadius: '50%', border: '2px solid #000'
            }} 
          />
          <div className="topology-panel" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', borderRadius: '12px', border: '1px solid var(--border-glass)', background: 'var(--bg-panel)' }}>
            <div className="panel-header" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, padding: '12px 16px', background: 'var(--bg-panel)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-primary)', fontWeight: 'bold' }}>3D AIRFLOW VECTOR FIELD</span>
              <button 
                 onClick={() => setShowWindSim(false)}
                 style={{ 
                   background: 'transparent', border: '1px solid var(--accent-blue)', color: 'var(--accent-blue)', 
                   fontSize: '9px', padding: '4px 8px', cursor: 'pointer', fontWeight: 'bold', pointerEvents: 'auto'
                 }}
              >
                 ⏸ HIDE
              </button>
            </div>
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'var(--bg-obsidian)' }}>
              <Canvas camera={{ position: [0, 40, 40], fov: 45 }}>
                <ambientLight intensity={0.5} />
                <directionalLight position={[10, 20, 10]} intensity={1} />
                <group position={[-10, -2, 0]}>
                  <SingleFloorLayout 
                    key={`minimap-layout-${activeFloor}`}
                    floor={buildingData.floors.find(f => f.level === activeFloor)} 
                    isActive={true} 
                    simState={simData}
                    selectedZone={selectedZone}
                    setSelectedZone={setSelectedZone}
                    hoveredZone={null}
                    setHoveredZone={() => {}}
                    onFloorClick={() => {}}
                  />
                  <AirflowVectorField simState={simData} activeFloor={activeFloor} selectedZone={selectedZone} />
                </group>
              </Canvas>
            </div>
          </div>
        </div>
      )}

      {/* LAYER 4: AI & TELEMETRY (Left Dock) */}
      <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem', zIndex: 50, display: 'flex', gap: '8px' }}>
        <button 
           onClick={() => setIsLeftPanelOpen(!isLeftPanelOpen)}
           style={{ 
             background: 'var(--bg-panel)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)', 
             padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px'
           }}
        >
           <Activity size={16} color="var(--accent-blue)" /> 
           <span style={{ fontSize: '10px', fontWeight: 'bold' }}>{isLeftPanelOpen ? 'HIDE INSIGHTS' : 'SHOW INSIGHTS'}</span>
        </button>
      </div>

      {isLeftPanelOpen && (
        <aside className="hud-dock-left" style={{ top: '4.5rem', height: 'calc(100vh - 6rem)', width: `${leftPanelSize.w}px`, overflow: 'visible', position: 'relative' }}>
          <div 
            className="resize-handle" 
            onPointerDown={(e) => {
              e.preventDefault();
              const startW = leftPanelSize.w;
              const startX = e.clientX;
              const onPointerMove = (moveEvent) => {
                const dx = moveEvent.clientX - startX;
                setLeftPanelSize({
                  w: Math.max(280, Math.min(startW + dx, window.innerWidth * 0.5)),
                });
              };
              const onPointerUp = () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
              };
              document.addEventListener('pointermove', onPointerMove);
              document.addEventListener('pointerup', onPointerUp);
            }}
            style={{
              position: 'absolute', top: '50%', right: -10, transform: 'translateY(-50%)', width: 20, height: 40, background: 'var(--accent-blue)', 
              cursor: 'ew-resize', zIndex: 100, borderRadius: '4px', border: '2px solid #000'
            }} 
          />
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: '4px', paddingBottom: '12px', borderBottom: '1px solid var(--border-glass)', marginBottom: '12px' }}>
              <button 
                onClick={() => setActiveLeftTab('ai')} 
                style={{ flex: 1, padding: '8px', background: activeLeftTab === 'ai' ? 'var(--accent-blue)' : 'rgba(255,255,255,0.05)', color: activeLeftTab === 'ai' ? '#000' : 'var(--text-secondary)', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', transition: '0.2s' }}
              >
                AI INSIGHTS
              </button>
              <button 
                onClick={() => setActiveLeftTab('logs')} 
                style={{ flex: 1, padding: '8px', background: activeLeftTab === 'logs' ? 'var(--accent-blue)' : 'rgba(255,255,255,0.05)', color: activeLeftTab === 'logs' ? '#000' : 'var(--text-secondary)', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', transition: '0.2s' }}
              >
                TELEMETRY LOGS
              </button>
            </div>
            
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {activeLeftTab === 'ai' ? (
                <TelemetryPanel 
                  simData={simData} 
                  loadHistory={loadHistory} 
                  activeScenario={activeScenario} 
                  faultTarget={faultTarget}
                  autoPilot={autoPilot}
                  onOpenMaintenance={(zid) => setMaintenanceTarget(zid)}
                />
              ) : (
                <TelemetryLogs simData={simData} />
              )}
            </div>
          </div>
        </aside>
      )}

      {maintenanceTarget && (
        <MaintenanceDrawer 
          zoneId={maintenanceTarget} 
          simData={simData} 
          onClose={() => setMaintenanceTarget(null)} 
        />
      )}

      {/* LAYER 2: Global Metrics (Right Dock) */}
      <GlobalMetricsPanel 
        simData={simData} 
        globalMetrics={globalMetrics} 
        loadHistory={loadHistory} 
        activeFloor={activeFloor} 
        selectedNode={selectedNode} 
      />

      {/* VIEW MODE TOGGLE (Floating Top Center-Left) */}
      <div style={{
        position: 'absolute',
        top: '1.5rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        display: 'flex', 
        gap: '4px', 
        background: 'rgba(0,0,0,0.6)', 
        padding: '4px', 
        borderRadius: '8px', 
        border: '1px solid var(--border-glass)',
        backdropFilter: 'blur(10px)'
      }}>
        <button 
          onClick={() => setViewMode('physical')}
          style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: viewMode === 'physical' ? 'var(--accent-blue)' : 'transparent', color: viewMode === 'physical' ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold' }}
        >
          PHYSICAL
        </button>
        <button 
          onClick={() => setViewMode('hybrid')}
          style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: viewMode === 'hybrid' ? 'var(--accent-blue)' : 'transparent', color: viewMode === 'hybrid' ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold' }}
        >
          HYBRID
        </button>
        <button 
          onClick={() => setViewMode('logical')}
          style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: viewMode === 'logical' ? 'var(--accent-blue)' : 'transparent', color: viewMode === 'logical' ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold' }}
        >
          LOGICAL
        </button>
      </div>

      {/* COMMAND BAR (Floating Bottom Center) */}
      <div className="hud-command-bar">
        <button 
          className={`cmd-btn ${activeScenario === 'peak' ? 'active-peak' : ''}`} 
          onClick={() => loadScenario('peak')}
        >
          <Zap size={16} /> Peak Load
        </button>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', background: 'rgba(0,0,0,0.3)', padding: '0 0.5rem', borderRadius: '12px' }}>
          <select 
            value={faultTarget}
            onChange={(e) => setFaultTarget(e.target.value)}
            style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', padding: '0.5rem', outline: 'none', fontFamily: 'Inter', fontSize: '12px', cursor: 'pointer' }}
          >
            <option value="zone-server-lvl8">L8 Server Room</option>
            <option value="zone-server-lvl12">L12 Server Room</option>
            <option value="zone-south-lvl3">L3 South Perimeter</option>
            <option value="zone-open-a-lvl6">L6 Open Office A</option>
            <option value="zone-core-lvl10">L10 Core Lobby</option>
          </select>
          <button 
            className={`cmd-btn ${activeScenario === 'fault' ? 'active-fault' : ''}`} 
            onClick={() => loadScenario(`fault:${faultTarget}`)}
            style={{ paddingLeft: '0.5rem' }}
          >
            <AlertTriangle size={16} /> Inject
          </button>
        </div>

        <button 
          className={`cmd-btn ${autoPilot ? 'active-auto' : ''}`} 
          onClick={() => setAutoPilot(!autoPilot)}
        >
          <Settings size={16} /> AI: {autoPilot ? 'ON' : 'OFF'}
        </button>
      </div>

    </div>
  );
}

export default App;
