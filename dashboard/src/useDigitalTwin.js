import { useState, useEffect, useRef, useMemo } from 'react';
import * as flatbuffers from 'flatbuffers';
import { SimState } from './telemetry';
import buildingData from './building-data.json';

const INTEGRATION_BY_TYPE = {
  'server-room': 1.05,
  'corridor': 0.95,
  'lobby': 0.90,
  'mechanical': 0.85,
  'retail': 0.75,
  'conference': 0.70,
  'office': 0.55,
};

export const getInitialSimData = () => {
  const data = { scenario: 'peak', ahuPressure: 500, buildingLoadMw: 0, systemHealth: 100, totalOccupants: 0, vavs: {}, zones: {}, logs: [] };
  buildingData.floors.forEach(floor => {
    floor.zones.forEach(z => {
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
        archetype: z.zoneType === 'server-room' ? 'server_room' : 'office_dcv',
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

export function useDigitalTwin(onUpdate) {
  const [activeScenario, setActiveScenario] = useState('peak');
  const [autoPilot, setAutoPilot] = useState(true);
  const [faultTarget, setFaultTargetState] = useState('zone-server-lvl8');
  const faultTargetRef = useRef('zone-server-lvl8');
  
  const setFaultTarget = (v) => {
    setFaultTargetState(v);
    faultTargetRef.current = v;
  };
  
  const [loadHistory, setLoadHistory] = useState([]);
  
  const initialData = useMemo(() => getInitialSimData(), []);
  const [simData, setSimData] = useState(initialData);
  const simDataRef = useRef(initialData);
  const activeScenarioRef = useRef(activeScenario);
  const lastHistUpdateRef = useRef(0);
  const wsRef = useRef(null);

  const globalMetrics = useMemo(() => {
    if (!simData || !simData.zones) return { occupants: 0, avgTemp: 0, buildingLoadMw: 0, solarMw: 0, coolingLoadMw: 0, bessDischargeMw: 0, gridLoadMw: 0 };
    let occupants = 0;
    let tempSum = 0;
    let totalHeatGain = 0;
    const zones = Object.values(simData.zones);
    zones.forEach(z => {
      occupants += (z.occupancy || 0);
      tempSum += parseFloat(z.temp) || 24.0;
      totalHeatGain += (z.baseHeatGain || 0);
    });
    const bldgLoad = simData.buildingLoadMw || (totalHeatGain / 1000000) || 3.4;
    return {
      occupants,
      avgTemp: zones.length ? (tempSum / zones.length).toFixed(1) : 0,
      buildingLoadMw: bldgLoad,
      solarMw: bldgLoad * 0.12,        // ~12% solar contribution
      coolingLoadMw: bldgLoad * 0.45,   // ~45% goes to HVAC
      bessDischargeMw: bldgLoad * 0.08, // ~8% battery
      gridLoadMw: bldgLoad * 0.80,      // ~80% grid
    };
  }, [simData]);

  const loadScenario = (key, onFloorJump) => {
    const baseScenario = key.startsWith('fault:') ? 'fault' : key;
    setActiveScenario(baseScenario);
    activeScenarioRef.current = baseScenario;
    
    if (key.startsWith('fault:') && onFloorJump) {
      const zid = key.slice(6);
      const floor = buildingData.floors.find(f => f.zones.some(z => z.zoneId === zid));
      if (floor) {
        onFloorJump(floor.level, zid);
      }
    }
    
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(key);
    }
  };

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080/ws');
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const buf = new flatbuffers.ByteBuffer(new Uint8Array(event.data));
      const state = SimState.getRootAsSimState(buf);
      
      const prevData = simDataRef.current;
      const newSimData = { ...prevData, logs: [] }; // logs handled by TelemetryLogs directly or omitted here if not needed
      newSimData.zones = { ...prevData.zones };
      newSimData.vavs = { ...prevData.vavs };

      const zonesLen = state.zonesLength();
      for(let i = 0; i < zonesLen; i++) {
        const z = state.zones(i);
        const id = z.id();
        if (newSimData.zones[id]) {
            const temp = z.temp();
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
      
      if (onUpdate) {
        onUpdate(newSimData, activeScenarioRef.current);
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []); // eslint-disable-line

  return {
    simData,
    initialData,
    activeScenario,
    autoPilot,
    setAutoPilot,
    faultTarget,
    setFaultTarget,
    loadHistory,
    globalMetrics,
    loadScenario
  };
}
