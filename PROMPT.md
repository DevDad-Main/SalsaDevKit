# SalsaDevKit — Build Prompt for an LLM Session

> **How to use this file:** hand the whole document to a coding agent (Bionic/LM Studio or similar) in a fresh session, ideally on the same GFN machine. It contains everything: context, hard constraints, architecture, UI direction, milestones, and what already exists so nothing gets rebuilt twice.
>
> Working name: **SalsaDevKit** ("a dev box that fits in a folder"). Rename freely — it's meant for the whole SalsaNOW / GeForce NOW community, not just one user.

---

## 1. What we are building

A self-contained, **no-admin-required development environment container** for Windows that runs on GeForce NOW (via SalsaNOW) and any locked-down Windows PC where you have a persistent drive but no administrator rights.

It has two layers:

1. **The backend ("DevKit")** — a folder on the persistent drive holding portable runtimes (Node, Bun, Deno, Git, Python, optionally Rust/Go), all package caches, and VS Code portable with its user-data/extensions pinned to that drive. Any session rehydrates in seconds; nothing is ever "installed" system-wide.
2. **The app ("SalsaDevKit Control")** — an Electron tray + window application that is the front door: first-run provisioning wizard, project registry with per-project settings (ports, URLs, start scripts, env vars), one-click Run/Stop with a live terminal dock, service dashboard, toolchain manager, and **one central settings hub for everything**.

The product pitch to other SalsaNOW users: *"Your GFN session becomes a full dev box. No admin, no installs, survives every reboot."*

## 2. Hard constraints — READ FIRST (GeForce NOW / SalsaNOW environment)

These are non-negotiable facts of the runtime environment. Every design decision must respect them:

| # | Constraint | Consequence for the build |
|---|---|---|
| C1 | **No admin rights** | No installers, no Windows services, no system PATH edits, no drivers, no registry writes outside HKCU. Everything portable / user-mode. Test every feature as a standard user. |
| C2 | **Only the persistent drive survives sessions** (I: on this machine; letter varies per user) | ALL state — runtimes, caches, project configs, editor settings/extensions, app data — must live under one configurable root path. Default `I:\Apps\DevKit`, but the first-run wizard MUST let the user pick any persistent folder/drive. Never assume C: or %APPDATA% persists (it doesn't). |
| C3 | **No Docker / WSL2 / Hyper-V** | Native Windows portables only. Do not plan around containers. |
| C4 | Internet available, speed varies; sessions are time-limited | First-run downloads must be resumable, cached, sha256-verified and idempotent (re-running never re-downloads). Show MB/s + progress. Long tasks must be interruptible/restartable. |
| C5 | No git/node/npm on PATH by default; PowerShell 7 exists at `I:\Apps\SalsaNOW\SilentApps\Powershell\pwsh.exe` but don't hard-depend on it | The app manages its own environment: every child process gets an injected PATH (DevKit runtimes first) + env vars. Prefer cmd.exe + bundled tools for critical paths; use pwsh when available. |
| C6 | SmartScreen flags unsigned exes | Document "More info → Run anyway" in the README/onboarding. Code signing is a later concern, not a blocker. |
| C7 | NVIDIA GPU present; `nvidia-smi` works (e.g. `C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe`) | Optional later: portable CUDA toolkit on the persistent drive for GPU compute builds. Not v1 scope. |
| C8 | Newer npm versions gate postinstall scripts behind an allowlist (`npm install-scripts ls/approve/deny`) | After `npm install`, verify critical binaries actually exist (e.g. `node_modules\electron\dist\electron.exe`); if missing, run the package's installer script manually with node on PATH. Handle this in any "doctor/repair" flow. |
| C9 | The user watches a streamed screen; there is no CI | Verify by running from source (pattern below) + `node --check` for syntax. Keep the app runnable without any build step (plain JS, like SalsaSpotlight). |

**Proven working pattern (already validated on this machine, 2026-11-09):**
download official zip → extract to persistent drive → run exe directly with injected PATH + `npm_config_cache` pointed at the persistent cache. Node v24 LTS did exactly this and works perfectly.

## 3. What already exists — do NOT rebuild

| Asset | Location | Notes |
|---|---|---|
| Portable Node.js v24.22.2 LTS + npm 11.19.1 | `I:\Apps\DevKit\runtimes\node` | Verified: node, npm, registry access all work. Keep as the reference implementation for how a runtime entry should look. |
| Bun v1.4.4 / Git MinGit 2.56.0.windows.4 / Python 3.13.17 + pip 26.3 | `I:\Apps\DevKit\runtimes\{bun,git,python}` | All shim-verified 2026-11-09 (M0). Python embeddable has `import site` enabled (`python313._pth`) + get-pip run. |
| VS Code 1.145.2 portable | `I:\Apps\DevKit\runtimes\vscode\code` | user-data/extensions pinned to `I:\Apps\DevKit\vscode\{data,ext}` via shim. **Shim must delegate to the zip's own `bin\code.cmd`** (ELECTRON_RUN_AS_NODE + cli.js) — calling Code.exe directly launches the GUI even for `--version`. |
| npm cache (working) | `I:\Apps\DevKit\cache\npm` | 291 packages cached from a real project install — warm start for tests. |
| **M0 provisioner + manifest** | `I:\devdad\Projects\SalsaDevKit\provision.js`, `manifest.json` | Dependency-free Node script; idempotent via `state\*.json` markers; TOFU sha256 pinning writes back into the manifest. Re-run: `node provision.js [--only=a,b] [--force] [--list]`. Shims in `I:\Apps\DevKit\bin\`, log at `devkit.log`. **Do not rebuild this — extend it.** |
| Dev launcher pattern | `I:\Apps\DevKit\bin\salsaspotlight-dev.bat` | Example of PATH injection + cd + run. The general shape: set PATH, set cache vars, launch. |
| Reference codebase (style + patterns) | `I:\devdad\Projects\SalsaSpotlight-main` | Electron app by the same user: plain JS, no build step, tray + hotkeys + settings hub + auto-update via electron-builder/GitHub releases. **Match its architecture and code style** — the user knows it well. Its `SESSION.md` documents the environment in detail. |

**Download-URL findings from this network (2026-11-09, verified):**
- VS Code: old-style `update.code.visualstudio.com/stable/win32-x64[-zip]` paths are **dead (404)**. Use `https://update.code.visualstudio.com/latest/{platform}/stable` (e.g. `win32-x64-archive`) → 302 → prss.microsoft.com CDN, which is reachable and fast.
- `code.visualstudio.com/sha/download?build=stable&os=...` **no longer returns a hash** — it serves the file itself (`application/octet-stream`). No official hash source for VS Code from GFN; use TOFU pinning.
- nodejs.org (SHASUMS256.txt), python.org FTP, GitHub releases API all work fine. VSCodium's API SSL-fails from this network.

## 4. Architecture

### 4.1 DevKit folder layout (the backend)

```
<DEVKIT_ROOT>\                     ← default I:\Apps\DevKit, user-configurable
├─ manifest.json                   ← per runtime: version, url template, sha256, install notes
├─ runtimes\
│  ├─ node\                        ✅ exists (v24.22.2)
│  ├─ bun\bun.exe                  ← single binary from oven-sh/bun releases (bun-windows-x64.zip)
│  ├─ deno\deno.exe                ← single binary from denoland releases
│  ├─ git\                         ← Git for Windows official ZIP build (portable, no admin)
│  ├─ python\                      ← python-3.x-embed-amd64.zip + get-pip.py → pip works portably
│  ├─ rust\                        ← OPTIONAL v1.5: rustup-init --no-modify-path with RUSTUP_HOME/CARGO_HOME here; use the GNU target (x86_64-pc-windows-gnu) — MSVC target needs Build Tools which need admin
│  └─ go\                          ← OPTIONAL v1.5: official go*.windows-amd64.zip, GOROOT/GOPATH here
├─ cache\
│  ├─ npm\  bun\  pip\  cargo\  go\   ← ALL package caches live here → installs persist across sessions & are fast on re-hydration
├─ runtimes\
│  └─ vscode\code\                 ← VS Code portable (M0 reality: lives under runtimes\; the spec originally said vscode\code — shims already encode this, keep it)
├─ vscode\
│  ├─ data\                        ← --user-data-dir  → settings/state SURVIVE sessions
│  └─ ext\                         ← --extensions-dir → extensions survive too
├─ bin\                            ← launcher .bat/.ps1 shims (node, npm, bun, git, code…) that set PATH and exec the real binary — so users can call `bin\npm` from any shell
└─ projects.json                   ← app-managed project registry (see 4.2)
```

**Editor decision (already made, do not relitigate in v1):** use **VS Code portable**, launched with:
`code\code\Code.exe --user-data-dir=<root>\vscode\data --extensions-dir=<root>\vscode\ext <projectPath>`
Do NOT build a full IDE. An embedded Monaco "quick editor" panel is an optional phase-2 feature inside the app shell (small edits without leaving), not the foundation.

### 4.2 The app: SalsaDevKit Control (Electron)

Single-instance lock, tray icon + global hotkey to summon, frameless premium window, no admin. Plain JS/HTML/CSS, **no build step** (match SalsaSpotlight style). Main dependencies beyond electron: `xterm.js` (terminal rendering), that's about it — keep the tree tiny.

Pages (left sidebar nav):

1. **Projects** — registry of folders on the persistent drive. Per-project settings (this is the user's explicit ask — make it rich and central):
   - name, folder path, icon/emoji, runtime (node/bun/deno/python/go/rust/custom)
   - **start scripts**: dev / build / test / custom list (e.g. `npm run dev`)
   - **port(s)** + **URL(s)** — app polls the port after start and auto-opens the URL in the default browser when it answers; dashboard shows live "listening?" status via `net.connect` probes
   - env vars (key/value rows, merged over session env)
   - working dir override, notes field
2. **Services / Dashboard** — everything running right now: process name, project, port, uptime, output tail; actions: open URL, focus terminal, stop. Plus quick links for stopped projects.
3. **Toolchain** — status card per runtime: installed? version vs manifest, disk usage of its cache, buttons: Install / Repair (re-verify sha256) / Update / Remove. One "Doctor" button that checks the whole environment (C1–C8 compliance) and reports pass/fail with fixes.
4. **Settings** — THE central hub, everything in one place (user's explicit ask):
   - DevKit root path + persistent drive letter (with a warning if pointed at C:)
   - editor choice (VS Code portable / custom exe + args template) and "open project in editor" behaviour
   - hotkeys (summon app, peek services), theme (dark/light/system), accent colour
   - download options: proxy URL, parallel downloads, auto-update runtimes on launch (on/off)
   - per-project defaults (default runtime, default port base e.g. 5173+n to avoid clashes)
   - data controls: export/import projects.json + settings as one file, wipe caches, "reset all"

**Session bootstrap behaviour:** on app start → verify manifest against disk (fast hash check of a marker file per runtime, not full re-hash unless suspicious) → repair anything missing in the background with progress toasts → ready. A SalsaNOW `StartupBatch.bat` entry can auto-launch the app each session so the environment is always warm when the user lands.

**Process model for Run/Stop:** spawn via cmd.exe (`cmd /d /s /c`) with an injected env block (PATH = DevKit bin + runtimes first, npm_config_cache/bun config/pip target etc.), pipe stdout+stderr into xterm.js in a bottom dock (collapsible, per-project tabs). Stop = kill the process tree (taskkill /T /F on the PID). Persist "last opened project" so re-launching after a session wipe restores context.

### 4.3 Distribution for other SalsaNOW users

- GitHub repo + releases via electron-builder: **portable target** (single self-extracting exe, no install) + NSIS optional.
- One-line onboarding in the README: put the portable exe on your persistent drive, run it, pick your DevKit root, done. The app then provisions everything else itself.

## 5. UI/UX direction — premium, professional developer aesthetic

Target feel: **Linear / Raycast / DevToys-grade polish** — restrained, fast, dark-first. Not glassmorphism-heavy; not playful.

- **Palette (dark default):** near-black neutral base `#0e1013`–`#14171c` surfaces, 1px borders `rgba(255,255,255,.08)`, text `#f2f3f7` / muted `rgba(242,243,247,.55)`, ONE accent (default electric indigo `#6e7bff` or cyan — user-configurable in Settings), semantic green/amber/red for status only.
- **Typography:** Segoe UI Variable for UI; Cascadia Code / JetBrains Mono for paths, ports, commands, terminal. Small-caps letter-spaced section labels (10–11px, 600 weight).
- **Layout:** left sidebar 220px (Projects / Services / Toolchain / Settings) with icon+label rows and an accent indicator bar on the active item; main content as cards with 14–16px radius, generous padding, clear hierarchy: title → status pill → actions. Bottom dock: terminal (xterm.js), collapsible, tabbed per project.
- **Status language:** pills (`● Running` green pulse-dot, `Starting…` amber, `Error` red) + monospace port chips; live "listening" probes update without animation jank.
- **Motion:** 120–180ms ease-out transitions only (hover lift on cards = translateY(-1px), progress bars with MB/s readout, status dot pulse). Respect a global "reduce motion" setting.
- **Light theme** via Windows theme detection; both themes must look intentional, not inverted-afterthought.
- **Tray:** icon + menu (Open app / Open last project in editor / Doctor / Quit); hotkey summons the window with a subtle pop animation.

## 6. Milestones (build in this order)

| M | Deliverable | Why first |
|---|---|---|
| **M0** ✅ DONE 2026-11-09 | `manifest.json` + provision script (JS, run by node from DevKit) that installs bun, git zip, python embeddable, VS Code portable into the layout above — with sha256 verify, resume, progress. No app UI yet; a console/terminal flow is fine. **Shipped:** `provision.js` + `manifest.json`, all 5 runtimes installed & shim-verified (see §3). | Unblocks every other SalsaNOW user immediately and de-risks all downloads before any UI work. |
| **M1** 🚧 IN PROGRESS — shell shipped 2026-11-09 | Electron shell: window + tray + hotkey (Ctrl+Shift+D) + Settings hub (root path w/ migrate-and-relaunch, theme, accent, reduce motion, hotkey) + Toolchain page reading manifest vs disk with live provisioner streaming. **Shipped:** `main.js`, `preload.js`, `lib/{paths,toolchain,github-auth}.js`, `renderer/*`, `assets/logo.png`, `scripts/run-devkit.ps1`. **Spec extension (user-requested):** GitHub page — OAuth2 device flow + PAT fallback, credentials wired to portable gitconfig on I:. userData relocated to `<root>\data\salsadevkit` so settings survive wipes. | The app skeleton + the "one settings menu" promise. |
| **M1.5** (new) | GitHub auth end-to-end test with a real client_id; provisioner-via-UI verification; visual polish pass from user feedback. | De-risks M2's clone/push flows before they're built on top. |
| **M2** | Projects registry + per-project config (ports/URLs/scripts/env/runtime) + Run/Stop + xterm dock + auto-open-URL-on-port-ready + Services dashboard. | The core daily-driver value. |
| **M3** | Doctor flow, export/import of all state as one file, portable build via electron-builder, README + onboarding for SalsaNOW users, StartupBatch integration helper. | Community-ready release 1.0. |
| **M4 (optional)** | Monaco quick-editor panel; Rust/Go runtimes; CUDA toolkit entry; auto-update runtimes from manifest. | Nice-to-haves after real usage feedback. |

## 7. Testing & verification in this environment

- No CI, no admin: everything must run as a standard user off the persistent drive.
- Syntax-check all JS with `node --check` (portable node at `I:\Apps\DevKit\runtimes\node`).
- Run from source via a .bat that injects PATH (see `I:\Apps\DevKit\bin\salsaspotlight-dev.bat` for the exact pattern).
- UI verification is manual: the user watches the streamed screen — keep testable states reachable in <3 clicks, and log to a file under DevKit root (`devkit.log`) so problems can be diagnosed without devtools.
- After any `npm install`, verify postinstall-gated binaries exist (constraint C8).

## 8. Open decisions (confirm with the user before M1)

1. Final app name (SalsaDevKit / DevBox / SalsaForge / …).
2. v1 runtime set: recommend **node + bun + git + python + VS Code** in M0; Rust/Go to M4.
3. Default DevKit root on this machine: `I:\Apps\DevKit` (already partially populated — reuse it, don't fork a second copy).
4. Whether the app should also manage *other* SalsaNOW apps (e.g. launch SalsaSpotlight) or stay strictly dev-focused. Recommendation: stay dev-focused; expose generic "custom launcher" entries instead.

## 9. Ground rules for the implementing agent

- Match the SalsaSpotlight codebase style: plain JS, small files, no framework, no build step, defensive error handling that logs to file instead of crashing (see its `logError` + failsafe pattern).
- Never write outside the DevKit root and the app's own userData; never require admin; never assume C: persists.
- Every download: official source only, sha256 in manifest, resumable, idempotent.
- Keep the dependency tree minimal (electron + xterm.js is the target).
- Update this file's "What already exists" table as assets land, so future sessions never rebuild what exists.
