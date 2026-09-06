# JK2 Launcher

A desktop app (Tauri v2) for the [JK2 CTF](https://jk2ctf.com) community that
installs, updates, and launches Jedi Knight II client mods — currently
Tommyternal (Defrag/FFA), OpenJO, and JK2MV — without manually copying game
assets around. It also manages custom PK3 mods per client, browses the
[Monolith](https://github.com/fl4te/monolith) community mod database, and
shows JK2 CTF player stats and activity on its Home screen.

**Platform status**: macOS is fully supported today (install/update/launch
for all three clients, PK3 mod management, auto-updates). Windows and Linux
currently build and run the launcher shell itself, but the client
install/launch pipelines are still macOS-only — that's the next phase of
work.

## Prerequisites

- Node + [pnpm](https://pnpm.io/)
- [Rust toolchain](https://www.rust-lang.org/tools/install) (rustup)
- OS-specific system libraries — see <https://tauri.app/start/prerequisites/>
  - **Linux:** `webkit2gtk-4.1`, `libayatana-appindicator3`, `librsvg2` dev
    packages, plus `build-essential`, `curl`, `wget`, `file`, `libssl-dev`,
    `libxdo-dev`
  - **Windows:** MSVC build tools + WebView2 runtime (bundled on Windows 11)

## Development

```sh
pnpm install
pnpm tauri dev
```

## Build

```sh
pnpm tauri build
```

Tauri only produces a native build for the host OS it runs on. CI
(`.github/workflows/ci.yml`) builds and checks all three platforms on every
push; `.github/workflows/release.yml` builds, signs, and publishes a draft
GitHub Release (with an auto-updater manifest) whenever a `v*` tag is pushed.
