# DesktopFly for Windows (MVP)

C# port of the FlyWire-driven desktop fly. macOS original stays at the repo root.

## Requirements

- Windows 10/11
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)

## Build & run

```powershell
cd win
dotnet build DesktopFly\DesktopFly.csproj -c Release
dotnet run --project DesktopFly\DesktopFly.csproj -c Release
```

Headless circuit test (must pass after sim changes):

```powershell
dotnet run --project DesktopFly\DesktopFly.csproj -c Release -- --simtest
```

## MVP scope

**Included sensors:** cursor loom, clicks→taps, idle/typing, window ledges + taskbar ride, new-window looms, circadian + long-idle sleep, multi-monitor, interactive brain window (click Giant Fiber → escape, DNg11 → grooming).

**Skipped:** thermal tempo (always 1.0), SceneKit 3D body (GDI silhouette).

Tray icon → Pause, Brain, Escape Test, Scare, Recenter, Quit.
