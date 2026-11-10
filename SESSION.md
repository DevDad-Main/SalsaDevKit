# SalsaDevKit — Session Continuity File

> **For any LLM agent (Bionic/Qwen/other): read this file FIRST.** It is the live state of the project — what exists, what's verified, what's missing, and exactly how to resume. The build *spec* lives in [PROMPT.md](PROMPT.md); this file is the *status*.
> Keep it current as work happens. The sibling repo `I:\devdad\Projects\SalsaSpotlight-main\SESSION.md` covers that app + shared environment notes — read both if you're touching either project.

## 1. What this project is

**SalsaDevKit** = "a dev box that fits in a folder". A no-admin, portable development environment for Windows on **GeForce NOW via SalsaNOW** (and any locked-down PC with a persistent drive). Two layers:
- **Backend (M0, DONE):** `provision.js` + `manifest.json` — dependency-free Node provisioner that downloads official portable runtimes into the DevKit root, pins SHA-256s trust-on-first-use, and generates PATH-injecting shims. Idempotent via state markers.
- **Frontend (M1, shell shipped):** Electron control app — frameless premium window + tray + hotkey, pages: Toolchain / GitHub / Settings (+ Projects & Services empty states for M2).

**User-confirmed decisions (do not relitigate):** name = SalsaDevKit · v1 runtimes = node+bun+git+python+VS Code (Rust/Go → M4) · default root `I:\Apps\DevKit` (per-user configurable in Settings) · scope = dev-focused + generic custom launcher entries · **GitHub login is a first-class feature** (one-click browser button primary, PAT fallback).

## 2. Environment (GeForce NOW via SalsaNOW) — read before running anything

| Thing | Detail |
|---|---|
| Persistence | **Only `I:` survives.** C: wiped every session. All state lives under the DevKit root on I:. |
| Admin rights | None. Everything user-mode/portable. |
| PowerShell | Use pwsh 7 at `I:\Apps\SalsaNOW\SilentApps\Powershell\pwsh.exe`. **`powershell.exe` (5.1) cannot be spawned from node/electron on this image (EPERM).** |
| Shell tool gotcha | The agent's `shell_command` layer mangles inline quoting and strips `$var` patterns — **always write .ps1/.bat files to scratchpad or repo scripts/ and run via `-File`**. |
| Scratchpads | Agent scratchpads (e.g. `C:\Users\kiosk\.lmstudio\scratchpads\N`) may not persist across sessions — anything reusable belongs in this repo's `scripts/`. |
| Network | ~100 MB/s effective. nodejs.org, python.org, github.com, update.code.visualstudio.com + prss.microsoft.com CDN all reachable. VSCodium API SSL-fails (irrelevant). VS Code: use `/latest/{platform}/stable` endpoints — old `/stable/...` paths are dead 404s; `code.visualstudio.com/sha/download` serves the file, not a hash. |
| npm gotcha (C8) | Newer npm gates postinstall scripts behind an allowlist. After any `npm install`, verify `node_modules\electron\dist\electron.exe`; if missing run `node node_modules\electron\install.js`. Baked into `scripts\run-devkit.ps1`. |
| User | Watches a streamed screen (no CI). Verify by running + checking logs; keep testable states <3 clicks away. GitHub account: **DevDad-Main** (signs in via VS Code). |

## 3. File map

```
I:\devdad\Projects\SalsaDevKit\          ← this repo (on persistent I:)
├── PROMPT.md            build spec: constraints C1–C9, architecture §4, UI direction §5, milestones §6
├── SESSION.md           THIS FILE — live status
├── manifest.json        runtime definitions + pinned sha256s + shim specs (source of truth for M0)
├── provision.js         M0 provisioner (~330 lines, plain Node ≥18 + system tar.exe). Flags: --list --only=a,b --force[=names]
├── package.json         electron ^44.7.0 only (devDep); no build step
├── main.js              Electron main: window/tray/hotkey(Ctrl+Shift+D)/IPC; userData → <root>\data\salsadevkit BEFORE ready
├── preload.js           contextBridge → window.devkit (contextIsolation on, nodeIntegration off)
├── lib\paths.js         root resolution (env DEVKIT_ROOT || I:\Apps\DevKit), path map, JSON IO helpers
├── lib\toolchain.js     manifest-vs-disk status; provisioner spawn w/ live line streaming (Electron-as-Node bootstrap!)
├── lib\github-auth.js   device-flow state machine + PAT validation + gitconfig/credential wiring on I:
├── lib\projects.js      M2 registry (<root>\projects.json) + clone/pull/open-in-editor + per-project git status
├── lib\env.js           devkitEnv(rootPaths): PATH w/ DevKit first, npm/pip caches, GIT_CONFIG_GLOBAL when present; gitExe()
├── renderer\            index.html / style.css / renderer.js — 5-page shell (Projects page live since session 4)
├── assets\logo.png      PIL-generated terminal-prompt mark
├── assets\screenshots\  README screenshots (regenerate: scripts\capture-screens.js)
├── README.md            community-facing docs + quick start + trust model + roadmap
└── scripts\             run-devkit.ps1, launch-devkit.bat, smoke-projects.js (headless M2 test), capture-screens.js

I:\Apps\DevKit\          ← DevKit ROOT (runtime state, all persistent)
├── runtimes\            node v24.22.2 · bun 1.4.4 · git MinGit 2.56.0.windows.4 · python 3.13.17+pip 26.3 · vscode\code (VS Code 1.145.2)
├── bin\                 shims: node/npm/bun/git/python/pip/code.cmd (+ salsaspotlight-dev.bat for the other app)
├── cache\npm            warm npm cache (set via npm_config_cache in npm shim)
├── state\               *.json install markers · github.json (auth+token) · git-credentials
├── data\salsadevkit     Electron userData (settings.json, error.log) — survives wipes
├── data\gitconfig       portable git config (credential helper → file store; user identity after auth)
├── vscode\data|ext      VS Code persistent user-data + extensions dirs
└── devkit.log           provisioner log (app streams it live on the Toolchain page)
```

## 4a. Session 4 (2026-11-10) — M2 core + repo setup

**M2 Projects page shipped (core):** registry in `<root>\projects.json`; clone from GitHub (`owner/repo` or full URL → `<root>\projects\<name>`), add existing folder, `git pull --ff-only`, open in VS Code via the code shim, live branch + dirty-count pills per card. All git runs through portable MinGit with `devkitEnv()` (lib/env.js) so credentials/identity come from I:. Verified headless: `scripts\smoke-projects.js` (clone→status→pull→cleanup PASSED in 2.7 s) and a real clone of DevDad-Main/SalsaSpotlight → now at `I:\Apps\DevKit\projects\SalsaSpotlight`, registered as project `salsaspotlight`. The old zip copy `I:\devdad\Projects\SalsaSpotlight-main` was deregistered (files left on disk — user may delete it; it has no .git so can't push from there).

**VS Code terminal git fix:** code.cmd shim now sets `GIT_CONFIG_GLOBAL=<root>\data\gitconfig` (manifest 3rd spec element), so VS Code's integrated terminal authenticates + commits with the right identity after sign-in — no user setup. Shims regenerated.

**Node re-pinned:** node was "assumed" (manual pre-provisioner install, sha256 null). Ran `provision.js --force=node` → verified vs SHASUMS256.txt, pinned `ca1bff5d8ead13c9…`, proper marker. All 5 runtimes now Installed + sha-pinned.

**Repo:** this folder is now a git repo (branch main) with remote https://github.com/DevDad-Main/SalsaDevKit.git (user created it). Everything staged (`git add -A`), **NOT committed yet — commit needs the user's identity, which lands in data\gitconfig after GitHub sign-in.** README.md + LICENSE (MIT) + 4 screenshots written this session.

**GitHub auth hardening (session 4b):**
- Standard redirect URI is now FIXED: `http://127.0.0.1:8465/callback` (settings.githubCallback, overridable). GitHub rejects random-port callbacks that don't match the app's registered callback — register this exact URL on your OAuth App.
- **GitHub REQUIRES client_secret at token exchange for these apps** (empirically verified 2026-11-10: exchange fails with `incorrect_client_credentials` even when no secret was generated; works once a secret is generated + sent). settings.githubClientSecret added; setup box has the field; browser + device flows both send it.
- New sign-in attempts auto-supersede stale ones (no more "already in progress" dead ends).
- Reset controls: GitHub page red button + Settings → "GitHub & data" card (`github:reset` IPC = cancelActive + wipe client id/secret; `signOut` clears token+credentials).
- Browser preference: Brave first (standard install paths + `<rootDrive>:\Apps\cloudstore\brave\brave.exe` portable), system default fallback (Waterfox on SalsaNOW). All external links route through it.
- User signed in successfully as **Oliver Metz** (DevDad-Main) via browser flow + client secret. Identity now in data\gitconfig; credentials in state\git-credentials.

## 4. Done & verified (as of 2026-11-09, session 3)

**M0 — complete.** All five runtimes installed + shim-verified (`node --version`, `npm --version`, `bun --version`, `git --version`, `python -m pip --version`, `code.cmd --version` = 172 ms headless). Re-run any time:
```
I:\Apps\DevKit\runtimes\node\node.exe I:\devdad\Projects\SalsaDevKit\provision.js [--only=a,b] [--force=name] [--list]
```

**M1 — shell shipped, running from source.** Window + tray + hotkey work; settings persist to `I:\Apps\DevKit\data\salsadevkit` (verified in child process args). Pages: Toolchain (status cards, provision-all/reinstall with streaming log console, launcher chips), GitHub (device flow + PAT — see §5 for the button rework), Settings (root w/ C:-warning + migrate-and-relaunch, theme, accent, reduce motion, hotkey). All JS passes `node --check`.

**Bugs found & fixed along the way (don't reintroduce):**
1. Python embeddable `_pth` file is literally `python313._pth` → regex must be `/^python\d+\._pth$/i` (a "fix" that dropped the underscore was itself wrong).
2. VS Code: calling `Code.exe --version` directly launches the full GUI and orphans child processes. The zip's own `bin\code.cmd` sets `ELECTRON_RUN_AS_NODE=1` + runs `cli.js` — shims must delegate to it (its `%~dp0`-relative paths survive VS Code self-updates).
3. Shim spec arrays are `[pathAdd, target]`; generateShims now skips malformed specs with a warning instead of crashing.
4. JSON manifest: backslashes in note strings must be `\\` (bare `\c` breaks parse).

## 5. Missing / TODO — pick up here

### In flight right now (session 4)
- [ ] **PUSH THE REPO** — blocked ONLY on GitHub sign-in. User created https://github.com/DevDad-Main/SalsaDevKit.git; tree is staged. Once user signs in via the app's GitHub page (PAT fastest: Advanced → paste token with repo scope; or register OAuth App for one-click + device flow), `data\gitconfig` gets their identity → then: `git -c ... commit` (use portable git at I:\Apps\DevKit\runtimes\git, GIT_CONFIG_GLOBAL=I:\Apps\DevKit\data\gitconfig) with a proper message, add remote origin, push main. Verify the README renders on GitHub (screenshots!).
- [ ] **M2 remainder** — Run/Stop per project (`cmd /d /s /c` spawn w/ devkitEnv; kill tree via `taskkill /T /F`) + xterm.js terminal dock + Services dashboard + port probing/auto-open URL. Reuse lib/env.js devkitEnv() for child processes.
- [ ] **M1.5 verifications** — provisioner-via-UI path (click Provision all in app → watch log stream); settings survive a session wipe (ask user to restart GFN and check).
- [ ] Visual polish pass from user feedback (user said both apps "look clean" — iterate only if they ask).

### Then, in order
1. **Push + M1.5 verifications** (see above).
2. **M2 remainder** — Run/Stop + xterm dock + Services dashboard + port probing/auto-open URL.
3. **M3** — Doctor flow, export/import all state as one file, electron-builder **portable target**, onboarding for other SalsaNOW users (README already covers most; include the OAuth App note: they can use DevDad-Main's registered app client_id or register their own), StartupBatch auto-launch helper.
4. **M4** — Monaco quick-editor panel; Rust/Go runtimes (GNU toolchain target only — MSVC needs admin); CUDA toolkit entry; runtime auto-update from manifest.

## 6. Run / verify commands (copy-paste ready)

```bat
:: syntax-check everything
I:\Apps\DevKit\runtimes\node\node.exe --check I:\devdad\Projects\SalsaDevKit\main.js   (repeat per file, or use a .ps1 loop)

:: install deps if needed + fix electron binary + launch from source (minimized console)
I:\Apps\SalsaNOW\SilentApps\Powershell\pwsh.exe -NoProfile -File I:\devdad\Projects\SalsaDevKit\scripts\run-devkit.ps1

:: restart ONLY SalsaDevKit (NEVER kill by process name 'electron' — that also kills SalsaSpotlight's dev build!)
:: filter Win32_Process CommandLine like '*SalsaDevKit*' and Stop-Process those PIDs, then re-run the above

:: app error log (main-process uncaught exceptions land here)
type I:\Apps\DevKit\data\salsadevkit\error.log

:: provisioner log
type I:\Apps\DevKit\devkit.log
```

## 7. Ground rules (from PROMPT.md §9, repeated so they're never missed)

- Plain JS, no build step, small files — match SalsaSpotlight's style; defensive logging to file instead of crashing.
- Never write outside the DevKit root + app userData; never require admin; never assume C: persists.
- Every download: official source only, sha256 pinned in manifest, idempotent.
- Dependency tree stays minimal (electron + xterm.js is the target).
- Update THIS file's §4/§5 as work lands so future sessions never rebuild what exists.
