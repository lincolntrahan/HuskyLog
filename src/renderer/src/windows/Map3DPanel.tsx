import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { OverlayLayer } from '../overlay/OverlayLayer';
import type { OverlayItem } from '../overlay/model';
// Import from @cesium/engine (not the `cesium` umbrella package): the umbrella
// pulls in Cesium's Knockout-based widgets, which need eval() and break our
// strict Content-Security-Policy. We build our own UI anyway.
import {
  CesiumWidget, ImageryLayer, TileMapServiceImageryProvider, UrlTemplateImageryProvider, EllipsoidTerrainProvider,
  Ion, buildModuleUrl, Transforms, Primitive, PolylineColorAppearance, CallbackProperty, Credit,
  ScreenSpaceEventHandler, ScreenSpaceEventType, SceneTransforms, type Entity,
} from '@cesium/engine';
import {
  Cartesian2, Cartesian3, Color, HeadingPitchRoll, HeadingPitchRange, Math as CMath, Matrix4, Rectangle, BoundingSphere,
  GeometryInstance, PolylineGeometry, ArcType,
} from '@cesium/core';
import '@cesium/engine/Source/Widget/CesiumWidget.css';
import type { MapArea } from '../../../shared/ipc';
import { unionBBox, PROVIDERS, type BBox } from '@core/maps/tiles';
import { useApp, type CameraState } from '../store';
import { diag } from '../debug';
import { primaryLog, useLogs } from '../data/logs';
import { useTimeline } from '../data/timeline';
import { decimateIndices, loadTrack, poseAt, type Track } from '../data/track';
import { createTerrainProvider, clearTerrainCache, terrainHeightAt } from '../map/terrain';
import { modeHue } from './graph/model';
import { MapCacheDialog, useMapAreas } from '../map/MapCacheDialog';

// Offline: never use Cesium ion (it needs the network and a token).
Ion.defaultAccessToken = '';
// Cesium listens for pointermove/up on the *global* document unless the canvas
// has this (undocumented) flag. In a pop-out window the global document is the
// main window's, so drags would break. Cesium uses pointer capture, so
// element-level listeners are enough.
(HTMLCanvasElement.prototype as unknown as { disableRootEvents: boolean }).disableRootEvents = true;

type CameraMode = 'free' | 'follow' | 'chase' | 'top';
type AltMode = 'relative' | 'amsl';
interface MapCfg { camera: CameraMode; alt: AltMode }

function readCamera(v: CesiumWidget): CameraState {
  const c = v.camera.positionCartographic;
  return { lon: CMath.toDegrees(c.longitude), lat: CMath.toDegrees(c.latitude), height: c.height, heading: v.camera.heading, pitch: v.camera.pitch, roll: v.camera.roll };
}

const modeColor = (name: string, alpha = 1) => Color.fromHsl(modeHue(name) / 360, 0.75, 0.55, alpha);

function areasCover(areas: MapArea[], b: BBox): boolean {
  return areas.some((a) => a.bbox[0] <= b[0] && a.bbox[1] <= b[1] && a.bbox[2] >= b[2] && a.bbox[3] >= b[3]);
}

export function Map3DPanel({ api, params }: IDockviewPanelProps<{ map?: MapCfg; overlays?: OverlayItem[] }>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [cfg, setCfgState] = useState<MapCfg>(params?.map ?? { camera: 'free', alt: 'relative' });
  const setCfg = (c: MapCfg) => { setCfgState(c); api.updateParameters({ map: c }); };
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const { areas, reload: reloadAreas } = useMapAreas();
  const [cacheOpen, setCacheOpen] = useState(false);
  const [track, setTrack] = useState<Track | null>(null);
  const [ground, setGround] = useState<{ h: number; source: string } | null>(null);
  const logs = useLogs();
  const primary = primaryLog();

  useEffect(() => {
    if (!primary) { setTrack(null); return; }
    void loadTrack(primary.id).then(setTrack);
  }, [primary?.id, logs]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasTerrain = areas.some((a) => a.terrain);
  // Ground height at home: cached terrain → FC terrain database → home altitude.
  useEffect(() => {
    if (!track?.home) { setGround(null); return; }
    const home = track.home;
    let cancelled = false;
    void (async () => {
      const h = hasTerrain ? await terrainHeightAt(home.lat, home.lng) : null;
      if (cancelled) return;
      if (h !== null) setGround({ h, source: 'cached terrain' });
      else if (track.terrainAtHome !== null) setGround({ h: track.terrainAtHome, source: 'FC terrain (TERR)' });
      else setGround({ h: home.alt, source: 'home altitude' });
    })();
    return () => { cancelled = true; };
  }, [track, hasTerrain, areas]);

  useEffect(() => {
    const el = hostRef.current!;
    const id = api.id;
    const d = (diag.maps[id] ??= { created: 0, frames: 0, hostIsPopout: false, contextLost: false });
    let viewer: CesiumWidget | null = null;
    let doc: Document | null = null;
    let stopped = false;
    let raf = 0;
    let rafWin: Window | null = null;
    let lastTick = 0;
    let past: Primitive | null = null;
    let pastIdx = -1;
    let lastPastBuild = 0;
    let aircraft: Entity | null = null;
    let handler: ScreenSpaceEventHandler | null = null;
    let lastMode: CameraMode | null = null;
    // Drawing state for the current track.
    let idx: number[] = [];
    let positions: Cartesian3[] = [];
    let colors: Color[] = [];
    const pose = { pos: Cartesian3.ZERO.clone(), quat: Transforms.headingPitchRollQuaternion(Cartesian3.fromDegrees(0, 0), new HeadingPitchRoll()) };

    const heightAt = (i: number) => {
      if (!track) return 0;
      if (cfgRef.current.alt === 'amsl') return track.altAmsl[i]!;
      // Relative: ground at home (same MSL datum as the terrain) + height above home.
      // With no terrain the globe is the ellipsoid, so "ground" is 0.
      return (hasTerrain ? (ground?.h ?? 0) : 0) + track.relAlt[i]!;
    };

    // Cameras are remembered per flight, so a view saved before the log loaded
    // (whole-globe) is never restored over the flight.
    const camKey = `${id}:${track?.stream ?? 'none'}`;
    const build = () => {
      const cam = useApp.getState().cameras[camKey];
      const imageryAreas = areas.filter((a) => a.tiles > 0);
      const bbox = unionBBox(imageryAreas.map((a) => a.bbox));
      viewer = new CesiumWidget(el, {
        baseLayer: ImageryLayer.fromProviderAsync(TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'))),
        terrainProvider: hasTerrain ? createTerrainProvider() : new EllipsoidTerrainProvider(),
        useDefaultRenderLoop: false, // rendering is driven from the host window (see tick)
        showRenderLoopErrors: false,
        contextOptions: { webgl: { preserveDrawingBuffer: true } }, // lets export read pixels
      });
      if (bbox) {
        const maxZ = Math.max(...imageryAreas.map((a) => a.imageryMaxZoom));
        viewer.imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({
          url: 'hl-tiles://any/imagery/{z}/{x}/{y}',
          maximumLevel: maxZ,
          rectangle: Rectangle.fromDegrees(...bbox),
          credit: new Credit(imageryAreas[0]!.imageryAttribution || PROVIDERS['usgs']!.attribution),
        }));
      }
      viewer.scene.globe.depthTestAgainstTerrain = hasTerrain;
      doc = el.ownerDocument;
      d.created += 1;
      d.frames = 0;
      populate(cam);
    };

    const populate = (cam: CameraState | undefined) => {
      const v = viewer!;
      if (track) {
        idx = decimateIndices(track);
        positions = idx.map((i) => Cartesian3.fromDegrees(track.lng[i]!, track.lat[i]!, heightAt(i)));
        colors = idx.map((i) => {
          const t = track.t[i]!;
          const m = track.modes.find((s) => t >= s.t0 && t < s.t1);
          return modeColor(m?.name ?? '');
        });
        // Whole flight, dimmed (the part ahead of the playhead stays dim).
        v.scene.primitives.add(new Primitive({
          geometryInstances: new GeometryInstance({
            geometry: new PolylineGeometry({ positions, colors: colors.map((c) => c.withAlpha(0.35)), width: 2, arcType: ArcType.NONE }),
          }),
          appearance: new PolylineColorAppearance({ translucent: true }),
          asynchronous: false,
        }));
        if (track.home) {
          const hp = Cartesian3.fromDegrees(track.home.lng, track.home.lat, cfgRef.current.alt === 'amsl' ? track.home.alt : hasTerrain ? (ground?.h ?? 0) : 0);
          v.entities.add({ position: hp, point: { pixelSize: 9, color: Color.fromCssColorString('#3ddc97'), outlineColor: Color.BLACK, outlineWidth: 1 }, label: { text: 'H', font: 'bold 12px sans-serif', pixelOffset: new Cartesian2(0, -14), fillColor: Color.WHITE } });
        }
        for (const m of track.mission) {
          v.entities.add({ position: Cartesian3.fromDegrees(m.lng, m.lat, (track.home?.alt ?? 0) + m.alt), point: { pixelSize: 7, color: Color.fromCssColorString('#ffb000') }, label: { text: String(m.seq), font: '11px sans-serif', pixelOffset: new Cartesian2(0, -12) } });
        }
        aircraft = v.entities.add({
          position: new CallbackProperty(() => pose.pos, false) as never,
          orientation: new CallbackProperty(() => pose.quat, false) as never,
          model: { uri: './models/plane.glb', minimumPixelSize: 56, maximumScale: 4000 },
        });
        if (!cam) {
          const sphere = BoundingSphere.fromPoints(positions);
          v.camera.flyToBoundingSphere(sphere, { duration: 0, offset: new HeadingPitchRange(0, CMath.toRadians(-35), Math.max(300, sphere.radius * 2.6)) });
        }
        // Click near the track → move the playhead there.
        handler = new ScreenSpaceEventHandler(v.scene.canvas);
        handler.setInputAction((e: { position: { x: number; y: number } }) => {
          let best = -1, bestD = 12 * 12;
          for (let k = 0; k < positions.length; k++) {
            const w = SceneTransforms.worldToWindowCoordinates(v.scene, positions[k]!);
            if (!w) continue;
            const dd = (w.x - e.position.x) ** 2 + (w.y - e.position.y) ** 2;
            if (dd < bestD) { bestD = dd; best = k; }
          }
          if (best >= 0) useTimeline.getState().setT(track.t[idx[best]!]!);
        }, ScreenSpaceEventType.LEFT_CLICK);
      }
      if (cam) {
        v.camera.setView({ destination: Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height), orientation: new HeadingPitchRoll(cam.heading, cam.pitch, cam.roll) });
      } else if (!track) {
        v.camera.setView({ destination: Cartesian3.fromDegrees(-98, 39, 6_000_000) });
      }
      pastIdx = -1;
      lastMode = null;
    };

    const teardown = () => {
      handler?.destroy();
      handler = null;
      if (viewer && !viewer.isDestroyed()) {
        viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        useApp.getState().setCamera(camKey, readCamera(viewer));
        viewer.destroy();
      }
      viewer = null;
      past = null;
      aircraft = null;
    };

    const updatePose = (t: number) => {
      if (!track || !viewer) return;
      const p = poseAt(track, t);
      const h = cfgRef.current.alt === 'amsl' ? p.altAmsl : (hasTerrain ? (ground?.h ?? 0) : 0) + p.relAlt;
      pose.pos = Cartesian3.fromDegrees(p.lng, p.lat, h);
      // Compass yaw (0 = north, clockwise) → Cesium heading (0 = east).
      pose.quat = Transforms.headingPitchRollQuaternion(pose.pos, new HeadingPitchRoll(CMath.toRadians(p.yaw - 90), CMath.toRadians(p.pitch), CMath.toRadians(p.roll)));
      if (aircraft) aircraft.show = t >= track.t[0]! && t <= track.t[track.t.length - 1]!;

      // Bright "flown so far" segment, rebuilt at most ~8×/s.
      let k = 0;
      while (k < idx.length - 1 && track.t[idx[k + 1]!]! <= t) k++;
      const now = performance.now();
      if (k !== pastIdx && (now - lastPastBuild > 120 || !useTimeline.getState().playing)) {
        if (past) viewer.scene.primitives.remove(past);
        past = null;
        if (k >= 1) {
          past = viewer.scene.primitives.add(new Primitive({
            geometryInstances: new GeometryInstance({
              geometry: new PolylineGeometry({ positions: positions.slice(0, k + 1), colors: colors.slice(0, k + 1), width: 3.5, arcType: ArcType.NONE }),
            }),
            appearance: new PolylineColorAppearance(),
            asynchronous: false,
          })) as Primitive;
        }
        pastIdx = k;
        lastPastBuild = now;
      }

      // Camera modes.
      const mode = cfgRef.current.camera;
      const cam = viewer.camera;
      const enu = Transforms.eastNorthUpToFixedFrame(pose.pos);
      if (mode === 'free') {
        if (lastMode && lastMode !== 'free') cam.lookAtTransform(Matrix4.IDENTITY);
      } else if (mode === 'follow') {
        // Keep the camera's offset from the aircraft (user can still orbit/zoom).
        const offset = lastMode === 'follow'
          ? Cartesian3.clone(cam.position)
          : Matrix4.multiplyByPoint(Matrix4.inverse(enu, new Matrix4()), cam.positionWC, new Cartesian3());
        if (Cartesian3.magnitude(offset) < 5 || lastMode !== 'follow' && Cartesian3.magnitude(offset) > 5000) Cartesian3.fromElements(-60, -60, 40, offset);
        cam.lookAtTransform(enu, offset);
      } else if (mode === 'chase') {
        const range = lastMode === 'chase' ? Math.max(4, Cartesian3.magnitude(cam.position)) : 12;
        cam.lookAtTransform(enu, new HeadingPitchRange(CMath.toRadians(p.yaw), CMath.toRadians(-12), range));
      } else if (mode === 'top') {
        const range = lastMode === 'top' ? Math.max(20, Cartesian3.magnitude(cam.position)) : 250;
        cam.lookAtTransform(enu, new HeadingPitchRange(0, -CMath.PI_OVER_TWO + 0.0001, range));
      }
      lastMode = mode;
    };

    const tick = () => {
      if (stopped) return;
      lastTick = performance.now();
      try {
        // A WebGL context does not survive its host window closing, so rebuild
        // whenever the panel moves window (or the context is lost); ~100 ms.
        const moved = el.ownerDocument !== doc;
        if (moved || !viewer || d.contextLost) {
          d.hostIsPopout = el.ownerDocument !== document;
          teardown();
          if (el.isConnected && el.clientWidth > 0) build();
          d.contextLost = false;
        }
        const canvas = viewer?.scene.canvas;
        if (viewer && canvas && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0) {
          viewer.resize();
          if (canvas.width > 0 && canvas.height > 0) {
            updatePose(useTimeline.getState().t);
            viewer.render();
            d.frames += 1;
          }
          const gl = (viewer.scene as unknown as { context: { _gl: WebGLRenderingContext } }).context._gl;
          d.contextLost = gl.isContextLost();
        }
      } catch (err) {
        d.lastError = String(err);
      }
      rafWin = el.ownerDocument.defaultView ?? window;
      raf = rafWin.requestAnimationFrame(tick);
    };

    tick();
    // Watchdog: if the host window closes, its pending frame never fires.
    const watchdog = window.setInterval(() => {
      if (!stopped && performance.now() - lastTick > 500 && (rafWin?.closed || rafWin !== el.ownerDocument.defaultView)) tick();
    }, 250);
    const hl = window.__hl as Record<string, unknown>;
    hl[`snapshot:${id}`] = () => meanBrightness(viewer);
    hl[`camera:${id}`] = () => (viewer ? readCamera(viewer) : null);
    hl[`mapState:${id}`] = () => ({
      layers: viewer?.imageryLayers.length ?? 0,
      terrain: hasTerrain, trackPoints: positions.length, ground,
      aircraft: !!aircraft?.show, pastIdx,
      aircraftWindow: viewer ? SceneTransforms.worldToWindowCoordinates(viewer.scene, pose.pos) : null,
      tilesLoaded: viewer?.scene.globe.tilesLoaded ?? false,
    });

    return () => {
      stopped = true;
      window.clearInterval(watchdog);
      if (rafWin && !rafWin.closed) rafWin.cancelAnimationFrame(raf);
      teardown();
    };
  }, [api.id, track, areas, hasTerrain, ground, cfg.alt]); // eslint-disable-line react-hooks/exhaustive-deps

  const covered = track ? areasCover(areas, track.bbox) : true;
  const modes: [CameraMode, string, string][] = [['free', 'Free', 'Free camera'], ['follow', 'Follow', 'Follow the aircraft at a fixed offset (orbit/zoom still work)'], ['chase', 'Chase', 'Behind the aircraft'], ['top', 'Top', 'Top-down over the aircraft']];
  return (
    <div className="hl-panel map-panel">
      <div ref={hostRef} className="map-host" />
      <OverlayLayer api={api} initial={params?.overlays} />
      <div className="map-bar">
        {modes.map(([m, label, title]) => (
          <button key={m} className={cfg.camera === m ? 'primary' : ''} title={title} onClick={() => setCfg({ ...cfg, camera: m })} disabled={!track && m !== 'free'}>{label}</button>
        ))}
        <select value={cfg.alt} onChange={(e) => setCfg({ ...cfg, alt: e.target.value as AltMode })} aria-label="Altitude reference"
          title="Relative: ground at home + height above home (takeoff always sits on the ground). AMSL: the log's absolute altitude.">
          <option value="relative">Alt: relative to home</option>
          <option value="amsl">Alt: AMSL (absolute)</option>
        </select>
        <button onClick={() => setCacheOpen(true)} title="Download imagery and terrain for offline use">Map cache…</button>
      </div>
      {track && !covered && (
        <div className="map-banner">
          No offline map for this flight yet. <button className="primary" onClick={() => setCacheOpen(true)}>Download map area…</button>
        </div>
      )}
      {!primary && <div className="map-banner muted">Load a .bin log on the Import tab to see the flight.</div>}
      {cacheOpen && <MapCacheDialog track={track} logName={primary?.name ?? 'area'} areas={areas} onClose={() => { setCacheOpen(false); clearTerrainCache(); void reloadAreas(); }} />}
    </div>
  );
}

/** Average brightness of the rendered canvas (0–255). Used by the harness to
 *  prove the globe actually draws (and that export can read pixels). */
function meanBrightness(v: CesiumWidget | null): number {
  if (!v) return -1;
  const src = v.scene.canvas;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, 64, 64);
  const px = ctx.getImageData(0, 0, 64, 64).data;
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
  return s / (px.length / 4);
}
