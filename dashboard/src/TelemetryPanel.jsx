import React, { useMemo } from 'react';
import { Activity, AlertTriangle, Zap, Target, CheckCircle } from 'lucide-react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function TelemetryPanel({ simData, loadHistory, activeScenario, faultTarget, onOpenMaintenance, autoPilot }) {

  // Generate some "historical baseline" points for the characteristic curve
  // Extend the baseline to cover high-power zones (up to ~2000kW)
  const historicalData = useMemo(() => {
    const data = [];
    for (let i = 0; i < 300; i++) {
      const co2 = 400 + Math.random() * 3000; // up to 3400 ppm
      const basePower = 200 + ((co2 - 400) * 0.5); 
      const actualPower = basePower + (Math.random() * 100 - 50); // wider scatter for realism
      data.push({ x: Math.round(co2), y: Number(actualPower.toFixed(1)) });
    }
    return data;
  }, []);

  // Map the live zones onto the curve with a dynamic thermodynamic relationship
  const currentData = useMemo(() => {
    return Object.values(simData.zones).map((z, idx) => {
      // Base the power on actual simulated load
      const yPower = z.load * 20; 
      
      // Calculate where this should lie on the ideal baseline X-axis
      // y = 200 + (x - 400) * 0.5  =>  x = 400 + (y - 200) * 2
      let idealX = 400 + (yPower - 200) * 2;
      
      // If there's a fault (very high temp), make the node deviate wildly to the right of the baseline!
      if (z.temp > 28) {
         idealX += (z.temp - 28) * 100;
      }
      
      return {
        name: z.label,
        x: Math.round(Math.max(400, idealX)),
        y: Number(yPower.toFixed(1))
      };
    });
  }, [simData]);

  // Insights Data logic
  const isFault = activeScenario === 'fault';
  const faultZoneId = isFault ? faultTarget : null;
  const faultZone = faultZoneId ? simData.zones[faultZoneId] : null;
  
  const unoccupiedWasting = Object.values(simData.zones).filter(z => z.occupancy === 0).slice(0, 1);
  const outOfBand = Object.values(simData.zones).filter(z => z.temp > z.setpoint + z.deadband && activeScenario !== 'fault');

  // Dynamic RCA based on zone type
  const getRCA = (zone) => {
    if (!zone) return { cause: 'Unknown error', blastRadius: 1, confidence: 0 };
    if (zone.type === 'server-room') {
      return { cause: 'CRAC unit compressor failure', blastRadius: 4, confidence: 96 };
    }
    if (zone.type === 'open-office') {
      return { cause: 'VAV box damper stuck closed', blastRadius: 2, confidence: 88 };
    }
    if (zone.type === 'perimeter') {
      return { cause: 'perimeter radiant heater stuck ON', blastRadius: 1, confidence: 85 };
    }
    return { cause: 'upstream chilled water valve failure', blastRadius: 3, confidence: 92 };
  };
  
  const rcaData = getRCA(faultZone);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '1rem' }}>
      
      {/* PRIMARY ANALYTICS: Characteristic Curve */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '300px' }}>
        <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--text-secondary)', letterSpacing: '1px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Activity size={12} color="var(--accent-blue)" /> THERMODYNAMIC CHARACTERISTIC (CO₂ vs POWER)
        </div>
        
        <div style={{ flex: 1, background: 'rgba(0,0,0,0.4)', borderRadius: '8px', padding: '12px', border: '1px solid var(--border-glass)' }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis type="number" dataKey="x" name="CO₂" unit=" ppm" domain={['auto', 'auto']} stroke="var(--text-secondary)" fontSize={10} tickMargin={8} />
              <YAxis type="number" dataKey="y" name="Power" unit=" kW" domain={['auto', 'auto']} stroke="var(--text-secondary)" fontSize={10} width={45} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: '#111', border: '1px solid var(--border-glass)' }} />
              <Scatter name="Historical Baseline" data={historicalData} fill="rgba(255,255,255,0.1)" isAnimationActive={false} />
              <Scatter name="Live Telemetry Node" data={currentData} fill="var(--accent-yellow)" isAnimationActive={false} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div style={{ display: 'flex', gap: '1rem', marginTop: '8px', paddingLeft: '40px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'rgba(255,255,255,0.3)' }} />
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Historical Baseline</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-yellow)' }} />
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Live Telemetry Node</span>
          </div>
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border-glass)' }} />

      {/* AI OPERATIONAL INSIGHTS (The "Why" and "What to do") */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--text-secondary)', letterSpacing: '1px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Zap size={12} color="var(--accent-blue)" /> AI OPERATIONAL INSIGHTS
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
          
          {/* Critical Fault Insight (Root Cause Analysis) */}
          {isFault && faultZone && (
            <div style={{ background: 'rgba(255,0,0,0.05)', border: '1px solid rgba(255,0,0,0.3)', borderRadius: '6px', padding: '12px' }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <AlertTriangle size={16} color="var(--accent-red)" style={{ marginTop: '2px', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--accent-red)', letterSpacing: '0.5px' }}>ROOT CAUSE ANALYSIS</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-primary)', marginTop: '4px', lineHeight: 1.4 }}>
                    Alerts in {faultZone.label} are likely caused by a single failure in the {rcaData.cause}. Blast radius spans {rcaData.blastRadius} dependent zones.
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                    <div style={{ height: '4px', width: `${rcaData.confidence}%`, background: 'var(--accent-green)', borderRadius: '2px' }} />
                    <span style={{ fontSize: '10px', color: 'var(--accent-green)' }}>{rcaData.confidence}% Confidence</span>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => onOpenMaintenance(faultZoneId)}
                style={{ width: '100%', background: 'rgba(255,0,0,0.15)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)', padding: '8px', fontSize: '10px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', letterSpacing: '1px', transition: '0.2s', marginTop: '4px' }}
                onMouseOver={e => e.target.style.background = 'var(--accent-red)'}
                onMouseOut={e => e.target.style.background = 'rgba(255,0,0,0.15)'}
              >
                VIEW PREDICTIVE MAINTENANCE
              </button>
            </div>
          )}

          {/* Optimization Insight (Auto-Pilot Aware) */}
          {unoccupiedWasting.map((z, i) => (
            <div key={i} style={{ background: autoPilot ? 'rgba(0,255,0,0.05)' : 'rgba(255,255,255,0.02)', border: autoPilot ? '1px solid rgba(0,255,0,0.2)' : '1px solid var(--border-glass)', borderRadius: '6px', padding: '12px' }}>
               <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <Zap size={16} color="var(--accent-green)" style={{ marginTop: '2px', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 'bold', color: autoPilot ? 'var(--accent-green)' : 'var(--text-primary)', letterSpacing: '0.5px' }}>
                    {autoPilot ? 'AUTONOMOUS ACTION' : 'SETPOINT OPTIMIZATION'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', lineHeight: 1.4 }}>
                    {z.label} has been unoccupied for 45m. Power draw remains at 100% baseline.
                    <div style={{ marginTop: '4px', color: 'var(--accent-green)' }}>
                      {autoPilot ? 'Auto-Adjusted setpoint to 26°C. Saving ~$12/day.' : 'Financial Impact: Wasting ~$12/day.'}
                    </div>
                  </div>
                </div>
              </div>
              {!autoPilot && (
                <button 
                  style={{ width: '100%', background: 'transparent', border: '1px solid var(--accent-green)', color: 'var(--accent-green)', padding: '6px', fontSize: '10px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', letterSpacing: '1px', marginTop: '4px' }}
                >
                  PREVIEW & APPLY SETBACK
                </button>
              )}
            </div>
          ))}

          {/* 1. Peak Load Shaving Insight */}
          {simData.buildingLoadMw > 3.0 && (
            <div style={{ background: autoPilot ? 'rgba(0,255,0,0.05)' : 'rgba(255,165,0,0.05)', border: autoPilot ? '1px solid rgba(0,255,0,0.2)' : '1px solid rgba(255,165,0,0.3)', borderRadius: '6px', padding: '12px' }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <Zap size={16} color={autoPilot ? "var(--accent-green)" : "orange"} style={{ marginTop: '2px', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 'bold', color: autoPilot ? 'var(--accent-green)' : 'orange', letterSpacing: '0.5px' }}>
                    {autoPilot ? 'AUTONOMOUS LOAD SHEDDING' : 'PEAK SHAVING OPPORTUNITY'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-primary)', marginTop: '4px', lineHeight: 1.4 }}>
                    Total building load ({simData.buildingLoadMw.toFixed(2)} MW) is approaching peak demand threshold.
                    <div style={{ marginTop: '4px', color: autoPilot ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
                      {autoPilot 
                        ? 'Auto-widened deadbands by 1°C in non-critical zones. Avoided Demand Charge: ~$450.' 
                        : 'Suggested: Widen deadbands by 1°C in non-critical zones. Avoided Demand Charge: ~$450.'}
                    </div>
                  </div>
                </div>
              </div>
              {!autoPilot && (
                <button 
                  style={{ width: '100%', background: 'transparent', border: '1px solid orange', color: 'orange', padding: '6px', fontSize: '10px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', letterSpacing: '1px', marginTop: '4px' }}
                >
                  PREVIEW & APPLY LOAD SHEDDING
                </button>
              )}
            </div>
          )}

          {/* 2. Thermal Comfort Anomaly Insight */}
          {outOfBand.map((z, i) => (
            <div key={`comfort-${i}`} style={{ background: autoPilot ? 'rgba(0,255,0,0.05)' : 'rgba(255,255,255,0.02)', border: autoPilot ? '1px solid rgba(0,255,0,0.2)' : '1px solid var(--border-glass)', borderRadius: '6px', padding: '12px' }}>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <Activity size={16} color={autoPilot ? "var(--accent-green)" : "var(--accent-yellow)"} style={{ marginTop: '2px', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 'bold', color: autoPilot ? 'var(--accent-green)' : 'var(--accent-yellow)', letterSpacing: '0.5px' }}>
                    {autoPilot ? 'AUTONOMOUS COMFORT CORRECTION' : 'THERMAL COMFORT ANOMALY'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', lineHeight: 1.4 }}>
                    {z.label} is currently {z.temp.toFixed(1)}°C (Limit: {(z.setpoint + z.deadband).toFixed(1)}°C). Occupant discomfort predicted.
                    <div style={{ marginTop: '4px', color: 'var(--accent-green)' }}>
                      {autoPilot ? 'Auto-Adjusted VAV flow +15% to restore comfort parameters.' : 'Suggested: Increase VAV flow +15%.'}
                    </div>
                  </div>
                </div>
              </div>
              {!autoPilot && (
                <button 
                  style={{ width: '100%', background: 'transparent', border: '1px solid var(--accent-yellow)', color: 'var(--accent-yellow)', padding: '6px', fontSize: '10px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', letterSpacing: '1px', marginTop: '4px' }}
                >
                  PREVIEW & INCREASE FLOW
                </button>
              )}
            </div>
          ))}

          {/* 3. Sensor Calibration Warning Insight */}
          {(!isFault) && (
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-glass)', borderRadius: '6px', padding: '12px' }}>
               <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <Target size={16} color="var(--text-secondary)" style={{ marginTop: '2px', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--text-secondary)', letterSpacing: '0.5px' }}>SENSOR DEGRADATION WARNING</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', lineHeight: 1.4 }}>
                    CO₂ sensor in L10 Core Lobby exhibits erratic variance (+/- 150ppm vs baseline). 
                    <div style={{ marginTop: '4px' }}>Impact: Minor control loop oscillation.</div>
                  </div>
                </div>
              </div>
              <button 
                style={{ width: '100%', background: 'transparent', border: '1px solid var(--text-secondary)', color: 'var(--text-secondary)', padding: '6px', fontSize: '10px', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', letterSpacing: '1px', marginTop: '4px' }}
              >
                DISPATCH CALIBRATION TICKET (LOW PRIORITY)
              </button>
            </div>
          )}

          {/* Nominal Status Fallback */}
          {!isFault && unoccupiedWasting.length === 0 && outOfBand.length === 0 && simData.buildingLoadMw <= 3.0 && (
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-glass)', borderRadius: '6px', padding: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
               <CheckCircle size={16} color="var(--text-secondary)" />
               <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>All thermodynamic characteristics are within optimal baseline variance.</span>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
