# JK2 Launcher

A desktop app (Tauri v2) for the [JK2 CTF](https://jk2ctf.com) community that
installs, updates, and launches Jedi Knight II client mods — currently
Tommyternal (Defrag/FFA), OpenJO, and JK2MV — without manually copying game
assets around. It also manages custom PK3 mods per client, browses the
[Monolith](https://github.com/fl4te/monolith) community mod database, and
shows JK2 CTF player stats and activity on its Home screen.

**Platform status**: macOS is fully supported and well-tested (install/
update/launch for all three clients, PK3 mod management, auto-updates).
Windows and Linux now have the same install/update/launch pipeline for all
three clients too, built against each project's real Windows/Linux release
assets - but unlike macOS, none of it has been run on a real Windows or
Linux machine yet, only verified by hand against the actual downloaded
archives and compiled successfully in CI. One spot in particular is a bigger
leap than the rest: JK2MV has no official portable Linux build, only a
`.deb`, so its Linux install is reconstructed from that package's contents
rather than an archive built to be dropped in as-is - if it doesn't launch,
that's the first thing to check (see the comment on `extract_jk2mv_linux` in
`src-tauri/src/lib.rs`). If you try either platform, an issue report (what
happened, plus the client and OS) is genuinely useful.

## Download

Grab the latest build for your OS from the
[Releases page](https://github.com/soradozere/soracle-launcher/releases) —
`.dmg` for macOS, `.exe`/`.msi` for Windows, `.AppImage`/`.deb`/`.rpm` for
Linux.

**macOS note:** the app is ad-hoc signed, not notarized by Apple (that
requires a paid Apple Developer account), so the first launch will hit
Gatekeeper. Depending on macOS version you'll either see *"JK2Launcher can't
be opened because Apple cannot check it for malicious software"* or it'll be
missing from the normal double-click flow entirely. Either way: right-click
(or Control-click) the app in Finder and choose **Open**, then confirm in
the dialog that appears — this only has to be done once. If macOS instead
says the app *"is damaged and can't be opened,"* that's not this — please
[open an issue](https://github.com/soradozere/soracle-launcher/issues), that
means something actually went wrong with that build.

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
