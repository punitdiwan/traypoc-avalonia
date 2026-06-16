# Time Tracker — Avalonia / .NET desktop + Go API + React dashboard

A platform-independent **desktop time tracker** (Upwork-style): periodic
**screenshot capture**, **activity monitoring**, and upload to **DigitalOcean
Spaces**, with an employer **web dashboard** and a **work diary**. Developed on
Linux, primary target is Windows.

The desktop app is an **Avalonia / .NET** port of the original Tauri/Rust app. It
lives in the **system tray** and ships as:

- **Linux** → an **AppImage** (single portable file) with a StatusNotifier tray icon
- **Windows** → an **MSI installer** (built with **WiX v5**) with a notification-area tray icon

This is a **pnpm monorepo** (desktop app + shared web dashboard + Go API):

```
time-tracker/                        # (this repo; dir is currently "dot-net-test")
├── apps/
│   ├── desktop/                     # Avalonia / .NET desktop app (net10.0) — TrayPoc.csproj
│   │   ├── Services/                # tracker, screenshot, activity, sync, db, uploader, api client
│   │   ├── ViewModels/              # MVVM (CommunityToolkit.Mvvm)
│   │   ├── Views/                   # Login, Dashboard, WorkDiary, Settings + MainWindow
│   │   └── Assets/                  # tray-icon.ico + PNGs
│   ├── web/                         # React + Vite employer dashboard (@time-tracker/web)
│   └── api/                         # Go API server (chi, pgx, asynq)
├── packaging/
│   ├── linux/                       # AppImage: build-appimage.sh, AppRun, .desktop
│   └── windows/TrayPoc.Installer/   # WiX v5 project: Package.wxs, .wixproj
├── .github/workflows/build.yml      # CI: AppImage + MSI + Go API binaries + Release
├── pnpm-workspace.yaml              # apps/*
└── TrayPoc.slnx
```

Convenience scripts from the repo root: `pnpm web` (Vite dev server), `pnpm api`
(Go API via `make -C apps/api run`), `pnpm desktop` (`dotnet run` the app).

## How it works

```
Desktop tracker fires (every ~interval, skipped while idle)
  → captures a screenshot + samples activity %
  → writes a TimeInterval row to local SQLite
  → asks the API for a presigned PUT URL, then uploads PNG/thumbnail to Spaces
  → SyncService POSTs the interval (+ Spaces URL) to the API
  → API writes to PostgreSQL; employer views it in the web dashboard / work diary
```

Offline-first: SQLite buffers everything and sync/upload resume when the API is
reachable. The desktop holds **no Spaces credentials** — uploads use short-lived
presigned URLs minted by the API, and object deletes happen server-side.

## Toolchain

The desktop app **targets `net10.0`**, so the **.NET 10 SDK** is required to build
it. If you install .NET user-locally (no root), wire up a new shell with:

```bash
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
```

Node/pnpm are pinned via `.nvmrc` (Node 24) and the root `packageManager` field
(pnpm 10). The API needs Go 1.23+.

## Desktop app — run from source

```bash
dotnet run --project apps/desktop/TrayPoc.csproj            # or: pnpm desktop
dotnet build apps/desktop/TrayPoc.csproj -c Release
apps/desktop/bin/Debug/net10.0/TrayPoc --selftest          # headless capture/SQLite/activity smoke test
```

Close the window → the app keeps running in the tray. Tray menu: **Show / Hide /
About / Quit**. Quit is the only thing that exits the process. The API URL is set
on the login screen (or in Settings); it falls back to `$TIMETRACKER_API_URL`,
then `http://localhost:8080`.

### Single instance

Only one instance runs at a time. The first launch grabs a named **Mutex**; any
later launch detects it, sends an "activate" message over a **named pipe** so the
running instance surfaces its window, and then exits (`Program.cs`, cross-platform).

## Backend API (Go) — run from source

```bash
cd apps/api
cp .env.example .env       # fill in DATABASE_URL, REDIS_URL, JWT_SECRET, DO_SPACES_*, ...
go run ./cmd/server        # dev server on :8080   (or: make run / pnpm api)
go build ./... && go vet ./... && go test ./...
```

Needs a reachable **PostgreSQL** (schema auto-migrates on connect) and **Redis**
(asynq job queue). `cmd/server` loads a `.env` from the working directory and,
for standalone release binaries, also from the directory next to the executable.

## Web dashboard (React + Vite)

```bash
pnpm install               # from repo root (workspace)
pnpm web                   # Vite dev server on :5173 (proxies /api → :8080)
pnpm web:build             # tsc + vite production build
```

## Build the Linux AppImage

```bash
./packaging/linux/build-appimage.sh 2.0.0 linux-x64
# -> dist/TrayPoc-2.0.0-x86_64.AppImage
```

The script publishes a self-contained build, assembles an `AppDir` (with
`.desktop` + hicolor icon + `AppRun`), downloads `appimagetool`, and packs the
AppImage using `--appimage-extract-and-run` (no FUSE required on the build host).

Install it for the current user — drops a **launcher icon on the Desktop** plus an
applications-menu entry (`install.sh` ships next to the AppImage in the release):

```bash
./dist/install.sh                 # or: ./dist/install.sh /path/to/TrayPoc-*.AppImage
./dist/uninstall.sh               # to remove
```

> End users need FUSE2 to launch an AppImage normally (`sudo apt install libfuse2`),
> or run with `--appimage-extract-and-run`. A working **system tray / AppIndicator**
> in the desktop environment is required for the tray icon to appear.

## Build the Windows MSI

> **WiX builds MSIs on Windows only.** Run this on a Windows machine or via the
> GitHub Actions `windows-msi` job — building on Linux is unsupported by WiX.

```powershell
dotnet publish apps/desktop/TrayPoc.csproj -c Release -r win-x64 --self-contained true -o publish/win-x64
dotnet build packaging/windows/TrayPoc.Installer/TrayPoc.Installer.wixproj -c Release `
  -p:ProductVersion=2.0.0 -p:PublishDir="$PWD\publish\win-x64\"
# -> packaging/windows/TrayPoc.Installer/bin/.../TrayPoc-2.0.0-win-x64.msi
```

The MSI installs to `C:\Program Files\TrayPoc`, adds **Start-menu and Desktop
shortcuts**, an Add/Remove-Programs icon, and a (per-user) **run-at-logon**
registry entry so the tray app starts with Windows.

## CI / CD — GitHub Actions

`.github/workflows/build.yml` runs on push/PR (jobs are gated by which subtree
changed) and:

- **web** (ubuntu) → typecheck + production build of the dashboard
- **api** (ubuntu) → `go build`/`vet`/`test`, then cross-compiles the server for
  **linux/amd64** + **windows/amd64** and uploads the `timetracker-api` artifact
- **linux-appimage** (ubuntu) → builds & uploads the AppImage artifact
- **windows-msi** (windows) → builds & uploads the MSI artifact
- **release** (on a `v*` tag) → attaches the AppImage, MSI, and API binaries to a GitHub Release

Cut a release:

```bash
git tag v2.0.0 && git push origin v2.0.0
```
