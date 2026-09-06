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

## Verifying a new client release

The manifest (a gist, fetched at launch - see `MANIFEST_URL` in
`src/main.js`) pins a `sha256` for each client's download. Install/Update
downloads the file, hashes it, and compares - a mismatch shows a warning
under "Done." but doesn't block the install, since a hash changing is
exactly what a normal new upstream release looks like too; there's no way
to tell "new legitimate build" and "compromised build" apart from the hash
alone. That's what this pin is *for*, though: it means a compromised
account can't silently push a malicious build to every user the moment
it's uploaded - it has to also get past this pinned value, which only
changes when someone here deliberately updates it.

So when Tommyternal, OpenJO, or JK2MV cut a new release and users start
seeing that warning, update the pin. Easiest way:

```sh
./scripts/verify-client-release.sh TommyternalJK2MV   # or OpenJO / JK2MV
```

It downloads the current release, shows you its fingerprint next to what's
pinned, and - only after you say yes - updates the manifest. Nothing to
install, nothing to remember.

The manual version of the same steps, if you want to see what it's actually
doing:

```sh
# Pull the exact URL from the manifest for the client that changed, e.g.:
curl -sL "https://github.com/TomArrow/jk2mv/releases/download/latest-postxp/macOS.Package.Portable.Release.arm64.zip" -o /tmp/release.zip
shasum -a 256 /tmp/release.zip
```

Sanity-check the release is what it claims to be (matches a real tagged
release on the actual repo, ideally something the maintainer announced
themselves) before trusting it - the hash only proves the file didn't
change *after* you looked at it, not that what you're looking at is
legitimate. Then update that client's `sha256` field in the manifest gist:

```sh
gh gist edit a5ac8df67ac85687d20b4901ae1f1af0 -f manifest.json /path/to/updated-manifest.json
```

(Fetch the gist's current content first - `gh api
gists/a5ac8df67ac85687d20b4901ae1f1af0 -q '.files."manifest.json".content'`
- edit the one field, then push the whole file back; gist edits replace a
file's full content, not a diff.)
