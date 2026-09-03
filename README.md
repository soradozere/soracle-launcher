# Soracle Launcher

A small cross-platform desktop app (Tauri v2) that lets Soracle community
members install and update JK2 client mods (NWH, EternalJK2MV, JK2MV, OpenJO)
without manually copying game assets around.

**Target platforms**, in priority order: Linux first (must work on SteamOS /
Steam Deck), Windows second, macOS later.

## Status

Phase 1 — bare Tauri window. No UI, no networking, no filesystem access yet.

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

Tauri only produces a native build for the host OS it runs on. Producing the
Linux (Steam Deck) build will require a Linux machine/VM or a CI pipeline.
