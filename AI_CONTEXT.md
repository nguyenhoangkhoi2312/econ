# EcoSync: AI Agent Onboarding Context

This file contains the comprehensive technical context, architectural decisions, and physics logic required for any AI assistant (like Claude) to seamlessly onboard and continue development on the EcoSync Digital Twin project.

## 1. Project Overview & Architecture
EcoSync is a high-performance Digital Twin platform designed for massive commercial skyscrapers. It consists of two main components:
1. **Go Simulation Engine (`/server`)**: A stateful backend that runs a real-time thermodynamic simulation (30 FPS) and streams data.
2. **React/Vite Dashboard (`/dashboard`)**: A 3D WebGL visualization built with React Three Fiber, featuring a 2D P&ID topology map built with React Flow.

## 2. The Go Simulation Engine (`server/simulation/engine.go`)
The Go backend does **not** rely on historical data; it computes physics from first principles.
- **Thermodynamics (Lumped-Capacitance RC Network)**: Each thermal zone has a `Temp`, `Setpoint`, and `Deadband`. Heat transfer is calculated using Newton's Law of Cooling, balancing `Q_hvac` (cooling capacity from VAV) against `Q_internal` (heat from occupants/servers) and `Q_external` (weather).
- **Fluid Dynamics (Hardy Cross Method)**: `doHardyCross()` calculates airflow distribution. The AHU generates pressure (`PMax`), and each VAV has a `Resistance`. The airflow `Q` through a VAV is `sqrt(P/R)`. As VAV dampers modulate (resistance changes), the entire network pressure dynamically rebalances.
- **WebSocket Loop**: `main.go` runs an HTTP server on `:8080`. The `/ws` endpoint streams the simulation state to the frontend 30 times a second.

## 3. Telemetry Serialization (FlatBuffers)
To handle the immense data throughput, we bypass JSON for telemetry streaming.
- **Schema**: Defined in `server/data/telemetry.fbs`. It compiles into Go (`server/simulation/telemetry/`) and JavaScript (`dashboard/src/telemetry/`).
- **Flow**: The Go backend serializes the state (Zone Temps, VAV Flows) into a binary byte slice using FlatBuffers. The frontend receives the binary WebSocket payload, decodes it into a `Float32Array`, and updates the React state.

## 4. The 3D Frontend (`dashboard/src/BuildingModel.jsx`)
- **Procedural Generation**: The `building-data.json` file contains exact polygon coordinates for the floors. `<BuildingModel>` generates the 3D meshes dynamically using `THREE.ShapeGeometry` and `THREE.ExtrudeGeometry`.
- **Custom GLSL Shader**: The thermal heatmap is purely GPU-driven. A `ShaderMaterial` uses a `smoothstep` function to interpolate colors from Blue (Too Cold) -> Green (Optimal) -> Red (Too Hot) based on the `tempDeviation` uniform passed from the WebSocket state.
- **Exploded View**: The `useSpring` hook animates the Y-axis position of each floor group. When `explodedView` is true, the floors translate apart on the Y-axis for easy viewing.
- **Airflow Particles (`AirflowField.jsx`)**: Renders 1500 particles per floor using `THREE.Points`. A continuous `useFrame` loop modifies a `Float32Array` of positions using Simplex noise to simulate wind/HVAC airflow.

## 5. React Flow Topology (`dashboard/src/App.jsx`)
- **Realistic Spatial Layout**: The `buildTopologyFromSim` function generates nodes based on the physical `centroid.x` and `centroid.y` from `building-data.json`, scaled onto a 2D canvas to mimic the physical floorplan.
- **SVG Gradients**: The edge lines connecting the AHU to VAVs use `<linearGradient>` defined in an `<svg><defs>` block to smoothly transition colors.

## 6. Fault Injection & Scenarios
The UI can send text commands over the WebSocket to change the backend scenario:
- `"peak"`: Standard PID loops running.
- `"fault:zone-id"`: The backend overrides the target zone's VAV, hard-locking its resistance to 50.0 (damper closed). The room will undergo thermal runaway.
- `"remediating"`: The AI Auto-Pilot kicks in, routing maximum airflow (Resistance = 0.01) to the critical zones.

## 7. Next Steps (Enterprise Roadmap)
The immediate next phase is **Challenge 1: The Ontology-Ingestion Bridge**. We need to transition from hardcoded structural assumptions to a formal **Brick Schema** semantic graph. A script should generate `brick-ontology.json` defining `brick:feeds` relationships, and the React Flow map should traverse this graph to render the topology dynamically.

## 8. Directory Structure Cheat Sheet
- `server/preprocessing/generate_bim.js`: The Node script that procedurally generated the 15-story 135-zone building layout.
- `server/data/building-data.json`: The source of truth for the building geometry.
- `dashboard/src/App.jsx`: The main React layout, WebSocket handler, Micro-HUD UI, and React Flow topology logic.
- `dashboard/src/index.css`: Global styles, CSS animations (pulsing red faults), and glassmorphism UI variables.

## 9. Recent Features & Architectural Changes
- **AI Insights & Telemetry:** We successfully built the `TelemetryPanel.jsx` (AI Insights, dynamic Thermodynamic Characteristic scatter plot) and `TelemetryLogs.jsx` (live terminal output). The scatter plot now perfectly aligns high-power server rooms along an extended historical baseline and visibly animates anomalies off the curve.
- **Pending Mobile Viewer Architecture:** The user has requested a mobile browser-compatible viewer. We have proposed creating a separate entry point (`MobileApp.jsx` rendered via `Root.jsx` for viewports < 768px) rather than hacking CSS media queries into the complex desktop `App.jsx` layout. The proposal involves extracting the WASM WebSocket state logic from `App.jsx` into a shared `useDigitalTwin.js` hook to drive both desktop and mobile layouts simultaneously without duplicating code.
