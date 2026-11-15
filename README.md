# HuskyLog

Offline Windows app for reviewing DBF flight tests: ArduPilot DataFlash logs
plus ground videos, CSV sensor logs and MAVLink telemetry, synced on one
timeline. MIT licensed. See [docs/DESIGN.md](docs/DESIGN.md).

## Install (team)

1. Download `HuskyLog-Setup-x.y.z.exe` from the
   [latest release](https://github.com/lincolntrahan/HuskyLog/releases/latest).
2. Run it. Windows SmartScreen may say "Windows protected your PC" because the
   installer is not code-signed yet: click **More info → Run anyway**. This
   happens only on the first install.
3. It installs for your Windows user only (no admin rights needed) and opens
   `.hlpack` / `.hlws` files when double-clicked.

**Updates:** HuskyLog checks GitHub once, quietly, shortly after it starts.
Offline (at the field) the check simply does nothing. When a new version is
found it downloads in the background and the status bar shows **Restart to
update** (it asks to save first). If you ignore it, the update installs the
next time you close HuskyLog. **File → Check for updates…** checks on demand.
The app's windows never go online; only this check does, from the main process.

## Release a new version

```bash
npm run release:patch   # 0.1.0 → 0.1.1 (fixes)
npm run release:minor   # 0.1.1 → 0.2.0 (features)
```

Each bumps `package.json`, commits, tags `vX.Y.Z` and pushes. GitHub Actions
([build.yml](.github/workflows/build.yml)) then typechecks, runs the unit
tests, builds the installer and publishes it as a GitHub Release with
`latest.yml`. Installed copies pick it up on their next launch. Edit the
release on GitHub to add notes; they appear under **What's new** in the app.

Every push and pull request also builds the installer (without publishing);
download it from the workflow run's artifacts to try a build before releasing.

## Develop

```bash
npm install
npm run dev          # app with hot reload
npm run typecheck
npm test             # unit tests
npm run build        # production bundle in out/
npm run dist         # Windows installer in release/ (local, not published)
```

## Test harness

```bash
npm run gen:testdata # synthetic H.264 / HEVC / VFR clips (needs ffmpeg-static)
npm run build && npm run e2e          # Phase 0 spikes (pop-outs, Cesium, video)
npm run e2e:phase1                     # logs, graphs, stats, CSV, presets (needs the reference log)
npm run e2e:phase2                     # expressions (needs the reference log)
npm run e2e:phase3                     # 3D map, map cache (downloads ~5 MB once), horizon
npm run gen:syncvideo && npm run e2e:phase4   # video import + Sync tab (synthetic clip with known truth)
npm run e2e:phase5                     # overlays, video zoom, pop-outs, monitor memory
npm run e2e:phase6                     # workspaces, Pack & Go (all modes), "laptop B"
npm run e2e:phase7                     # MP4 / GIF export (decodes the output back)
```

`e2e` drives the built app with Playwright and writes screenshots to `.e2e/`.
Windows open on a secondary monitor when one exists, without taking focus
(`HUSKYLOG_DISPLAY=primary` to override). Set `HUSKYLOG_EXE` to the path of a
packaged `HuskyLog.exe` to test the installed build instead. Test runs never
check for updates (`HUSKYLOG_UPDATE_URL` points a build at a test feed).

The Phase 1 harness and the golden parser tests use a reference log at
`test-data/logs/reference.bin` (not committed; set `HUSKYLOG_REF_LOG` to use
another path). Without it those tests are skipped.
