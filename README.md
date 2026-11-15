# HuskyLog

Offline Windows app for reviewing DBF flight tests: ArduPilot DataFlash logs
plus ground videos, CSV sensor logs and MAVLink telemetry, synced on one
timeline. MIT licensed. See [docs/DESIGN.md](docs/DESIGN.md).

## Develop

```bash
npm install
npm run dev          # app with hot reload
npm run typecheck
npm run build        # production bundle in out/
npm run dist         # Windows installer in release/
```

## Test harness

```bash
npm run gen:testdata # synthetic H.264 / HEVC / VFR clips (needs ffmpeg-static)
npm run build && npm run e2e          # Phase 0 spikes (pop-outs, Cesium, video)
npm run e2e:phase1                     # logs, graphs, stats, CSV, presets (needs the reference log)
npm run e2e:phase2                     # expressions (needs the reference log)
```

`e2e` drives the built app with Playwright and writes screenshots to `.e2e/`.
Windows open on a secondary monitor when one exists, without taking focus
(`HUSKYLOG_DISPLAY=primary` to override). Set `HUSKYLOG_EXE` to the path of a
packaged `HuskyLog.exe` to test the installed build instead.

The Phase 1 harness and the golden parser tests use a reference log at
`test-data/logs/reference.bin` (not committed; set `HUSKYLOG_REF_LOG` to use
another path). Without it those tests are skipped.
