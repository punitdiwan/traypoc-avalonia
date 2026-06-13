# TrayPoc — Avalonia / .NET cross-platform tray POC

A minimal proof-of-concept desktop app built with **Avalonia UI** that runs on
**Linux and Windows**, lives in the **system tray**, and ships as:

- **Linux** → an **AppImage** (single portable file) with a StatusNotifier tray icon
- **Windows** → an **MSI installer** (built with **WiX v5**) with a notification-area tray icon

```
dot-net-test/
├── src/TrayPoc/                     # Avalonia app (net10.0)
│   ├── App.axaml(.cs)               # TrayIcon + native menu, hide-to-tray
│   ├── Views/MainWindow.axaml(.cs)  # POC window
│   ├── ViewModels/                  # MVVM (CommunityToolkit.Mvvm)
│   └── Assets/                      # tray-icon.ico + PNGs (generated)
├── packaging/
│   ├── linux/                       # AppImage: build-appimage.sh, AppRun, .desktop
│   └── windows/TrayPoc.Installer/   # WiX v5 project: Package.wxs, .wixproj
├── .github/workflows/build.yml      # CI: AppImage (Linux) + MSI (Windows) + Release
└── TrayPoc.slnx
```

## Toolchain (already installed on this machine)

Installed user-locally under `~/.dotnet` (no root needed). PATH is wired up for
both bash and fish via profile snippets.

| Tool | Version |
|------|---------|
| .NET SDK | **9.0.315** and **10.0.301** (side by side) |
| Avalonia templates | 12.0.4 |
| Avalonia packages | 12.0.4 |

> The project **targets `net10.0`** (the current Avalonia template default), so the
> .NET 10 SDK is what builds it. .NET 9 is also installed as requested.

If you ever need to re-add .NET to a new shell:

```bash
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
```

## Run from source

```bash
dotnet run --project src/TrayPoc/TrayPoc.csproj
```

Close the window → the app keeps running in the tray. Tray menu: **Show / Hide /
About / Quit**. Quit is the only thing that exits the process.

## Build the Linux AppImage

```bash
./packaging/linux/build-appimage.sh 1.0.0 linux-x64
# -> dist/TrayPoc-1.0.0-x86_64.AppImage
```

The script publishes a self-contained build, assembles an `AppDir` (with
`.desktop` + hicolor icon + `AppRun`), downloads `appimagetool`, and packs the
AppImage using `--appimage-extract-and-run` (no FUSE required on the build host).

Run it:

```bash
chmod +x dist/TrayPoc-1.0.0-x86_64.AppImage
./dist/TrayPoc-1.0.0-x86_64.AppImage
```

> End users need FUSE2 to launch an AppImage normally (`sudo apt install libfuse2`),
> or run with `--appimage-extract-and-run`. A working **system tray / AppIndicator**
> in the desktop environment is required for the tray icon to appear.

## Build the Windows MSI

> **WiX builds MSIs on Windows only.** Run this on a Windows machine or via the
> GitHub Actions `windows-msi` job — building on Linux is unsupported by WiX.

```powershell
dotnet publish src/TrayPoc/TrayPoc.csproj -c Release -r win-x64 --self-contained true -o publish/win-x64
dotnet build packaging/windows/TrayPoc.Installer/TrayPoc.Installer.wixproj -c Release `
  -p:ProductVersion=1.0.0 -p:PublishDir="$PWD\publish\win-x64\"
# -> packaging/windows/TrayPoc.Installer/bin/.../TrayPoc-1.0.0-win-x64.msi
```

The MSI installs to `C:\Program Files\TrayPoc`, adds a Start-menu shortcut, an
Add/Remove-Programs icon, and a (per-user) **run-at-logon** registry entry so the
tray app starts with Windows.

## CI / CD — GitHub Actions

`.github/workflows/build.yml` runs on push/PR and:

- **linux-appimage** (ubuntu-latest) → builds & uploads the AppImage artifact
- **windows-msi** (windows-latest) → builds & uploads the MSI artifact
- **release** (on a `v*` tag) → attaches both to a GitHub Release

Cut a release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```
