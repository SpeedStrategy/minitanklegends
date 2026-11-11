# Tank Legends — Desktop App

The game in its own dedicated window. The game itself is **never bundled** —
the app always loads the live build from **https://tanklg.pages.dev/**, so a
game update on the site updates every desktop player automatically. The
Electron *shell* around it also auto-updates (see **Updates** below).

```
desktop/
  package.json     version + electron-builder config (this file's version
                   is the app version the player sees)
  src/main.js      main process: window, permissions, updates, host-stability
  src/preload.js   exposes window.TankLegendsDesktop to the site (safe bridge)
  src/offline.html shown when tanklg.pages.dev can't be reached
  build/icon.png   the app icon (tank legends logo new.png, 1254×1254)
  scripts/make-update-feed.mjs  builds the update feed for the site
```

---

## Run it from source (no installer)

Double-click `run-app.cmd`, or:

```
cd desktop
..\MiniTankLegendsCline\node-v22\node-v22.18.0-win-x64\node.exe node_modules\electron\cli.js .
```

Dev overrides:

| Switch / env | What it does |
|---|---|
| `--game-url=http://localhost:5173/` | load your local dev server instead of the live site |
| `TL_GAME_URL=...` | same, as an env var |
| `TL_NO_UPDATE=1` | skip update checks |
| `--smoke-test` | hidden window, exits 0 once the site loads (CI sanity check) |
| `TL_SAFE_GPU=1` / `--safe-gpu` | turn OFF the GPU-boost switches (for a misbehaving driver) |
| `TL_UNCAP=1` / `--uncapped` | drop vsync/frame-rate caps — FPS above the monitor's refresh |

---

## Electron advantages baked in (and why they matter)

| Advantage | What it does for the game |
|---|---|
| **Live-content auto-update** | Game is never bundled; every launch loads what's live on tanklg.pages.dev. A site deploy updates every player. |
| **Shell auto-update** | electron-updater checks `tanklg.pages.dev/updates/`; downloads in background, applies on quit. |
| **No background throttling** | `backgroundThrottling:false` + a powerSaveBlocker: a host who alt-tabs keeps ticking at 60 Hz instead of the ~1 Hz a background browser tab gets. |
| **Private GPU process** | No other tabs, no extensions, no memory-saver discarding the page mid-match. |
| **GPU-boost trio** | `ignore-gpu-blocklist` + `enable-gpu-rasterization` + `enable-zero-copy`: real GPU acceleration on GPUs Chromium blocklists, raster-on-GPU, one less texture upload per frame. Escape hatch: `TL_SAFE_GPU=1`. |
| **No autoplay block** | `autoplay-policy=no-user-gesture-required`: menu music and engine SFX start instantly, no "click to enable sound". |
| **Renderer crash auto-reload** | A crashed renderer reloads the game automatically (≤3/min); progress survives via localStorage. Browsers just show "Aw, Snap". |
| **Deep links** | `tanklegends://join/CODE` (also `?room=CODE`) opens the app straight into a multiplayer room — invite links can launch the app instead of a browser. Registered when packaged; macOS entry comes from the `protocols` build config. |
| **Uncapped FPS (opt-in)** | `TL_UNCAP=1` / `--uncapped` removes vsync + frame-rate limit for 144 Hz+ players. |
| **Own permission model** | Mic (voice chat), pointer lock and fullscreen granted without browser prompts. |

---

## Build installers

On this machine (Windows):

```
cd desktop
..\MiniTankLegendsCline\node-v22\node-v22.18.0-win-x64\npm.cmd run dist:win
```

produces `dist\TankLegends-Setup.exe` (installer) and
`dist\TankLegends-Portable.exe` (no install). First build downloads tooling
once, later builds are quick.

**Linux (AppImage/deb) and macOS (dmg/zip) cannot be built on Windows**
(AppImage needs symlinks, deb needs Ruby/fpm, macOS needs a Mac) — they are
built automatically by GitHub Actions, see **Releasing**. The same workflow
also builds Windows if you'd rather not build locally.

---

## Releases (this is the part to remember)

1. Bump `"version"` in `desktop/package.json` (this is the app version).
2. Commit, then tag and push:

   ```
   git tag desktop-v1.0.1
   git push origin desktop-v1.0.1
   ```

3. GitHub Actions (`.github/workflows/desktop-release.yml`) builds Windows,
   macOS and Linux, creates a release named after the tag, and **commits the
   update feed** (`updates/latest*.yml`) to the `dev` branch.
4. Pull that commit, then deploy the site the usual way
   (`DEPLOY-TO-CLOUDFLARE.bat`). That makes
   `https://tanklg.pages.dev/updates/latest.yml` exist, which is exactly what
   the installed apps check.

Order matters: release first, site deploy second. The HUB's download buttons
point at `github.com/SpeedStrategy/minitanklegends/releases/latest/download/…`
and 404 until the first release exists.

### Why the feed is on tanklg.pages.dev but the installers are on GitHub

Cloudflare caps a single file at **25 MiB**; a Windows installer is ~90 MB.
So the tiny `latest.yml` feed (and therefore the "auto-update URL") lives on
your domain, and its file entries point at the release assets on GitHub. The
`make-update-feed.mjs` script does that rewrite. If the installers ever move
to hosting without the cap, point the script's `--base` at your host and the
feed becomes fully self-hosted.

---

## What "auto-updating" actually updates

- **Game content**: always. Every launch loads whatever is live on
  tanklg.pages.dev. Zero downloads, zero waiting, cannot drift.
- **The shell**: checked ~30 s after launch and every 4 h after that;
  downloaded in the background, installed on quit (or via the "Restart now"
  prompt). The shell rarely changes — only when Electron itself or the
  wrapper code changes.

## Notes & limits (honest ones)

- **Windows SmartScreen** will warn on the unsigned installer ("More info →
  Run anyway") — normal for projects without a code-signing certificate.
- **macOS auto-update** needs signing + notarization; until certificates are
  configured (see the workflow header), the dmg installs fine but the in-app
  updater stays quiet on macOS.
- **Android / iOS**: Electron does not support them. Mobile keeps playing in
  the browser (touch sticks already work). If a mobile app is ever wanted,
  the realistic paths are a Capacitor or Tauri-v2 wrapper around the same
  site — a separate project, not a config flag here.
