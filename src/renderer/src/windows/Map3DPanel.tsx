import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
// Import from @cesium/engine (not the `cesium` umbrella package): the umbrella
// pulls in Cesium's Knockout-based widgets, which need eval() and break our
// strict Content-Security-Policy. We build our own UI anyway.
import {
  CesiumWidget, ImageryLayer, TileMapServiceImageryProvider, EllipsoidTerrainProvider, Ion, buildModuleUrl,
} from '@cesium/engine';
import { Cartesian3, Color, HeadingPitchRoll, Math as CMath } from '@cesium/core';
import '@cesium/engine/Source/Widget/CesiumWidget.css';
import { useApp, type CameraState } from '../store';
import { diag } from '../debug';

// Offline: never use Cesium ion (it needs the network and a token).
Ion.defaultAccessToken = '';
// Cesium listens for pointermove/up on the *global* document unless the canvas
// has this (undocumented) flag. In a pop-out window the global document is the
// main window's, so drags would break. Cesium uses pointer capture, so
// element-level listeners are enough.
(HTMLCanvasElement.prototype as unknown as { disableRootEvents: boolean }).disableRootEvents = true;

/** Sample track near the reference log's field until real logs load (Phase 3). */
function demoTrack(): Cartesian3[] {
  const pts: Cartesian3[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    pts.push(Cartesian3.fromDegrees(-122.1052 + 0.0028 * Math.cos(a), 47.6603 + 0.0016 * Math.sin(2 * a), 40 + 30 * Math.sin(a)));
  }
  return pts;
}

function readCamera(v: CesiumWidget): CameraState {
  const c = v.camera.positionCartographic;
  return { lon: CMath.toDegrees(c.longitude), lat: CMath.toDegrees(c.latitude), height: c.height, heading: v.camera.heading, pitch: v.camera.pitch, roll: v.camera.roll };
}

function createViewer(el: HTMLElement, cam: CameraState | undefined): CesiumWidget {
  const viewer = new CesiumWidget(el, {
    baseLayer: ImageryLayer.fromProviderAsync(
      TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')),
    ),
    terrainProvider: new EllipsoidTerrainProvider(),
    useDefaultRenderLoop: false, // we drive rendering from the host window (see below)
    contextOptions: { webgl: { preserveDrawingBuffer: true } }, // lets export read pixels
  });
  viewer.entities.add({ polyline: { positions: demoTrack(), width: 3, material: Color.fromCssColorString('#4ea1ff') } });
  const c = cam ?? { lon: -122.1052, lat: 47.6545, height: 900, heading: 0, pitch: CMath.toRadians(-35), roll: 0 };
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(c.lon, c.lat, c.height),
    orientation: new HeadingPitchRoll(c.heading, c.pitch, c.roll),
  });
  return viewer;
}

export function Map3DPanel({ api }: IDockviewPanelProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const id = api.id;
    const d = (diag.maps[id] ??= { created: 0, frames: 0, hostIsPopout: false, contextLost: false });
    let viewer: CesiumWidget | null = null;
    let doc: Document | null = null;
    let stopped = false;
    let raf = 0;
    let rafWin: Window | null = null;

    const build = () => {
      const cam = useApp.getState().cameras[id];
      viewer = createViewer(el, cam);
      doc = el.ownerDocument;
      d.created += 1;
      d.frames = 0;
    };
    const teardown = () => {
      if (viewer && !viewer.isDestroyed()) {
        useApp.getState().setCamera(id, readCamera(viewer));
        viewer.destroy();
      }
      viewer = null;
    };

    // Render loop on the window that currently hosts the panel. A pop-out has its
    // own vsync and keeps animating when the main window is minimized.
    let lastTick = 0;
    const tick = () => {
      if (stopped) return;
      lastTick = performance.now();
      try {
        // Phase 0 finding: a WebGL context does not survive its host window
        // closing (re-docking a pop-out loses it). So whenever the panel moves to
        // another window, or the context is lost, rebuild the viewer and restore
        // the camera from the store. Rebuilding takes ~100 ms.
        const moved = el.ownerDocument !== doc;
        if (moved || !viewer || d.contextLost) {
          d.hostIsPopout = el.ownerDocument !== document;
          const strategy = (window.__hl['mapStrategy'] as string) ?? 'recreate';
          if (strategy === 'recreate' || !viewer || d.contextLost) {
            teardown();
            build();
            d.contextLost = false;
          } else {
            doc = el.ownerDocument;
          }
        }
        const canvas = viewer?.scene.canvas;
        if (viewer && canvas && el.clientWidth > 0 && el.clientHeight > 0) {
          viewer.resize();
          if (canvas.width > 0 && canvas.height > 0) {
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

    build();
    tick();
    // Watchdog: if the host window closes (pop-out closed, panel moved back),
    // its pending animation frame never fires. Restart the loop on the new host.
    const watchdog = window.setInterval(() => {
      if (!stopped && performance.now() - lastTick > 500 && (rafWin?.closed || rafWin !== el.ownerDocument.defaultView)) {
        tick();
      }
    }, 250);
    (window.__hl as Record<string, unknown>)[`snapshot:${id}`] = () => meanBrightness(viewer);
    (window.__hl as Record<string, unknown>)[`camera:${id}`] = () => (viewer ? readCamera(viewer) : null);

    return () => {
      stopped = true;
      window.clearInterval(watchdog);
      if (rafWin && !rafWin.closed) rafWin.cancelAnimationFrame(raf);
      teardown();
    };
  }, [api.id]);

  return <div ref={ref} className="hl-panel" />;
}

/** Average brightness of the rendered canvas (0–255). Used by the spike harness
 *  to prove the globe actually draws (and that export can read pixels). */
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
