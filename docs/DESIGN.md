# HuskyLog — Design Document

**Status:** Draft v0.1 · **Date:** 2026-11-14 · **License:** MIT

HuskyLog is an offline Windows desktop app for reviewing DBF flight tests. It does
what UAV Log Viewer does for ArduPilot DataFlash logs (`.bin`) and adds:

- external data streams (ground videos, CSV sensor logs, MAVLink `.tlog`)
- a dedicated **Sync** stage to align all streams on one timeline
- a dockable grid of windows that can pop out onto other monitors
- overlays (numeric readouts, artificial horizon) on any window
- MP4 / GIF export of any window or combination of windows
- one-click **Pack & Go** workspace bundles

---

## 1. Requirements

### 1.1 Functional

| ID | Requirement |
|----|-------------|
| F1 | Import ArduPilot DataFlash `.bin` logs (our own MIT parser). |
| F2 | Import ground videos (MP4/MOV, H.264 and HEVC), CSV sensor logs, and MAVLink `.tlog`. The importer layer must make new types easy to add. |
| F3 | **Sync tab:** drop named sync markers on each stream and solve a time mapping per stream. Streams may cover only part of the flight. |
| F4 | **Review tab:** a dockable grid of windows with a shared playhead and time range. Any window can pop out into its own OS window (second monitor). |
| F5 | Window types: **3D Map**, **Graph**, **Artificial Horizon (ADI)**, **Video**. Also needed for UAV Log Viewer parity: **Messages/Events**, **Parameters**, **Readout panel**. |
| F6 | **Graph:** fuzzy-search every channel, add series, write math expressions, and save/load presets. |
| F7 | **Graph range selection:** show mean, std dev, min, and max per series, and export the range to CSV (time column plus one column per series). |
| F8 | **Overlays** on any window: numeric readouts of any variables (draggable, formatted) and an ADI overlay. |
| F9 | **Export** any window or set of windows to MP4, or a clip of 10 s or less to GIF. |
| F10 | **Pack & Go:** one click packs the workspace and every file it needs into one `.hlpack` file, and one click opens it. Video options: full, trimmed to the synced range, or re-encoded smaller. |
| F11 | Fully functional **offline**. 3D maps use a pre-downloaded **map cache**. |

### 1.2 Non-functional

- **Platform:** Windows 10/11 x64, per-user installer (no admin rights needed).
- **Offline:** no runtime network access except the explicit "Download map area" action. Every asset is bundled, with no CDNs.
- **Scale:** smooth with `.bin` logs up to about 1 GB, 1–4 videos of about 1080p60 and several GB each, and 20+ graph series.
- **Licensing:** all bundled dependencies are permissive or LGPL (see §13). The app is MIT.

### 1.3 Out of scope (v1)

macOS/Linux builds, live telemetry, multiple aircraft, collaborative editing,
auto-update (the app is offline; updates ship as new installers).

---

## 2. Technology Choices

| Concern | Choice | Why |
|---|---|---|
| Shell | **Electron** (latest stable) | Web rendering, WebGL, WebCodecs, multiple windows, Node file access. |
| Language | **TypeScript** (strict) | |
| Build | **electron-vite** + **electron-builder** (NSIS) | Fast dev loop, per-user installer, file associations. |
| UI | **React 18** + **Zustand** (state) | Simple, fast global store that works across pop-out windows (§4.3). |
| Docking | **dockview** + **dockview-react** (MIT) | Tabs, splits, floating groups, and **pop-out windows** built in. (v8 moved the React bindings into `dockview-react`.) |
| Plotting | **uPlot** (MIT) | Canvas-based, handles millions of points, very small. |
| 3D map | **CesiumJS** (Apache-2.0), imported as `@cesium/engine` + `@cesium/core` | The same engine UAV Log Viewer uses. Works offline with local imagery and terrain. **Never import the `cesium` umbrella package:** it pulls in Knockout-based widgets that need `eval()`, which our CSP blocks (Phase 0 finding). |
| Video decode | `<video>` for playback, **WebCodecs** + **mp4box.js** (BSD-3) for frame-accurate seeking and export | |
| Media tooling | **ffmpeg / ffprobe** binaries (LGPL build) | Probing, proxy transcoding, trimming, export encoding, GIF. |
| Storage | **better-sqlite3** (MIT) for MBTiles map cache; **yazl/yauzl** (MIT) for zip | |
| Tests | **Vitest** (unit), **Playwright** (Electron end-to-end) | |

---

## 3. Architecture Overview

```
┌──────────────────────────── Electron main process ────────────────────────────┐
│  App lifecycle · file dialogs · file associations (.hlpack/.hlws)             │
│  Custom protocols:                                                            │
│    hl-file://   range-request access to local files AND entries inside an    │
│                 open .hlpack (no extraction needed)                           │
│    hl-tiles://  imagery + terrain tiles from the MBTiles map cache            │
│  MediaService   ffprobe / ffmpeg child processes (probe, proxy, trim, encode) │
│  PackService    write/read .hlpack                                            │
│  MapCacheService download areas → MBTiles                                     │
└───────────────▲──────────────────────────────────────────────▲────────────────┘
                │ typed IPC (contextBridge, preload)           │ raw frames (export)
┌───────────────┴──────────────── Renderer (one JS context) ───┴────────────────┐
│  React app: [Import] [Sync] [Review] tabs                                     │
│  Zustand stores: workspace · streams · timeline · layout · overlays           │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Parser worker│  │ Expr engine   │  │ Playback     │  │ Export compositor│  │
│  │ (.bin/.tlog/ │  │ (compile →    │  │ clock (rAF)  │  │ (OffscreenCanvas │  │
│  │  csv decode) │  │  typed arrays)│  │              │  │  → ffmpeg pipe)  │  │
│  └──────────────┘  └───────────────┘  └──────────────┘  └──────────────────┘  │
│  dockview layout ─ windows: Map3D · Graph · ADI · Video · Messages · Params   │
│      │                                                                        │
│      └── pop-out → window.open() child window, rendered via React portal      │
│          (same JS heap: no data copied, store shared automatically)           │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Code layout

```
huskylog/
  src/
    core/            # pure TS, no DOM/Electron — unit-tested
      dataflash/     # .bin parser
      tlog/          # MAVLink tlog parser + generated message decoders
      csv/           # CSV importer
      expr/          # expression language
      timesync/      # marker solver, time mappings
      stats/         # range stats, resampling, CSV export
      workspace/     # schema, migrations, (de)serialization
    main/            # Electron main: protocols, services, IPC handlers
    preload/         # contextBridge API surface
    renderer/
      app/           # shell, tabs, stores
      windows/       # map3d/, graph/, adi/, video/, messages/, params/, readout/
      overlays/      # readout overlay, ADI overlay
      sync/          # Sync tab UI
      export/        # compositor
  resources/         # ffmpeg, Cesium assets, aircraft glTF, fonts
  tools/             # mavlink XML → TS generator, test-data scripts
  docs/
```

**Rule:** `core/` never imports DOM or Electron APIs. That keeps parsers, the
expression engine, and the sync solver testable with Vitest against real logs.

---

## 4. Data Model

### 4.1 Streams and channels

```ts
type StreamKind = 'dataflash' | 'tlog' | 'csv' | 'video';

interface Stream {
  id: string;                 // uuid
  kind: StreamKind;
  name: string;               // user-editable, e.g. "Ground cam – runway"
  source: FileRef;            // path relative to workspace, or pack entry
  localRange: [number, number];   // stream-local seconds
  mapping: TimeMapping;       // local → master (see §5)
  markers: SyncMarker[];
}

interface Channel {           // one plottable signal
  id: string;                 // "ATT.Roll", "IMU[1].AccZ", "csv1.Thrust_N"
  streamId: string;
  unit?: string;              // from FMTU / CSV header / MAVLink XML
  description?: string;
  // loaded lazily:
  t?: Float64Array;           // stream-local seconds, monotonic
  v?: Float64Array;           // already scaled (multipliers applied)
}
```

- **Channel naming:** `MSG.Field`, and `MSG[inst].Field` for multi-instance messages.
  Instances are zero-based, and the bare name `IMU.AccZ` means instance 0. Which
  field is the instance comes **from the log**: the FMTU unit `#`. Never use a
  hard-coded list. The reference log has 26 instanced types, including ones that
  are easy to miss (`XKFM.C`, `XKT.C`, `STAK.Id`, `UART.I`, `MAV.chan`,
  `ORGN.Type`). Treating them as one series produces duplicate timestamps and
  zig-zag plots.
- **RCOU channel labels** come from `SERVOn_FUNCTION` parameters, for example
  `RCOU.C1 (Throttle)`. Throttle is function 70 (73/74 for left/right). In the
  reference log it's **C1**, not C3.
- **Columnar typed arrays** everywhere. Plotting, math, and stats run on these
  arrays directly.

### 4.2 Lazy decoding (scales to 1 GB)

1. **Index pass** (worker, streaming): read FMT/FMTU/MULT/UNIT messages, then
   record each message's type and byte offset into a compact index (one
   `Uint32Array` of offsets per message type). Also record counts and time
   ranges. This also captures PARM, MSG, MODE, EV, ERR, CMD, and the GPS
   time-reference data, which are small and always decoded.
2. **On-demand column decode:** the first time any field of a message type
   is requested, the worker decodes all fields of that type into typed arrays
   and transfers them to the main thread. An LRU cache evicts unused message
   types under memory pressure.
3. The raw `.bin` buffer lives in the worker, fetched through `hl-file://`.

Target: index a 500 MB log in under 5 s and decode one message type in under 300 ms.

### 4.3 Pop-out windows share one heap

Pop-out windows are created with `window.open()` from the main renderer. React
renders into them through **portals** (dockview supports this pattern). So:

- every window shares the same Zustand store and the same typed arrays, with no
  IPC and no duplicated memory
- Electron's `setWindowOpenHandler` configures the child (frame, icon, remembered
  monitor position)
- **Resolved in Phase 0:** a WebGL context does **not** survive its host window
  closing (re-docking a pop-out loses it). WebGL windows therefore re-create
  their viewer whenever they change host window, or lose context, and keep
  camera state in the store (~100 ms, invisible in practice). Each window drives
  its render loop from its *host* window's `requestAnimationFrame`, with a
  watchdog that restarts the loop when a host window closes.
- Cesium listens for drag events on the global (main-window) `document`; we set
  its `disableRootEvents` flag so dragging works inside pop-outs.
- `backgroundThrottling: false` on the main window keeps pop-outs live while
  the main window is minimized or hidden (verified: 59–61 fps).

---

## 5. Time & Synchronization

### 5.1 Clocks

- **Master timeline:** seconds, with 0 set by the **reference stream**. The
  reference is the first `.bin` by default, and the user can change it.
- **Stream-local time:**
  - `.bin`: `TimeUS / 1e6`. UTC comes from the first valid `RTC` message
    (Epoch ≠ 0) or from `GPS` week + ms once `GWk ≠ 0`. **Never trust the log's
    filename date:** logs start before GPS lock, so names like `1980-01-11 …`
    are normal.
  - **The FC clock drifts.** In the reference log, `TimeUS` runs about **150 ppm
    fast against GPS**: 121 ms over 820 s, about 4 video frames at 30 fps.
    `RTC.Epoch` is derived from `TimeUS`, so it hides the drift. Only GPS week + ms
    shows it.
    - UTC conversion uses a **linear fit** of `TimeUS` → GPS time (with the
      GPS−UTC leap-second offset, currently 18 s), never a single offset.
    - Optional "GPS-discipline this log" flag: master time becomes true seconds.
      Helpful when matching `.tlog` or other wall-clock sources.
  - `.tlog`: per-packet UNIX µs timestamp (wall clock).
  - CSV: user-chosen time column and unit (s/ms/µs or ISO datetime).
  - Video: **frame presentation timestamps** (PTS) from the container, never
    `frameIndex / fps`, because phone video is often variable frame rate.

### 5.2 Mapping model

Each stream has `master = a · local + b`. The reference stream has a = 1, b = 0.

### 5.3 Sync markers

A **sync event** is a named moment, for example "Prop start", "Wheels off",
or "Touchdown". A **marker** places an event on one stream at one local time.

```ts
interface SyncEvent  { id: string; name: string; color: string }
interface SyncMarker { eventId: string; localTime: number }
```

**Solver** (`core/timesync`): joint linear least squares over every stream and
event.

- Unknowns: `(a_s, b_s)` for each non-reference stream, plus a master time `T_e`
  for each event.
- Minimize Σ over markers of `(a_s · t_se + b_s − T_e)²`.
- The reference stream fixes the `T_e` of the events it contains.
- **Chaining works for free:** if a video shares no event with the log but shares
  "Touchdown" with another video that is synced, it still resolves.
- **Scale term `a_s`:** solved only when the stream has 2+ markers spanning more
  than 60 s and the user hasn't checked "offset only". Otherwise a_s = 1. A warning
  appears if |a_s − 1| > 0.2%, which usually means a mis-click or a VFR problem.
- Per-marker **residuals** (ms) are shown, so a bad marker stands out.
- Manual nudge: ± 1 frame and ± 1 ms buttons per stream, stored as an extra
  offset.
- Streams with no path to the reference are flagged "unsynced" and hidden
  from Review until they're resolved.

### 5.4 Auto-suggest (assist, never automatic)

- `.tlog` ↔ `.bin`: both have wall-clock time through GPS, so propose an offset.
- Video: the file's creation time in its metadata gives a rough offset (± a few s),
  useful to jump near the event.
- Optional later: match a video's audio onset (motor spin-up) against the log's
  throttle output (`RCOU`/`ESC`) for a suggested marker.

### 5.5 Sync tab UI

A timeline with one **lane per stream**, laid out like a video editor:

- **Log / CSV / tlog lanes:** a mini-plot of one or more user-chosen channels.
  Defaults: the throttle output (found through `SERVOn_FUNCTION`), `ESC.RPM`,
  and IMU acceleration magnitude, overlaid.
- **Commanded vs. physical events.** In the reference log, throttle steps up at
  313.91 s. ESC RPM first reads 814 at 314.11 s and about 7000 at 314.45 s. That's
  a 0.2–0.5 s spin-up, which is 6–15 frames. A video shows the *physical* prop, so
  its marker must pair with RPM or vibration, **not** the throttle command. The UI
  says so when you place a "Prop start" marker on a command channel.
- **Sample rates limit precision.** ESC logs at about 9 Hz (115 ms steps), RCOU at
  25 Hz, IMU at 100 Hz, and video at 33 ms per frame. Prefer IMU for sharp events
  (props on, touchdown jolt).
- **Snap-to-edge helper:** after a click, it suggests the nearest step or onset in
  the lane's signal (threshold crossing on the chosen channel). One key accepts it.
- **Video lanes:** a thumbnail strip plus an **audio waveform**. The prop
  starting is usually easiest to find by ear or by waveform.
- **Two modes:**
  - *Local*: each lane scrubs independently in its own time, with frame stepping
    (←/→) through WebCodecs.
  - *Aligned*: lanes are drawn on the master timeline using the current solution,
    to check the result visually.
- Drop a marker with `M` at the lane's cursor, pick or create its event name, and
  drag it to adjust. The residual table updates live.

---

## 6. Review Tab: Layout, Playback, Selection

- **dockview** grid: split, tab, drag, float, or pop out any window. The layout
  is saved in the workspace, including each pop-out's screen and position (it
  falls back gracefully if that monitor isn't connected).
- **Global playhead** `tMaster`: play/pause (Space), speed 0.1×–8×, frame
  step, loop over the selected range, and jumps to sync events, mode changes, and
  messages.
- **Global time range selection:** dragging on any graph sets it. Every graph
  then shows stats for that range, and export dialogs use it as the default.
- Windows that show a stream outside its covered range display a "no data at
  this time" state instead of stale content.

### 6.1 Playback engine

- A `requestAnimationFrame` clock advances `tMaster`. Windows subscribe to
  a throttled selector.
- **Video windows during playback:** the native `<video>` plays at the playback
  rate and is corrected (seek or small rate nudge) if it drifts more than one frame
  from `mapping⁻¹(tMaster)`.
- **Video windows while paused or scrubbing:** exact seek. The Sync tab and Export
  use the WebCodecs path for frame accuracy.

---

## 7. Window Types

All windows implement one interface, so layout, pop-out, overlays, and export
treat them the same way:

```ts
interface HLWindow<Config> {
  type: string;
  config: Config;                       // serialized into workspace
  render(): ReactNode;                  // live UI
  drawFrame(ctx: CanvasRenderingContext2D, tMaster: number,
            size: {w: number; h: number}): Promise<void>;   // export path
}
```

`drawFrame` is required. Every window and overlay must be able to draw itself
onto a canvas at an exact time. Export depends on this (§10), and it keeps the
design honest: no DOM-only rendering.

### 7.1 3D Map

- CesiumJS viewer in `requestRenderMode` (renders only when something changes).
- Imagery and terrain come from the **map cache** (§9). With no cache, it shows a
  grid globe plus the track, still useful.
- Flight track polyline **colored by flight mode** (from MODE messages), with
  the past portion solid and the future portion dimmed.
- Aircraft glTF model (bundled, CC0 or our own) posed from attitude
  (ATT roll/pitch/yaw) and position (POS at 25 Hz by default; GPS is only 5 Hz).
- **Altitude reference (important).** Cesium uses heights above the WGS84
  *ellipsoid*. Logs use heights above mean sea level (*geoid*), which is about
  23 m off near Seattle. Separately, the GPS altitude can disagree with the
  terrain model: the reference log shows GPS 2.3 m MSL on the ground while the FC's
  own terrain database (`TERR.TerrH`) says 9.3 m. Drawn naively, the plane would
  sit underground. So there are two modes:
  - **Default:** relative-to-home. Height = terrain height at the home point
    (from the cached DEM, falling back to `TERR.TerrH`) + `POS.RelHomeAlt`.
    Takeoff and landing always sit on the ground.
  - **Absolute (AMSL):** `POS.Alt` + geoid height from a bundled EGM96 grid
    (~2 MB). For checking altitude data itself.
- Camera modes: free, follow, chase, top-down. Also shows mission waypoints
  (CMD), home, and optional fence.
- Clicking the track sets the playhead.

### 7.2 Graph

- **Channel browser:** fuzzy search across every stream (e.g. `att rol` finds
  `ATT.Roll`), grouped by stream and message, showing units and descriptions.
  Click or drag to add a series.
- **Series:** a channel or an **expression** (§8). Each series has a color, line
  width, an axis (left/right, automatically grouped by unit), and a visibility toggle.
- Zoom and pan (wheel, drag, box zoom). The cursor line is linked to the global
  playhead. A hover tooltip shows every series' value at the cursor.
- Plots use **min/max decimation per pixel column**, so spikes are never hidden
  (LTTB would smooth them away).
- **Gaps:** the line breaks wherever the gap is more than 5× a series' median
  sample period, so it doesn't draw a fake straight line. Several reference-log
  types have bursts and gaps of 10–400 s (STAK, XKFM, ORGN, FMTU, PARM).
- Flight-mode background bands and event markers (toggleable), as in UAV Log Viewer.
- **Range stats panel:** for each series over the selected range: mean, std dev,
  min, max (peak), plus count and duration. A copy button copies it as a table.
- **Export range → CSV:**
  - Columns: `time_s` (master), optional `time_utc`, then one column per visible
    series named `ATT.Roll [deg]`.
  - Time base options: *(a)* timestamps of the fastest series (default), with the
    others linearly interpolated; *(b)* a fixed rate in Hz; *(c)* union of all
    timestamps.
- **Presets:** a preset saves the series list (channels and expressions), colors,
  axes, and options, **without** a time range. Presets are stored as JSON in
  `%APPDATA%/HuskyLog/presets/`, can be imported/exported to share with the team,
  and are embedded in workspaces and packs. If a preset refers to a channel the
  current log doesn't have, that series is flagged instead of failing the whole
  preset. A few ArduPilot built-in presets ship with the app (attitude
  tracking, vibration, power, airspeed/TECS), similar to UAV Log Viewer.

### 7.3 Artificial Horizon (ADI)

- Canvas-drawn primary flight display: horizon, pitch ladder, roll scale, heading
  tape. Optional airspeed and altitude tapes, flight-mode label, and armed state.
- Data sources are configurable, with defaults ATT.Roll/Pitch/Yaw, ARSP.Airspeed or
  CTUN, and BARO.Alt or POS.RelHomeAlt.
- The same drawing code powers the ADI **overlay** (§7.7) with a transparent
  background.

### 7.4 Video

- Plays one video stream mapped onto master time. Supports zoom and pan (digital
  crop), rotation (phones), and a mute/volume control.
- Outside the stream's range it shows a placeholder with "starts in 12.4 s".

### 7.5 Messages / Events

A filterable table of MSG, ERR, EV, ARM, and MODE entries, plus sync events. Click
a row to jump the playhead there.

- **Mode names** need per-vehicle tables. The vehicle comes from `VER.FWS` or
  the first MSG ("ArduPlane V4.7.2"). For example, Plane mode 11 is RTL, while
  on Copter 11 means DRIFT.
- The same goes for MODE reason codes and EV/ERR ids, using tables generated from
  ArduPilot source.

### 7.6 Parameters

A searchable PARM table showing the value at the playhead time and a change list.
Export to `.param`.

- PARM has a `Default` field, so a **"non-default only"** filter is offered. This
  is the fastest way to see how an airframe is set up.
- Parameters change in flight: the reference log has 98 changes, mostly
  auto-updated `BARO1_GND_PRESS` and `STAT_RUNTIME`. The change list hides those
  "housekeeping" params by default.

### 7.6a Embedded files

ArduPilot embeds files in the log as `FILE` messages. The reference log has
`hwdef.dat`, `defaults.parm`, `uarts.txt`, `threads.txt`, `memory.txt`,
`timers.txt`, and a sparse `storage.bin`. A small viewer lists them and lets you
save them. **Low priority.**

### 7.7 Overlays (any window)

Each window has an overlay layer, which is a list of overlay items:

```ts
interface OverlayItem {
  id: string;
  kind: 'readout' | 'adi';
  rect: { x: number; y: number; w: number; h: number }; // normalized 0–1
  style: { color: string; bg: string; opacity: number; align: 'left' | 'center' | 'right' };
  stream?: string;                 // log the sources come from (default: primary)
  sample?: 'interp' | 'hold';      // between samples
  // readout:
  lines?: { label: string;
            source: string /* channel, named or inline expression, @mode/@armed/@time/@local */;
            format: string /* printf: %.1f, %d, %+.2f, %,d, %.3e */; unit?: string }[];
  // adi:
  hud?: boolean;                   // see-through lines (default) or filled ball
  tapes?: boolean;
}
```

- Overlays can be dragged and resized in **edit mode** (▣ in the window
  header). Positions are normalized, so they survive window resizes and export
  resolutions. Text auto-fits its box (no font size), for the same reason.
- Readouts show a value **at `tMaster`** through the log's sync mapping
  (sample-and-hold or interpolated, set per readout). Outside the data, or
  across a gap, they show "–".
- Map, Video, Graph and Horizon windows have them. The table windows (Messages,
  Parameters) don't.
- Items are stored in the window's dockview parameters, so the layout JSON (and
  the Phase 6 workspace) carries them. Live drawing and export share
  `drawOverlays(ctx, w, h, items, tMaster)`.

---

## 8. Expression Language

**Syntax:** infix math over channel references.

```
ATT.Roll - ATT.DesRoll
sqrt(IMU.AccX^2 + IMU.AccY^2 + IMU.AccZ^2)
deriv(BARO.Alt)
lowpass(IMU[1].AccZ, 5)            // 5 Hz cutoff
integrate(BAT.Curr) / 3600         // Ah
BAT.Volt * BAT.Curr                // power, different rates → auto-resampled
csv1.Thrust_N / (BAT.Volt * BAT.Curr)
```

- **Operators:** `+ - * / ^ %`, comparison operators, `&& || !`, ternary `?:`.
- **Functions:**
  - math: `abs sqrt exp log log10 sin cos tan asin acos atan atan2 min max clamp round floor ceil`
  - signal: `deriv integrate lowpass highpass movavg median delay rate`
  - conversion: `deg rad`, plus `wrap180` and `wrap360`
  - time: `t` (master time)
- **Engine:** a small Pratt parser builds an AST, which is compiled to vectorized
  operations over `Float64Array`. No `eval`, and errors give positions.
- **Mixed sample rates:** the output uses the timestamps of the
  **highest-rate input**. Other inputs are linearly interpolated (zero-order hold
  is optional). Expressions can mix streams once they're synced, because
  everything is resolved in master time.
- Expressions can be **named** and reused like channels: `power = BAT.Volt * BAT.Curr`.
  Named expressions are saved in presets and the workspace.

---

## 9. Offline Maps (Map Cache)

- **Map Cache Manager** (online only): choose an area by drawing a rectangle,
  selecting "around this log's track + 2 km", or entering coordinates. Then pick a
  zoom range (default z0–z18, about 0.6 m/px at the field). It shows an estimated
  tile count and size before download, and downloads can resume.
- **Imagery:** XYZ tile source with a configurable URL template. **Open item:**
  confirm the terms of the default provider allow offline caching (candidates:
  Esri World Imagery, Sentinel-2 cloudless, a USGS/NAIP-type source for US fields).
  **Google tiles are excluded** because Google's terms forbid offline caching.
- **Terrain:** heightmap tiles (Terrarium/Terrain-RGB format) loaded by a
  custom Cesium heightmap terrain provider.
- **Storage:** one MBTiles (SQLite) file per area in `%LOCALAPPDATA%/HuskyLog/maps/`,
  served to Cesium through `hl-tiles://`.
- **Pack & Go** can include the tiles covering the track (a subset copy), so a pack
  opened on another laptop has the map too.
- Cesium ion is disabled entirely (no default token, no network calls).

---

## 10. Export (MP4 / GIF)

**User flow:** select windows → Export → choose:

- layout: *as on screen* or a *custom arrangement* (grid or picture-in-picture)
- time range (defaults to the global selection)
- resolution (720p / 1080p / 4K / custom)
- fps
- format: MP4, or GIF (the GIF option is only enabled for ≤ 10 s; it defaults to
  15 fps and ≤ 800 px wide)

**Pipeline** (deterministic offline render, not screen capture):

1. For each frame time `t`, the playhead is set to `t` (paused). The user's
   playhead and play state are restored afterwards, and the modal dialog
   blocks interaction meanwhile.
2. For each selected window, `await source.draw(ctx, t, w, h)` (the window's
   registered export source, `export/registry.ts`), then its overlays with the
   shared `drawOverlays`.
   - Video decodes the exact frame at `mapping⁻¹(t)` with WebCodecs, then
     repeats the window's letterbox, rotation and zoom crop.
   - Cesium renders the pose for `t` and copies its canvas right after a render
     once `globe.tilesLoaded` (5 s cap per frame).
   - The graph copies its plot (playhead at `t`) and adds a legend with values.
     The ADI draws the vector instrument at output size.
3. Composite onto an `OffscreenCanvas`.
4. **MP4:** WebCodecs `VideoEncoder` (platform H.264; "quality" mode with
   B-frame-aware timing, falling back to "realtime"), muxed by the app's MP4
   writer. Audio from a chosen video stream is copied (no re-encode), trimmed
   and offset to match. No ffmpeg.
5. **GIF:** our own encoder (`core/export/gif.ts`). One palette for the whole
   clip (exact when ≤ 256 colours, else median cut), changed-rectangle
   frames, LZW.
6. A progress dialog shows frames, ETA and a cancel button. Faster than real
   time isn't required. Correctness comes first.

---

## 11. Workspace & Pack & Go

### 11.1 Workspace file (`.hlws`, JSON)

```jsonc
{
  "format": "huskylog-workspace", "version": 1,
  "streams":  [ /* Stream (file refs relative to the .hlws) */ ],
  "syncEvents": [ /* SyncEvent */ ],
  "referenceStreamId": "…",
  "layout":   { /* dockview serialized state + pop-out geometry */ },
  "windows":  { "<id>": { "type": "graph", "config": { /* … */ }, "overlays": [] } },
  "expressions": { "power": "BAT.Volt * BAT.Curr" },
  "presets":  [ /* embedded copies of presets used */ ],
  "mapAreas": [ "field-xyz.mbtiles" ],
  "ui": { "tMaster": 123.4, "range": [100, 160] }
}
```

The file is versioned, with migrations in `core/workspace`. Missing files trigger a
"locate file" prompt that matches on file hash.

### 11.2 Pack (`.hlpack`)

A zip file with a fixed layout:

```
manifest.json        # format, version, app version, created, sha256 per entry, pack options
workspace.hlws       # paths rewritten to pack-relative
streams/<id>/<file>  # .bin, .tlog, .csv, videos
maps/<area>.mbtiles  # optional subset
presets/*.json
```

- **One click to pack:** File → Pack & Go → choose a video mode:
  - **Full** (default): originals stored **uncompressed** (zip "store").
    Re-compressing video gains nothing and storing keeps it fast.
  - **Trim:** stream copy (no quality loss) by our own MP4 writer
    (`core/pack/mp4mux`), cutting at the keyframes around the selected time
    range, or, with no selection, the overlap with the reference log, plus a
    5 s margin. The video's sync markers move by the cut, so sync stays exact.
  - **Re-encode smaller:** WebCodecs H.264 at up to 720p (≈ 0.1 bit/pixel/
    frame), trimmed like above; audio is copied. No ffmpeg.
  - Logs and JSON use deflate.
  - A size estimate is shown before packing.
  - Map areas overlapping the flights are included (optional); on open they
    are added to that computer's map cache.
- **One click to open:** double-click the `.hlpack` (file association) or use
  File → Open. Because media entries are stored uncompressed, `hl-file://` serves
  them **straight from inside the zip** with byte-range requests. That means **no
  extraction**: a 6 GB pack opens instantly. Compressed entries, which are small,
  are extracted to a temp cache.
- Saving changes to an opened pack writes the workspace back into the pack
  (appended with a new central directory, so media offsets never move). "Save
  As" writes a `.hlws` that refers to the media inside the pack.

---

## 12. Importers

| Type | Notes |
|---|---|
| `.bin` | Our MIT parser (`core/dataflash`): FMT self-describing records, FMTU/MULT/UNIT for units and scaling, instance fields, resync on corrupt bytes, both `TimeUS` and legacy `TimeMS`. Validated against UAV Log Viewer and `mavlogdump.py` output on team logs (pymavlink used only in tests, not shipped). |
| `.tlog` | Per packet: 8-byte big-endian µs timestamp, then a MAVLink v1/v2 frame. Decoders are generated at build time from the MAVLink `common.xml` and `ardupilotmega.xml` definitions by our own `tools/` generator. Channels are named `MSG.field` (e.g. `ATTITUDE.roll`). |
| CSV | Import wizard: delimiter, header row, time column and unit, columns to include, unit per column (saved as a template for repeat imports, e.g. "Thrust stand v2"). |
| Video | `ffprobe` checks codec, rotation, VFR, and audio. If WebCodecs can't decode it (some HEVC on machines without hardware support) or the file is badly VFR, a **proxy** is created: H.264 MP4 in the cache, keyed by file hash. The original stays the source of truth. Audio waveform peaks are precomputed and cached. |

### 12.1 DataFlash parser rules (from the reference log)

**Reference log:** `1980-01-11 13-29-53.bin`. ArduPlane 4.7.2, MatekH743,
32.8 MB, 829 s of log, armed 309.6–520.9 s, a single motor on DShot, max 110 m
AGL, 294 m from home. It has 184 formats and 64 types with data. Format chars in
use: `BCHILMNQZbcdefhin` (`a` is defined but unused).

1. **Layouts come from FMT, always.** Fields change between firmware versions:
   4.7 `MSG` is `TimeUS,ID,Seq,Message`, and `MODE` has `Mode,ModeNum,Rsn`.
2. **Scale each field exactly once.** Format chars `c C e E L` already imply a
   scale (×0.01, ×0.01, ×0.01, ×0.01, ×1e-7), and FMTU usually repeats it
   (`CTUN.Roll` is `c` with multiplier 0.01). Applying both gives values 100×
   too small.
   - For those chars, the format char wins. The FMTU multiplier applies only to
     plain integer types (e.g. `GPS.HDop` is `H` × 0.01; `GPS.GMS` is `I` ×
     0.001 → s).
   - Where they disagree, like `BAT.Temp` (`c` with multiplier 1), the format
     char wins and a debug note is recorded.
   - Golden tests against `mavlogdump` lock this down.
3. **MULT `-` (stored as 0) means "no multiplier", not ×0.** MULT values are
   float32 (0.1 is stored as 0.10000000149), so round them to the nearest decade.
4. **Units** come from UNIT and FMTU and are mapped to display strings
   (`deglatitude` → °, `degheading` → °, `?` → unknown).
5. **Instance fields** come from FMTU `#` (§4.1).
6. **Messages are not in global time order.** The reference log has 289,000
   out-of-order pairs because subsystems write with small delays. Each
   (type, instance) series is monotonic. So the index sorts per series and
   never assumes a global order. Merged views (Messages table, CSV union time
   base) sort explicitly.
7. **Not every message has `TimeUS`:** `FILE` doesn't. Such types are stored but
   never plotted.
8. **Truncated tail.** The reference log ends with 24 bytes of a half-written
   message (power cut). Parse up to the last complete message and warn quietly.
9. **Corrupt data:** resync by scanning for the next `A3 95 <known type>` header.
   For extra safety, also check that the next header follows at the expected length.
10. **Size:** about 40 KB/s of log, so 1 GB is roughly a 7-hour session. The 1 GB
    design target is generous.

**Data quirk worth knowing (not a design issue):** `ARSP.Airspeed` reads up to
60.9 m/s at 246 s, about a minute before arming, probably someone handling the
pitot. A good reminder that range stats are only as clean as the selected range.

Importers implement one interface (`probe`, `index`, `listChannels`,
`loadChannel`), so new types can be added without touching the UI.

---

## 13. Packaging, Install, Licensing

- **electron-builder NSIS**, per-user install to `%LOCALAPPDATA%\Programs\HuskyLog`.
  It registers file associations for `.hlpack` and `.hlws`, and adds "Open with
  HuskyLog" for `.bin` (no default association, since `.bin` is generic).
- Bundled: ffmpeg/ffprobe (**LGPL build**, so no x264; H.264 encoding uses Media
  Foundation or OpenH264), Cesium assets, fonts, and the aircraft model.
- Strict Content Security Policy: no remote origins, except the map downloader,
  which runs in main.
- **License inventory:** MIT app; dependencies are MIT, Apache-2.0, or BSD. ffmpeg
  is LGPL-2.1, shipped as a separate executable with its license and a source
  link. A `THIRD_PARTY_NOTICES` file is generated at build time.
- Updates: a new installer distributed via GitHub Releases or the team drive.
  Workspace and pack versions are migrated forward.

---

## 14. Build Phases

Each phase ends with something usable.

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Skeleton & spikes** | electron-vite + React + dockview shell, IPC, installer builds, offline CSP. Spikes: dockview pop-out with React portal, Cesium inside a pop-out, WebCodecs frame stepping on a phone HEVC clip. | Installer runs on a clean Windows machine with Wi-Fi off. All spikes pass or have a fallback plan. |
| **1. Logs & graphs** | DataFlash parser (index + lazy decode), channel browser, Graph window, playhead, range stats, CSV export, presets, Messages and Params windows. | Team logs give values identical to UAV Log Viewer. A 500 MB log is usable. |
| **2. Expressions** | Expression engine, named expressions, error UI. | Expressions mixing different-rate channels match hand calculations in tests. |
| **3. Map & ADI** | Cesium 3D map, map cache manager, ADI window, mode-colored track. | Matches UAV Log Viewer's map features, offline at the field. |
| **4. Video & Sync** | Video import, proxying, Video window, Sync tab (lanes, waveform, markers), solver with residuals. | A ground video lines up with the log to within one frame at two events. |
| **5. Overlays & pop-outs** | Readout and ADI overlays, edit mode, pop-out polish (monitor memory). | A two-monitor review session works end to end. |
| **6. Workspace & Pack & Go** | `.hlws` save/load, `.hlpack` with all three video modes, open-in-place. | Pack on laptop A, open on laptop B (offline): an identical session, maps included. |
| **7. Export** | MP4 and GIF export of window compositions. | A 60 s 1080p composite (video + ADI overlay + graph) exports correctly. |
| **8. tlog & CSV** | Both importers, CSV templates, tlog/bin auto-suggest. | Thrust-stand CSV and GCS tlog sync and plot alongside the `.bin`. |

---

## 15. Risks & Open Items

| # | Item | Plan |
|---|---|---|
| R1 | Cesium WebGL context when moving to a pop-out | **Resolved (Phase 0):** re-create on host change; see §4.3 and Appendix A. |
| R2 | HEVC / VFR phone video | Proxy on import (§12). Use PTS-based time everywhere. |
| R3 | Imagery provider terms for offline caching | Pick the provider before Phase 3. Keep the URL template configurable. |
| R4 | Memory with 1 GB logs + 4K video | Lazy decode with LRU, proxies, per-pixel decimation. Profile in Phase 1 with a synthetic 1 GB log. |
| R5 | Export speed (Cesium tile loading per frame) | Pre-warm tiles along the track before rendering. Accept slower than real time. |
| R6 | DataFlash edge cases across ArduPilot versions | Gather a corpus of team logs plus public logs. Golden tests against `mavlogdump`. |
| R7 | Double-applied scaling in the parser (§12.1 rule 2) | Golden tests on every field of the reference log against `mavlogdump` in Phase 1. |
| R8 | Sync error from pairing a commanded event with a physical one (§5.5) | UI hint, multi-channel lanes, snap-to-edge, IMU-rate channels. |
| R9 | Aircraft drawn underground or floating (§7.1) | Relative-to-home default mode, bundled EGM96 geoid. |
| O1 | Which built-in graph presets to ship | Team to list their go-to plots. |
| O2 | App icon / branding | Team. |

---

## Appendix A. Phase 0 Results (2026-11-15)

Verified by `scripts/e2e.mjs` against both the dev build and the packaged
`HuskyLog.exe`, with every outbound network request blocked (0 attempted).

| Spike | Result |
|---|---|
| Pop-out windows (dockview + React portals) | ✅ Same-origin `app://huskylog/popout.html` opens as a real OS window and shares the main window's memory. Note: Node's `URL.origin` is `"null"` for custom schemes, so origin checks compare protocol + host. |
| Cesium in a pop-out | ✅ 60 fps. Drag works (`disableRootEvents`). Keeps rendering while the main window is hidden. Re-dock recovers through re-create (context is lost when the host window closes). |
| WebCodecs frame stepping | ✅ H.264 with B-frames, **HEVC (hardware decode available on the dev machine)**, and VFR. Frame-exact: the burned-in frame number matches the decoded frame. Random seek 150–560 ms; cached steps < 1 ms. |
| Offline / CSP | ✅ Strict CSP, no `unsafe-eval`. Offline guard blocks everything except the dev server. |
| Installer | ✅ NSIS per-user, 127 MB (Electron runtime ~100 MB; app.asar 19 MB). Unsigned for now, so SmartScreen will warn. |

**Video findings for Phase 4:**
1. Apply the MP4 **edit list** (`elst`). x264 with B-frames shifts composition
   times by 2 frames; without it, every timestamp is 33 ms late at 60 fps.
2. **Open GOP** (x265 default, some Android phones): leading frames are stored
   after a keyframe but displayed before it. Seeking to one must start decoding
   from the *previous* keyframe.
3. HEVC proxies may be unnecessary on machines with hardware HEVC decode. Keep
   the proxy path for machines without it (check `VideoDecoder.isConfigSupported`).
4. A backward step across a GOP boundary costs a full GOP decode (~200–400 ms at
   720p). Phase 4 should keep a decoded-frame cache around the cursor and decode
   the previous GOP in the background while scrubbing.

**Known minor issue:** Cesium logs one "width 0" render error during the
pop-out close transition. Rendering recovers immediately; to be tidied in Phase 3.

## Appendix B. Phase 1 Results (2026-11-15)

**Delivered:** our own MIT DataFlash parser (`src/core/dataflash`, run in a Web
Worker); channel catalog with FMTU units, instances and RCOU function labels;
Graph window (uPlot) with fuzzy channel search, per-pixel min/max decimation,
gap breaks, mode bands and arm/disarm markers, auto left/right axes by unit,
live values at cursor/playhead, wheel zoom, pan, shared playhead and range
selection; range stats (mean, std dev, min, max with times, sample count, copy
as TSV); CSV export (fastest / fixed-rate / union time base); graph presets
(7 built-in, save/delete/import/export as JSON in `%APPDATA%/HuskyLog/presets`);
Messages window; Parameters window (value at playhead, non-default filter,
change list hiding housekeeping params, `.param` export); timeline bar.

**Verified:** 22 unit tests (synthetic edge cases + golden values from the
reference log) and `scripts/e2e-phase1.mjs` (16 UI checks, graph in a pop-out,
no network). Performance on the 33 MB reference log: read + index + summary
in ~0.6 s in the app. On a 493 MB synthetic log (13 M messages): index 1.9 s,
summary 60 ms, decoding all IMU data 0.6 s, ~0.9 GB RSS.

**Parser fix found by tests:** a valid final message followed by trailing junk
was dropped by the corruption guard. Now accepted when no valid header follows.

**Not yet done / deferred:**
- Side-by-side comparison with UAV Log Viewer on more team logs (needs the team;
  the golden tests cover the reference log only).
- `time_utc` CSV column: needs the GPS-disciplined clock fit (§5.1), Phase 4.
- Embedded-files viewer (§7.6a): the parser extracts them; UI is low priority.
- Keyboard shortcuts (Space) only work while the main window has focus, not in
  pop-outs.

## Appendix C. Phase 2 Results (2026-11-15)

**Delivered:** expression engine (`src/core/expr`): Pratt parser with source
positions; vectorised evaluator where every sub-expression keeps its own time
base and the lower-rate operand is resampled onto the higher-rate one (linear,
or sample-and-hold via `hold()`; NaN outside range and across gaps); `t` as a
deferred function of time; 30 functions (math, `atan2/hypot/min/max/clamp`,
`deriv`, `integrate`, `lowpass`, `highpass`, `movavg`, `median`, `delay`,
`hold`, `dt`, angle helpers) and constants `pi`, `e`, `g`. Static validation
(unknown functions/names/channels with "did you mean", arity, cycles in named
expressions). Graph integration: expression series with label and unit, editor
with live error underline, autocomplete, signature help and a function list;
named expressions usable in the channel picker and inside other expressions;
presets embed the named expressions they use; built-in "Power & energy" preset.

**Verified:** 24 new unit tests (46 total), including physical checks on the
reference log: `integrate(BAT.Curr)/3600` matches the FC's consumed-Ah counter
within 2%, `integrate(BAT.Volt*BAT.Curr)/3600` matches its energy counter within
3%, IMU acceleration magnitude is 1.00 g at rest, `deriv(BARO.Alt)` correlates
0.94 with the FC's climb rate. `scripts/e2e-phase2.mjs`: 19 UI checks.

**UI bug found by the harness:** accepting a completion moved the caret one
frame later, so fast typing landed in the wrong place. Now set synchronously.

**Deferred / differences from §8:**
- Cross-log references (`log2:ATT.Roll`) wait for Phase 4 sync.
- Named expressions persist per machine (browser storage) until the workspace
  file exists (Phase 6); presets already carry them between machines.
- `rate` from the §8 list was dropped as ambiguous; `deriv()` and `dt()` cover it.
- Evaluation runs on the UI thread (fast enough: ~1 M samples in tens of ms);
  move to the worker if long chains of filters get slow.

## Appendix D. Phase 3 Results (2026-11-15)

**Delivered:**
- **3D map:** real flight track (POS 25 Hz, GPS fallback; decimated to ≤4000
  points), colored by flight mode, solid behind the playhead and dimmed ahead;
  aircraft model posed from ATT; home marker and mission waypoints; camera modes
  Free / Follow / Chase / Top; click the track to move the playhead; altitude
  reference Relative (default) or AMSL; prompt to download a map when the
  flight has none.
- **Offline map cache:** downloads run in the main process with Node's fetch
  (the only network use, on request). Each area is two MBTiles files
  (imagery, terrain) read with Node's built-in `node:sqlite`, so there are no
  native modules. Tiles are served through `hl-tiles://`. Downloads are
  concurrent, retried, resumable and cancellable, with a size estimate up front.
  Defaults: **USGS National Map imagery** (public domain, cached to zoom 16 ≈
  1.6 m/px at 47° N) and **AWS Terrarium terrain** (to zoom 15); a custom XYZ
  URL is supported.
- **Terrain:** `CustomHeightmapTerrainProvider` decoding Terrarium PNGs, falling
  back to the nearest cached ancestor tile outside the detailed area.
- **Horizon window:** canvas PFD (horizon, pitch ladder, roll scale and pointer,
  heading tape, speed and altitude tapes, mode, armed state); sources chosen in
  ⚙. `drawAdi()` is a standalone function for the Phase 5 overlay and Phase 7
  export.
- **Aircraft model:** generated by `scripts/gen-plane-model.mjs` (our own, 7 KB):
  red left wingtip, green right wingtip.

**Design change (§7.1):** no EGM96 geoid grid is needed. Terrarium heights are
above mean sea level, the same datum as the log's AMSL altitudes. With terrain
and aircraft in one datum, the plane can never sit underground or float, in
either mode. Relative mode places home on the cached terrain (fallback: the
FC's `TERR.TerrH`, then home altitude). At the reference field: cached terrain
11.3 m, FC terrain 9.3 m.

**Verified:** `scripts/e2e-phase3.mjs`, 19 checks:
- a real download of the field (123 tiles, 5.5 MB, 2.5 s);
- terrain and ground height;
- all camera modes keep the aircraft centred;
- playback, click-to-seek, AMSL mode;
- horizon values;
- after a restart, the cache works offline.

The aircraft orientation was checked against ATT: at 380 s, −43.9° roll
(left wing low) and +23.9° pitch render correctly.

**Bugs found:**
- The model's triangle winding was inverted (faces culled), fixed.
- A whole-globe camera saved before the log loaded was being restored; cameras
  are now remembered per flight.
- The horizon's tape labels were clipped, fixed.

**Not yet done:**
- Fence display (no fence in the reference log to test against).
- Imagery sharper than zoom 16 needs a provider other than USGS.
- Map attribution uses Cesium's credit display, which includes the Cesium logo.

## Appendix E. Phase 4 Results (2026-11-15)

**Delivered:**
- **Video import:** MP4/MOV read in place through range requests. The
  container index is parsed even when `moov` sits after a multi-GB `mdat`
  (only the index is read). Frames are decoded on demand with WebCodecs, one
  GOP per read, with edit lists, open GOPs, rotation and VFR handled. Audio
  (AAC) is decoded once into a min/max/RMS waveform.
- **Time-sync solver** (`src/core/timesync`): offset, plus drift when markers
  span ≥ 60 s; chaining through other streams; refinement passes; per-marker
  residuals; drift warning; offset-only option; nudges (±1 frame, ±1 ms).
- **Sync tab:**
  - one lane per stream: log lanes plot throttle, ESC RPM and IMU accel
    magnitude by default (editable, any expression); video lanes show the
    audio waveform;
  - Local mode (each lane scrubs in its own time) and Aligned mode (master
    time, ticks labelled in master time);
  - named events, markers placed with M and dragged by their head;
    frame/sample stepping;
  - snap to edge (RPM half-rise, audio onset), accepted with Enter;
  - a warning when "prop start" is placed on the throttle *command*;
  - video preview, and a results table with offset, drift and residuals.
- **Video window:**
  - follows the master playhead through the mapping;
  - shows the exact frame when paused;
  - uses the native player when playing, at speed ÷ a, re-locked beyond one
    frame;
  - shows "starts in…" and "not synced" states.
- **Mapping elsewhere:** graphs plot a second log's channels in master time,
  and the timeline domain includes synced videos.

**Verified:** 9 new unit tests (57 total). `scripts/e2e-phase4.mjs` (14
checks) uses a synthetic ground-camera clip with known truth (camera started at
log 297.5 s, clock +300 ppm; flash plus audio at log 314.20 s and 400.00 s):
- audio snap finds both events within 7 ms;
- the solver recovers 289 ppm and 297.507 s;
- the mapping error at both events is 7.1 ms and 6.1 ms, under a frame;
- in Review, the frame two frames before each event is dark and the frame one
  frame after is the flash;
- playback stays within 13–42 ms;
- opening the clip reads 1.17 of 2.60 MB.

**Design changes:**
- **No ffmpeg in Phase 4.** Probing, waveform and frame-accurate decode use
  mp4box.js and WebCodecs. Proxies for codecs a machine can't decode are
  deferred to Phase 7, which needs an encoder anyway; until then the Import
  tab says when a codec isn't decodable. Phase 7 should first evaluate
  WebCodecs `VideoEncoder` with an MP4 muxer before adding an ffmpeg binary.
- Video lanes show the audio waveform and a frame preview, not a thumbnail
  strip.

**Deferred:**
- Auto-suggest offsets from file timestamps (Phase 8, together with tlog↔bin).
- Sync state is in memory until the workspace file (Phase 6).
- ~~Digital zoom/crop in the Video window~~ (done in Phase 5).
- Matroska/WebM import.

## Appendix F. Phase 5 Results (2026-11-15)

**Delivered:**
- **Overlays (§7.7)** on the Map, Video, Graph and Horizon windows:
  - **readouts:** any number of lines, each a channel, a named or inline
    expression, or `@mode` / `@armed` / `@time` / `@local`; printf-style
    formats; units; interpolate or hold; text auto-fits its box;
  - **horizon overlay:** the ADI drawing code in a new see-through HUD style
    (horizon, ladder and roll scale with a dark halo, readable over video), or
    the filled ball, with optional tapes;
  - **edit mode** (▣ in the window header): add, select, drag (snaps to edges
    and centre; Alt disables snapping), resize with eight handles, nudge with
    the arrow keys, delete with Del, and a properties panel that opens on the
    side away from the selection. Unknown channels and bad formats are flagged
    while typing, with the current value shown live;
  - normalized rects stored in the window's parameters, so they are in the
    layout JSON.
- **Video digital zoom/crop:** wheel zooms about the cursor (up to 8×), drag
  pans, double-click or the badge resets. Overlays stay fixed while the frame
  zooms. The zoom rect is saved per window and maps directly to an export crop
  (`cropRect`).
- **Pop-out polish:**
  - **monitor memory:** the main window and each pop-out reopen where they last
    were (by window id, then window type, then the last pop-out), within a
    session and across restarts; if that monitor is gone, the default placement
    applies;
  - review keys (Space, ←/→ step 1/30 s, Shift 1 s, Home/End) work inside
    pop-outs;
  - pop-out windows are titled after their window ("HuskyLog — Video").

**Verified:** 10 new unit tests (67 total). `scripts/e2e-phase5.mjs` (30
checks, three app launches, run on the secondary monitor):
- readout values match the log (altitude; `BAT.Volt * BAT.Curr` at a BAT
  sample; flight mode), follow the playhead, and flag an unknown channel;
- drag, corner resize and arrow nudge produce the expected normalized rects;
- relative position holds when the window shrinks from 746 to 420 px;
- the HUD paints about 8 % of its box;
- zoom keeps the point under the cursor fixed;
- the Video window with overlays pops out, renders and can be edited there;
  Space and arrow keys work in it;
- moved pop-out and main windows come back at the same place after docking
  back and after a restart, and fall back to a connected monitor when the
  saved position is off-screen.

Phases 0–4 harnesses still pass.

**Design changes:**
- No font size on overlays: text fits its box, so a readout looks the same at
  any window or export size.
- Saved window bounds are re-applied with `setBounds` after creation, and
  changes of ≤ 2 px from the restored bounds are not saved. On a monitor
  scaled differently from the primary (125 % here), Windows rounds sizes on
  every restore, and saving the rounded size made the main window grow ~5 px
  per launch.
- Window-state events: `move`/`resize` (not `moved`/`resized`, which don't
  fire for programmatic changes), and a pop-out closed by dockview gets
  `closed` but no `close`, so bounds are recorded continuously.

**Deferred:**
- Workspace save of overlays, zoom and pop-out layout (Phase 6; the data is
  already in the layout JSON).
- Overlay drawing in export (Phase 7 uses `drawOverlays` and `cropRect`).
- Overlays on the table windows.

## Appendix G. Phase 6 Results (2026-11-15)

**Delivered:**
- **Workspace (`.hlws`)**, from File → Save / Save As (Ctrl+S, Ctrl+Shift+S).
  It holds streams, sync (events, markers, options, reference), the dockview
  layout (every window's config, overlays, video zoom, pop-out windows with
  their positions), named expressions, map cameras, playhead, selection,
  speed and tab. Format versioned in `core/workspace` with a migration hook.
- **File references:** absolute path, path relative to the workspace, and a
  quick hash (size + first/last 64 KB). On open, HuskyLog tries the relative
  path, the absolute path, then the workspace folder. Files still missing are
  listed on the Import tab with **Locate…**, which checks size and hash and
  warns if a different file is chosen. Missing streams keep their saved
  reference when you save again.
- **Opening a session** (File → Open, Ctrl+O, double-click, or a file on the
  command line): main validates the file, closes pop-outs and reloads the
  window into a clean state, then hands over the resolved session at boot. A
  broken file shows an error and leaves the current session alone.
- **Pack & Go (`.hlpack`)**, in all three video modes, with a per-file size
  estimate, progress and cancel:
  - our own ZIP writer/reader (ZIP64, UTF-8 names, streamed, CRC and SHA-256
    in one pass), readable by Windows' `tar` and Expand-Archive;
  - `workspace.hlws`, `manifest.json` (sha256 per entry), `streams/<id>/…`
    and `maps/…`;
  - **trim** and **re-encode** write a new MP4 (moov at the end, edit lists
    keep exact presentation times) and shift that video's markers by the cut.
- **Open in place:** stored entries are served from inside the zip by byte
  range (`hl-file://local/<pack>!/<entry>`), compressed logs are extracted
  once to a per-pack cache, and map areas are imported into the map cache.
- **Saving into an open pack** rewrites only `workspace.hlws` and
  `manifest.json`: they are appended and a new central directory is written,
  so media offsets stay valid while the pack is being served.
- **Unsaved changes:** a ● in the title and File menu. HuskyLog asks before
  New, Open, opening from Explorer, and closing the window (Save / Don't save
  / Cancel). One running instance: double-clicking a pack while HuskyLog is
  open hands it to that window.

**Verified:** 11 new unit tests (78 total): zip round-trip, ZIP64, in-place
replace, Windows interop, workspace parse/migrate/paths, and MP4 trim of a
B-frame clip with identical bytes and frame times, audio within 2 µs.
`scripts/e2e-phase6.mjs` (37 checks, three app launches, secondary monitor):
- save, dirty tracking and title;
- packs in all three modes: full 20.2 MB, trim 18.4 MB (video 2.60 → 0.79 MB
  for a 40 s selection), re-encode 21.9 MB;
- the broken-pack error;
- reopening the trimmed and re-encoded packs restores the same stream ids,
  sync, windows, graph series, overlays, zoom, expressions, playhead and
  pop-out, and the video still shows the flash on the right frame at the
  "Wave" event;
- Ctrl+S into a pack;
- the close guard and the New prompt;
- **laptop B:** fresh profile, original files deleted, pack opened from the
  command line, identical session, map tiles drawn from the pack, zero
  network requests;
- a workspace whose files moved lists them as missing, and Locate… restores
  the synced session.

Phases 0–5 harnesses still pass.

**Design changes:**
- **No ffmpeg.** Trim is a stream copy by our MP4 writer. Re-encode uses
  WebCodecs `VideoEncoder` (platform H.264) with the same writer, the path
  Phase 7 export will reuse.
- **Trim uses the selection** when a time range is selected, so you can pack
  just the interesting part of a flight; otherwise the reference-log overlap.
- **Named expressions belong to the session.** Opening a workspace sets
  exactly its expressions. A personal library on each computer still
  remembers every expression you define and seeds new sessions.
- Presets are not embedded separately: each graph's series are already in the
  layout.
- A workspace saved from an open pack refers to media inside that pack
  (`FileRef.pack`) instead of extracting it.
- Pop-outs restored from a layout open at the layout's position when that
  computer has no remembered position and the spot is on a connected monitor.

**Deferred:**
- Re-encode runs at about real time here (35 s of 720p in 30 s, using the
  `realtime` encoder mode to avoid B-frames). The `quality` mode with B-frame
  timing is worth evaluating with Phase 7 export.
- Verifying pack checksums on open (the manifest has them; reading GBs on
  every open is not worth it). A "Verify pack" command could use them.
- Subsetting map areas to the flight bbox (whole areas are copied today).
- Recent files list.

## Appendix H. Phase 7 Results (2026-11-15)

**Delivered:**
- **Export video…** on the Review toolbar opens a dialog:
  - windows: Map, Video, Graph and Horizon, any combination;
  - layout: as on screen, grid (auto columns), or picture-in-picture (the
    first window chosen is the main picture);
  - time range (defaults to the selection, else 10 s from the playhead);
  - MP4 at 720p, 1080p, 4K or a custom size, 24–60 fps, with optional audio
    from a synced video;
  - GIF ≤ 10 s at 480/640/800 px and 10–20 fps;
  - a live preview of the composite at the playhead, plus frames, ETA and
    Cancel while exporting.
- **Window draw functions** (the `drawFrame` of §7) for the Video, 3D Map,
  Graph and Horizon windows, registered per window. Overlays are drawn by
  the same code as on screen.
- **Shared H.264 path** (`video/h264.ts`): level picked from size and rate;
  "quality" mode, with decode times rebuilt and an edit list when the encoder
  uses B-frames. Pack & Go's re-encode now uses it too and got twice as fast
  (35 s of 720p in 14 s, was 30 s).
- **GIF encoder** with no dependency: exact palette for UI-style images,
  changed-rectangle frames, delays that keep the exact average rate.
- Writes go only to the path chosen in the save dialog (main keeps the list).

**Verified:** 3 new unit tests (81 total). The GIF encoder is checked by an
independent decoder, including LZW dictionary resets, exact colours, changed
rectangles and timing. `scripts/e2e-phase7.mjs` (21 checks, secondary
monitor) decodes the exported files back:
- **done-when:** a 60 s 1080p30 composite (video with HUD horizon and readout
  overlays + graph, with audio) exports at 27 frames/s. The file is H.264
  1920×1080 with exactly 1800 frames at exact times, and AAC audio.
- the flash at log 400 s is on exported frame 1560/1561 (frame-exact), the
  audio beep is 19 ms from it, and the HUD, readout and graph legend are
  present;
- picture-in-picture with the 3D map drawn from offline tiles;
- the as-on-screen layout keeps positions and proportions;
- the GIF (5 s, 15 fps, 640×360) has 75 frames, lasts 5.00 s and is in sync;
- GIF is refused over 10 s;
- cancel leaves no file and restores the playhead;
- no network requests.

Phases 0–6 harnesses still pass.

**Design changes:**
- **No ffmpeg anywhere** (it was planned for export and proxies). Encoding is
  WebCodecs plus our MP4 writer; GIF is our own encoder. The installer stays
  free of a GPL binary.
- Export drives the real playhead (paused, then restored) instead of a
  separate export clock, so every window renders through its normal path.
- The Messages and Parameters tables are not exportable.

**Deferred:**
- Audio drift: copied audio is not resampled, so with a clock difference
  of a = 1.0003 it drifts 0.3 ms per second of export (18 ms over 60 s). A
  per-export resample would remove it.
- Map and graph are copied at their on-screen resolution and scaled; drawing
  them at the output size (offscreen Cesium, an offscreen uPlot) would make
  4K exports sharper.
- Proxies for videos a machine can't decode (the export encoder makes them
  possible now).

## Appendix I. Distribution and updates (2026-11-15)

- **Installer:** NSIS per-user (no admin), unsigned for now (SmartScreen asks
  once on first install). File associations `.hlpack` / `.hlws`.
- **Releases:** GitHub Releases of this repo. `.github/workflows/build.yml`
  builds every push and PR (installer as an artifact). On a `vX.Y.Z` tag it
  checks that the tag matches `package.json`, runs typecheck and unit tests,
  and publishes the installer, blockmap and `latest.yml`.
  `npm run release:patch|minor` bumps, tags and pushes.
- **Updater** (`src/main/updater.ts`, electron-updater):
  - one quiet check about 8 s after launch, from the main process on
    electron-updater's own session partition, so the renderer stays behind
    the offline guard;
  - offline failures are logged to `%APPDATA%/HuskyLog/logs/updater.log` and
    shown only for a manual check (File → Check for updates…);
  - updates download in the background (incremental via blockmaps when
    possible);
  - "Restart to update" asks to save, then installs silently and relaunches;
    otherwise the update installs on the next quit;
  - disabled in development and test runs; `HUSKYLOG_UPDATE_URL` points at a
    test feed.
- **Verified:** a packaged 0.0.1 app against a local feed serving a 0.0.2
  build finds it, downloads it and offers Restart to update. Offline, the
  launch check is silent and a manual check reports it. The final install
  step was not exercised on this machine.
- **Later:** code signing (Azure Trusted Signing or an OV certificate, added to
  the workflow) and an app icon (the default Electron icon is used today).

## Appendix J. Multi-video export performance (2026-11-16)

**Problem (team report):** export slowed sharply with more than one video and
crashed with several 4K feeds. Measured on an i7-1360P laptop (16 GB, Iris Xe):
three 4K feeds decoded at 4 frames/s, and the full export crashed the renderer.

**Causes:**
- the scrub cache kept 90 full-size bitmaps per video (4K: ~3 GB each);
- every cache miss started a new decoder at the previous keyframe;
- live Video windows decoded the same frames again during export;
- Chrome's 'high' image smoothing builds a mipmap chain of the whole 4K frame
  on every draw (~30 ms per 4K frame on this GPU). The cost lands when the
  canvas is read for encoding, so it looked like encoder time.

**Changes:**
- `video/FrameReader.ts`: export reads each feed with one decoder running
  straight through the range. Each sample is decoded once, frames stay
  VideoFrames, and at most a few are held per feed.
- `video/scale.ts`: frames are halved with bilinear steps, then drawn. This is
  as fast as 'low' smoothing and within 48–54 dB PSNR of 'high' ('low' alone:
  29–35 dB, visibly aliased).
- Live Video windows pause while an export runs.
- The scrub cache is capped at 384 MB per video, with bitmaps at most 1920 px
  on the long edge, shrunk on the GPU.
- Export results carry a timing breakdown (render, encode, per-window draw).

**Measured** (`npm run bench:export`, same machine, 1080p30 output; SolidWorks
was running, so absolute numbers are low):

| Feeds | Before | After |
|---|---|---|
| 1 / 2 / 3 × 1080p60 | 15.7 / 14.8 / 9.7 fps | 30.4 / 30.2 / 27.4 fps |
| 3 × 1080p60 + map + graph | 10.4 fps | 23.1 fps |
| 3 × 4K30 (50 Mbit/s) | crashed | 13–23 fps |
| Scrubbing 3 × 4K | 2.6–4.2 fps | 9.9–11.5 fps |

**Tried and dropped** (no measurable gain): having the feeds take turns on the
hardware decoder, and a software H.264 encoder.

**Verified:** a new Phase 7 check exports two feeds synced 0.5 s apart; each
tile's flash is on its exact frame (Phase 7: 23/23). Phases 4 and 6, the UX
harness and the unit tests pass. The Phase 5 window-position checks and one
Sync playback timing check fail the same way on `main`, so that is the
machine's state.

**Open:**
- A full-frame 3D map can wait over a second per frame for its map tiles to
  load at some points in a flight (0.8 fps seen).
- On-screen digital zoom of 4K video uses the 1920 px cached frames. Export
  still uses full resolution.
