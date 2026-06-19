# HANDOFF — EcoSync Digital Twin (Claude → Antigravity / Gemini Agent)

> You are taking over an in-progress session. Read this entire file before editing anything.
> The repo root for the app is `ecosync/`. Frontend = `ecosync/dashboard` (React + Vite + R3F + React Flow).
> Backend = `ecosync/server` (Go, runs in Docker, streams FlatBuffers over WebSocket on `:8080`).
> Companion context: `ecosync/AI_CONTEXT.md` (architecture overview). Read it too.

---

## 0. HOW TO USE THIS DOC
1. Read §1 (state) and §2 (hard facts) so you don't re-break solved things.
2. Respect §3 (boundaries) absolutely.
3. Implement §4 tasks A–E. They are ordered by the user's priority.
4. Verify with §5 after every task. Never claim "done" without the §5 evidence.
5. §6 is the user's intent in their own words — when in doubt, that wins.

---

## 1. WHERE I LEFT OFF (current state)

### Working & verified (do NOT redo, do NOT regress):
- **Backend live data**: Go thermo sim streams 135 zones over WS. Zones hold setpoint at nominal load (building is GREEN/healthy ~22 °C), `Inject Fault` heats server rooms (floors 4/8/12) to runaway.
- **Live HUD badges**: `Bldg Load` (MW), `Sys Health` (%), `Occupants` are computed live in Go `broadcast()` and read from the FlatBuffer `GlobalData` in `App.jsx` `onmessage`. Not hardcoded anymore.
- **Building sits on the grid**: `BuildingModel.jsx` building group is `position={[-30, 0, -20]}` (was `-20` on Y which sank it below the grid). Keep Y=0.
- **CSG geometry cache + `dispose={null}`** in `BuildingModel.jsx` (FloorPlate/WallWithWindows) — perf + React StrictMode safety. Keep.
- **Fault is visible**: `loadScenario('fault:<zoneId>')` auto-navigates the 3D view to the faulting zone's floor; the `ALARM DETECTED` modal names the failing room; floor plate goes red + shows `CRITICAL FAULT`.
- **Backend panic recovery**: `main.go` WS read loop wraps `engine.SetScenario` in a `recover()` so a bad command can never crash the whole backend again. Keep this.
- **Brick ontology now ships in the image**: `server/Dockerfile` was changed from `COPY data/building-data.json ./data/` to `COPY data/ ./data/`. `/api/ontology` returns 200.

### THE ONE OPEN BUG I was mid-fixing (likely SUPERSEDED by Task A, but be aware):
- In `App.jsx`, the React Flow topology renders the **nodes** (9 VAV + 9 zone + 1 AHU) but **0 edges** once the ontology loads. Symptom: `document.querySelectorAll('.react-flow__edge-path').length === 0`.
- Root-cause direction: `buildTopologyFromSim()` builds edges `AHU→VAV` and `VAV→zone` from `ontology.relationships` (`brick:feeds`). React Flow silently **drops any edge whose `source`/`target` id is not present in the `nodes` array at render time**. The `onmessage` handler rebuilds `edges` every frame (`setEdges`) AND maps `nodes` separately — there is a race / id-mismatch where edges reference node ids that aren't in the current `nodes` prop on that frame.
- I added `ontologyRef` (a `useRef` mirror of `ontology`) so the `onmessage` closure isn't stale; that alone did NOT fix it. If you keep the current node-graph approach, the real fix is: **build nodes and edges together from one source of truth, and only update node *data* (temps/flows) + edge *style* in `onmessage` — never rebuild the node/edge *structure* on the 30 fps stream.** But Task A replaces this topology entirely, so prefer doing Task A over patching this.

---

## 2. HARD ARCHITECTURE FACTS YOU MUST RESPECT (gotchas that cost hours)

1. **`go` is NOT on PATH on this machine.** You cannot `go run`/`go build` directly. The backend ONLY runs via Docker:
   ```
   cd ecosync/server && docker compose up -d --build server
   ```
2. **The backend bakes data into the Docker image at build time.** `server/Dockerfile` does `COPY data/ ./data/`. Editing `server/data/*.json` or any `.go` file has **no effect** until you `docker compose up -d --build server`. A plain restart does nothing. Allow ~30–60s for the build.
3. **Docker Desktop sometimes stops.** If `docker ps` errors with "cannot connect to the Docker daemon", Docker Desktop restarted — re-run `docker compose up -d server`. The container is `server-server-1`; DB is `server-db-1`.
4. **FlatBuffers schema is fixed** (`server/data/telemetry.fbs` → generated `server/simulation/telemetry/*.go` and `dashboard/src/telemetry/*.ts`). `GlobalData` has only `buildingLoadMw`, `systemHealth`, `totalOccupants`. `ZoneData` has `id, temp, occupants, load`. `VavData` has `id, airflow, damper`. **If you need a new streamed field you must regenerate FlatBuffers for BOTH Go and TS** — avoid unless necessary; prefer deriving on the client.
5. **Coordinate convention** (zones/floors in `BuildingModel.jsx`): floor-plan polygon point `[px, pz]` (0..40 each, building footprint) maps to local 3D `x = px - 20`, `z = 20 - pz` (i.e. `z` is negated). Shapes use `(p[0]-20, p[1]-20)` then `rotateX(-Math.PI/2)`. Each floor is a `<group position={[0, floor.elevation, 0]}>` inside the building group at `[-30, 0, -20]`. AirflowField uses the SAME local convention (x,z in [-20,20], y in [0, floor.height]).
6. **Verify ONLY via the preview MCP**, never by asking the user. Vite ignores the assigned port; use `.claude/launch.json` (already set: `npm --prefix ecosync/dashboard run dev -- --port 5188 --strictPort`, autoPort false). Vite serves on **5188**. The preview browser navigates there. The screenshot capture sometimes renders small after a `location.reload()` — `preview_stop` then `preview_start` fixes the capture size.
7. **The Go cooling model is deliberately tuned.** In `engine.go` `tick()`: cooling is normalized by each VAV's `NominalFlow` (captured once at init) and `qNominalTotal = qInternalNominal + qSteadyStateWall` includes occupancy + solar. This is WHY zones settle at setpoint (green) instead of all-red. Do not "simplify" this or the building goes uniformly red again.

---

## 3. BOUNDARIES — DO NOT TOUCH / DO NOT REGRESS
- ❌ Do NOT import a generic `.ifc` / BIM viewer or any prebuilt 3D model loader. The user explicitly wants to keep the **custom R3F glowing-heatmap aesthetic** and React Flow. Everything stays procedural from `building-data.json` + `brick-ontology.json`.
- ❌ Do NOT change the Go cooling math in `tick()` (see §2.7). The green baseline is correct and hard-won.
- ❌ Do NOT move the building group off the grid (`BuildingModel.jsx` group `position={[-30, 0, -20]}` — keep Y=0).
- ❌ Do NOT remove the CSG geometry cache or `dispose={null}` props in `BuildingModel.jsx`.
- ❌ Do NOT remove the `recover()` in `main.go`'s WS loop.
- ❌ Do NOT hardcode the badges back to scenario-based constants — keep them reading live `GlobalData`.
- ❌ Do NOT delete `AirflowField.jsx`'s noise helper logic wholesale before its replacement renders — replace, then verify, then remove.
- ❌ Do NOT break `Inject Fault` auto-navigation in `loadScenario` (key starts with `fault:` → jump to the zone's floor).
- ⚠️ When you change `server/data/*` or `server/**.go`, you MUST `docker compose up -d --build server`. Forgetting this is the #1 way to "make it worse" (frontend renders new model, backend streams old → silent breakage).
- ⚠️ A parallel agent (the Antigravity IDE) and Claude have both edited these files. Re-READ each file immediately before editing; do not trust line numbers in this doc as exact — they drift. Use unique-string anchors.

---

## 4. THE WORK TO FINISH (tasks A–E, in priority order)

### TASK A — Topology = a real FLOOR SYSTEMS MAP (electrical grid + HVAC + sensors/cameras), not abstract zone blocks
**Intent:** The bottom-right panel currently shows abstract zone boxes fanning off an AHU. The user wants it to look like an engineering systems map of the *selected floor*: the floor outline, with **HVAC** (AHU→VAV→diffuser), the **electrical grid** (panels/circuits feeding equipment), and **sensor/camera nodes** placed on the plan, connected by their real relationships.

**Data you already have:**
- `building-data.json`: per-floor `zones[]` with `polygon`, `centroid`, `hvacMapping.vavId`, `zoneType`.
- `brick-ontology.json` (served at `GET http://localhost:8080/api/ontology`): `nodes[]` and `relationships[]` with predicates `brick:feeds` (ahu→vav, vav→zone) and `brick:hasPoint` (zone→`sensor_temp_<zoneId>`). **Use `brick:hasPoint` to place sensor nodes.** If camera/electrical nodes aren't in the ontology yet, you may extend `generate_bim.js` (`server/preprocessing/generate_bim.js`) to emit them into `brick-ontology.json` (e.g. `brick:hasPoint` for `camera_<zoneId>`, and electrical `brick:isFedBy` panel→circuit→equipment), then regenerate with `node server/preprocessing/generate_bim.js` and **rebuild the Docker image**.

**Implementation guidance:**
- Render the active floor's **room polygons as faint background shapes** inside the React Flow pane (a custom node of type `floorplan` that draws an SVG `<polygon>` per zone using `zone.polygon`, scaled to the pane), so nodes sit *on the plan*, not in a void.
- Node types to render (custom React Flow nodes, keep them small + legible): `ahu`, `vav`, `diffuser`, `sensor` (temp/CO₂), `camera`, `electrical-panel`, `circuit`, `light`. Use distinct iconography (lucide-react icons are available: `Wind`, `Camera`, `Zap`, `Cpu`, `Thermometer`).
- Edges = the relationships: HVAC flow (`brick:feeds`) animated with arrowheads; electrical (`brick:isFedBy`/`feeds`) as solid lines; sensor links as thin dotted lines.
- **Fix the 0-edges bug** as part of this (see §1). Single source of truth: build `{nodes, edges}` once per `[activeFloor, ontology]`; in the WS `onmessage` ONLY patch node `data` and edge `style`/`className` (never replace the node/edge sets, never rebuild structure on the stream).
- Keep it driven by data so it works for ANY floor / any blueprint (the user said "with any blueprint input").

**Acceptance:** Selecting any floor shows that floor's plan with HVAC + electrical + sensor/camera nodes connected by visible edges; switching floors updates it; no console errors; edges actually render (`.react-flow__edge-path` count > 0).

---

### TASK B — Separate 3D AIRFLOW map shown as a VECTOR FIELD (quiver), aerodynamic — replace the particle "blocks"
**Intent (verbatim-ish):** the current airflow looks like "blocks … kids game." The user wants airflow shown like the reference images: a **field of arrows** (a quiver/vector field — gradient+curl+harmonic / Helmholtz look), aerodynamic. It should be a **separate 3D map of the room shown on top of the topology panel** (its own small 3D view), NOT particles dumped into the main building.

**What to build:**
- A new component, e.g. `dashboard/src/AirflowVectorField.jsx`, rendered in its own small `<Canvas>` (a 3D inset on top of / above the topology panel — a separate framed view of the *active room/floor*).
- Represent airflow as **arrow glyphs on a 3D grid** (e.g. 12×4×12 lattice inside the floor volume). Each arrow = an `InstancedMesh` of a cone+shaft (or use `THREE.ArrowHelper` per sample for a first pass), oriented along the local velocity vector, length/color ∝ speed.
- Velocity field: a **divergence-free curl-noise** field (this gives the swirling vortex look in the reference). You can reuse the value-noise in `AirflowField.jsx`; compute curl via finite differences of a vector potential (3 noise samples + offsets), animate slowly with time. Bias it with the real HVAC: stronger flow near VAV/diffuser centroids (supply jets) heading toward returns. Color cool→warm by the zone's live temp deviation so airflow near a hot zone reads warm.
- Keep it performant: instanced arrows, update orientations in `useFrame`, cap ~400–600 glyphs.
- **Remove / retire** the particle-point `AirflowField` once the vector field renders (or keep it behind a dev flag). The `SHOW AIRFLOW` toggle should now show/hide the vector-field inset.

**Reference look the user attached:** a regular grid of arrows whose directions form smooth curl/gradient patterns (like a textbook vector field / Helmholtz decomposition figure). Arrows, not dots.

**Acceptance:** Toggling airflow shows a clean 3D arrow field (quiver) over the room that visibly swirls/flows; arrows orient along a coherent field (not random); colored by speed/temp; 60 fps; no NaN/console errors. It reads as "aerodynamics," not confetti.

---

### TASK C — Gradual green→yellow→red thermal degradation + clearly identify the faulting room
**Intent:** Right now a zone flips to alert abruptly and it's not obvious WHICH room is failing. The user wants a **smooth ramp green → yellow → red** as a room slowly heats from the start of trouble, and the failing room called out clearly.

**Implementation:**
- The 3D zone heatmap shader (`BuildingModel.jsx` `ZoneRenderer`) currently maps deviation to blue/green/red via `smoothstep`. Change the ramp to **green (deviation ≤ ~0.3) → yellow (~0.3–1.0) → red (≥ ~1.5)** with smooth interpolation (lerp through yellow), so a heating room transitions gradually and continuously. Same ramp for the topology `ThermalNode` color (`App.jsx`, function `smoothstep`/`ThermalNode`). Keep the transition CSS/temporal lerp so it eases (there's already a `THREE.MathUtils.lerp` on the temperature uniform — keep it).
- Identify the faulting room: when a zone's deviation crosses "warning" (yellow) it should already stand out (brighter edge / subtle pulse); at "critical" (red) pulse strongly and ensure the floor that contains it is flagged (`hasAlert` in `FloorPlate` already drives a red plate + `CRITICAL FAULT` label — make sure the *specific zone* also pulses and is labeled, not just the floor). The `ALARM DETECTED` modal already prints `LOCATION` + `ASSET` — keep that; consider auto-selecting/zooming the failing zone.
- The Go sim already heats gradually over seconds (good). Don't change the Go heating curve; this task is purely the *visualization* ramp + call-out.

**Acceptance:** Trigger `Inject Fault`; the targeted server room visibly walks green→yellow→red over a few seconds (not an instant snap), pulses red at critical, and is unambiguously identifiable (label + highlight + modal location).

---

### TASK D — Left bar = AI RECOMMENDATIONS ONLY (gauges + graphs); move Live Telemetry to a "Logs" toggle
**Intent:** The left dock's "AI Scenario Synthesis" is not informative, and the telemetry log shouldn't dominate. The user wants the **entire left bar to be AI recommendations with gauges and graphs**, and the **live telemetry stream demoted to an optional "Logs" tab/toggle.**

**Implementation (`App.jsx`, the `hud-dock-left` aside):**
- Replace the static "AI Scenario Synthesis" text with **actionable, data-driven recommendations** generated from live `simData`: e.g. detect zones over setpoint+deadband and emit "⚠ Zone <label> +X.X°C over setpoint — recommend raise VAV-<id> airflow / shed Zone Y load", energy-saving suggestions ("Floor 9 unoccupied — setback to 26°C, est. −X kW"), and a one-line system status. Derive these from `simData.zones` / `vavs` / `buildingLoadMw`.
- Add **gauges** (reuse the existing `CircularGauge`) and **graphs** — `recharts` is already a dependency (`recharts` in `package.json`). Add a small live line chart of e.g. building load (MW) and/or avg temp over time (keep a rolling buffer in state, ~60 samples). A bar/area chart of per-zone deviation is also good.
- Move the **Live Telemetry Stream** (the `terminal-log-window`) behind a toggle: e.g. a segmented control at the top of the left dock — `[ AI ] [ Logs ]` — default `AI`. Only render the log window when `Logs` is selected. Keep the existing log data source.

**Acceptance:** Left bar default view = AI recommendations + ≥1 gauge + ≥1 live graph, updating with the stream; a `Logs` toggle reveals the telemetry log; recommendations change meaningfully under `peak` vs `fault`.

---

### TASK E — Cursor-resizable topology panel; REMOVE the "Expand Map" toggle
**Intent (verbatim):** "the right bottom corner topology must be resizable meaning i can [use] cursor to resize it not the expand map bullshit." Remove `isMapExpanded` / the EXPAND MAP button entirely.

**Implementation (`App.jsx`, `.minimap-wrapper`):**
- Remove the `isMapExpanded` state, the EXPAND/COLLAPSE button, and the expanded-style branch.
- Make the panel resizable by dragging with the cursor. The panel is anchored bottom-right (`right:24, bottom:24`). Because CSS `resize` puts the grabber at the bottom-right (which is pinned to the screen corner here and feels wrong), implement a **custom drag handle at the TOP-LEFT corner** of the panel:
  - `const [panelSize, setPanelSize] = useState({ w: 600, h: 400 })`; wrapper uses `width: panelSize.w, height: panelSize.h`.
  - A small handle div at the panel's top-left (`cursor: 'nwse-resize'`). `onPointerDown` captures start; `pointermove` sets `w = clamp(startW - dx, 360, 0.9*innerWidth)`, `h = clamp(startH - dy, 260, 0.9*innerHeight)` (dragging up-left grows it, since it's bottom-right anchored). `pointerup` ends.
  - React Flow inside has `fitView`; call its refit on resize or rely on `fitView` re-running (or use `<ReactFlow onlyRenderVisibleElements={false}>` and a `key`/`fitView` effect).
- Keep it usable at any size (header + controls must not overflow).

**Acceptance:** No EXPAND MAP button exists; grabbing the top-left handle and dragging smoothly resizes the topology panel; React Flow content reflows; min size enforced.

---

## 5. VERIFICATION PROTOCOL (run after EACH task; never skip)
1. Frontend compiles: `cd ecosync/dashboard && npm run build` → must end with `✓ built`.
2. If you changed Go or `server/data/*`: `cd ecosync/server && docker compose up -d --build server`, then `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/building-data` → `200`, and `.../api/ontology` → `200`.
3. Preview: ensure `.claude/launch.json` server `dashboard` is running (port 5188). Use preview MCP `preview_start` (stop+start if the screenshot renders tiny). 
4. Runtime checks via preview MCP (NOT by asking the user):
   - `preview_console_logs level=error` → must be empty (no "Failed to load…", no React warnings, no NaN).
   - `preview_eval` to assert structure, e.g. topology: `document.querySelectorAll('.react-flow__edge-path').length > 0`; airflow: a `<canvas>` for the vector inset exists; left bar: recommendation + chart present.
   - `preview_screenshot` to confirm the look. Building should be GREEN at rest; `Inject Fault` → a specific room ramps to red.
5. Regression sweep: building still on grid, badges still live (`Bldg Load`/`Sys Health`/`Occupants` non-zero, change with scenario), fault still auto-navigates and shows the modal.

---

## 6. THE USER'S INTENT, IN THEIR WORDS (source of truth)
> "i want the topology to be something like this [a vector-field / quiver of arrows, Helmholtz curl], not those blocks airflow which looks like kids game. if you can i rather want a floor having electrical grids and hvac systems visible or which nodes, camera sensors and stuffs and on top of the topology will have a separate 3d map of the room which show airflow like i specified.
> also it doesnt show specifically which room is having the critical fault, i want it from the start if the room is slowly having trouble it will go slowly from green to yellow then critical red.
> the AI scenario isnt really informative and also live telemetry stream can be a logs option, i want the whole left bar to only be ai recommendations with gauges and graphs.
> the right bottom corner topology must be resizable meaning i can [use] cursor to resize it not the expand map bullshit."

Translation to scope: A=floor systems map (electrical/HVAC/sensors/cameras) in the topology; B=separate 3D airflow shown as an arrow VECTOR FIELD (not particles); C=gradual green→yellow→red + name the faulting room; D=left bar = AI recommendations + gauges + graphs, logs behind a toggle; E=cursor drag-resize the topology panel, delete EXPAND MAP.

Keep the cinematic aesthetic. Verify everything in the live preview. Rebuild Docker after any backend/data change.
