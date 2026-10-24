#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Some upstream release builds (OpenJO's GitHub release, at least, verified by
// hand) ship an app bundle whose executable declares a sealed-resources
// requirement but whose _CodeSignature/CodeResources is missing from the
// archive entirely - the OS refuses to run it at all (SIGKILL, CODESIGNING,
// "Invalid Page") even though nothing about the bundle's actual content is
// wrong. Re-signing ad-hoc regenerates a signature + resource seal that
// matches whatever bytes are actually on disk, which is all the OS needs to
// run an unnotarized bundle locally - it isn't a substitute for the
// developer's own signature, just a fix for a broken/missing one.
fn resign_app_bundle(app_bundle: &std::path::Path) -> Result<(), String> {
    let output = std::process::Command::new("codesign")
        .args(["--force", "--deep", "--sign", "-"])
        .arg(app_bundle)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        // codesign's own diagnostic (on stderr) is the whole point of
        // capturing output instead of just the exit status - "codesign
        // failed" alone gives no way to tell a bad bundle from anything
        // else without a debugger attached to the user's machine.
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("codesign failed for {}: {}", app_bundle.display(), stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
fn extract_nwh(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = app_data.join("extracted").join("nwh");

    // Every platform's package ends up wrapped in one top-level folder
    // (resolve_nwh_install relies on that) - cleared first so a release that
    // renames it can't leave two behind for find_single_subdir to choke on.
    let _ = std::fs::remove_dir_all(&dest);

    if cfg!(target_os = "macos") {
        let bundle_dir = dest.join("nwh_macos");
        extract_nwh_macos(&app_data.join("nwh_macos_arm64.zip"), &bundle_dir)?;
        // Same ad-hoc re-sign as OpenJO's bundle: leaving out the package's
        // "._" files (see extract_nwh_macos) breaks its original resource
        // seal, and a fresh signature over what's actually on disk is all
        // macOS needs to run it.
        resign_app_bundle(&bundle_dir.join("NWH.app"))?;
    } else if cfg!(target_os = "windows") {
        // nwh_windows_x64/{base,nwh,nwhmp.exe,nwhmenu.qvm,OpenAL32.dll,SDL2.dll}
        let file = std::fs::File::open(app_data.join("nwh_windows_x64.zip")).map_err(|e| e.to_string())?;
        zip::ZipArchive::new(file).map_err(|e| e.to_string())?.extract(&dest).map_err(|e| e.to_string())?;
    } else {
        // nwh_linux_x64/{base,nwh,nwhmp,nwhmenu.qvm}
        let file = std::fs::File::open(app_data.join("nwh_linux_x64.tar.gz")).map_err(|e| e.to_string())?;
        tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(&dest).map_err(|e| e.to_string())?;
    }

    Ok(format!("Extracted to {}", dest.display()))
}

// jk2ctf.com/nwh-download's macOS build is a zip inside a zip, the inner one
// holding NWH.app. It was zipped in Finder, so it also carries AppleDouble
// "._" files beside the real ones - skipped here: they aren't real files,
// and a "._nwh-bins.pk3" is something the game would try to load as a pak.
fn extract_nwh_macos(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    use std::io::Read;
    let is_metadata = |path: &std::path::Path| {
        path.components().any(|c| {
            let name = c.as_os_str().to_string_lossy();
            name.starts_with("._") || name == "__MACOSX"
        })
    };

    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut outer = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let inner_name = outer
        .file_names()
        .filter_map(|n| n.ok())
        .find(|n| n.ends_with(".zip") && !is_metadata(std::path::Path::new(n.as_ref())))
        .map(|n| n.into_owned())
        .ok_or_else(|| "The macOS NWH package has no NWH.app archive inside it".to_string())?;
    let mut inner_bytes = Vec::new();
    outer
        .by_name(&inner_name)
        .map_err(|e| e.to_string())?
        .read_to_end(&mut inner_bytes)
        .map_err(|e| e.to_string())?;

    let mut inner = zip::ZipArchive::new(std::io::Cursor::new(inner_bytes)).map_err(|e| e.to_string())?;
    for i in 0..inner.len() {
        let mut entry = inner.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name refuses any entry that would land outside dest.
        let Some(relative) = entry.enclosed_name() else { continue };
        if is_metadata(&relative) {
            continue;
        }
        let out = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
        // Keeps the executable bit on the game binary.
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn extract_tommyternal(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // Every platform's release wraps its real payload in one outer .zip -
    // only what's inside that wrapper differs (see below).
    let archive_name = if cfg!(target_os = "windows") {
        "tommyternal_windows_x64.zip"
    } else if cfg!(target_os = "linux") {
        "tommyternal_linux_x64.zip"
    } else {
        "tommyternal_macos_arm64.zip"
    };
    let zip_path = app_data.join(archive_name);
    let dest = app_data.join("extracted").join("tommyternal");

    // Tommyternal's "latest-postxp" tag is a moving target - its archive's
    // single top-level folder is named after the build's git commit, so a
    // second extract after Tom ships a new build lands in a differently
    // named folder alongside whatever was extracted before, instead of
    // replacing it. find_single_subdir (used to locate this payload for
    // install) then finds more than one and refuses to guess. Clearing the
    // destination first guarantees exactly one folder no matter how many
    // times this has been extracted before.
    let _ = std::fs::remove_dir_all(&dest);

    let zip_file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut zip_archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    if cfg!(target_os = "windows") {
        // Windows' build wraps a second, plain .zip - unlike the macOS/Linux
        // builds' inner gzip'd tar, a nested zip needs Seek to read its own
        // central directory, which the outer zip's streaming entry reader
        // doesn't provide. Buffering it fully in memory first (tens of MB,
        // fine) and reopening from a Cursor gives it that.
        let mut inner_zip = zip_archive.by_index(0).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut inner_zip, &mut buf).map_err(|e| e.to_string())?;
        drop(inner_zip);
        let mut inner_archive =
            zip::ZipArchive::new(std::io::Cursor::new(buf)).map_err(|e| e.to_string())?;
        inner_archive.extract(&dest).map_err(|e| e.to_string())?;
    } else {
        let inner_targz = zip_archive.by_index(0).map_err(|e| e.to_string())?;
        let gz = flate2::read::GzDecoder::new(inner_targz);
        tar::Archive::new(gz).unpack(&dest).map_err(|e| e.to_string())?;
    }

    Ok(format!("Extracted to {}", dest.display()))
}

#[tauri::command]
fn extract_openjo(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = app_data.join("extracted").join("openjo");

    if cfg!(target_os = "windows") {
        // Windows' release is a plain, un-nested zip - everything (the
        // binary, its dlls, the OpenJK/ mod folder) sits at the top level
        // already, no wrapper folder or dlopen shim to unpack around.
        let zip_path = app_data.join("openjo_windows_x64.zip");
        let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        archive.extract(&dest).map_err(|e| e.to_string())?;
        return Ok(format!("Extracted to {}", dest.display()));
    }

    let archive_name = if cfg!(target_os = "linux") {
        "openjo_linux_x64.tar.gz"
    } else {
        "openjo_macos_arm64.tar.gz"
    };
    let file = std::fs::File::open(app_data.join(archive_name)).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    tar::Archive::new(gz).unpack(&dest).map_err(|e| e.to_string())?;

    // The SDL3 dlopen shim and ad-hoc resign below are only needed for the
    // macOS .app bundle - Windows ships its own real SDL2.dll and Linux its
    // own real SDL2 (system or bundled), and neither has a code-signing
    // concept for this to work around at all.
    if cfg!(target_os = "macos") {
        let app_bundle = dest.join("openjo_sp.arm64.app");
        // OpenJO's bundled "libSDL2-2.0.0.dylib" is actually sdl2-compat
        // (SDL2's API re-implemented on top of SDL3), confirmed by strings
        // in the binary itself ("Failed to initialize sdl2-compat library").
        // It dlopens a real SDL3 at runtime from a fixed set of relative
        // paths - none of which are where Homebrew installs it - so the
        // bundle needs its own copy placed at @loader_path/libSDL3.dylib
        // (sdl2-compat's own directory, Contents/Frameworks) for it to find.
        // Vendored rather than reached into Homebrew: requiring every user
        // to `brew install sdl3` before Install even worked was real,
        // needless friction. This is the official upstream macOS universal
        // binary (SDL3-3.4.16.dmg from github.com/libsdl-org/SDL, the same
        // version Homebrew's own formula builds from) - see
        // resources/libSDL3-LICENSE.txt (zlib, redistribution is fine).
        //
        // Bundled as a real Resources/ file (tauri.conf.json's
        // bundle.macOS.files) rather than compiled in via include_bytes! -
        // that used to put all 5MB directly in the executable's own
        // __TEXT,__const section, present in every build on every platform
        // even though only a macOS OpenJO install ever needs it.
        let sdl3_resource = app.path().resource_dir().map_err(|e| e.to_string())?.join("libSDL3.dylib");
        // Removing any stale copy first means an Update (re-extracting into
        // the same app_data path) never trips over a previous write's
        // permissions; the explicit chmod after is defensive so this stays
        // ours to overwrite next time regardless.
        let sdl3_dest = app_bundle.join("Contents/Frameworks/libSDL3.dylib");
        let _ = std::fs::remove_file(&sdl3_dest);
        std::fs::copy(&sdl3_resource, &sdl3_dest).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            let mut perms = std::fs::metadata(&sdl3_dest).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o644);
            std::fs::set_permissions(&sdl3_dest, perms).map_err(|e| e.to_string())?;
        }
        resign_app_bundle(&app_bundle)?;
    }

    Ok(format!("Extracted to {}", dest.display()))
}

#[cfg(target_os = "linux")]
fn extract_jk2mv_linux(app_data: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    // JK2MV has no official portable/tar.gz build for Linux, only a .deb -
    // it installs to a normal FHS layout (/usr/bin, /usr/lib, /usr/share)
    // rather than the flat "everything next to the binary" shape every
    // other build here uses (macOS, Windows, and this project's own Linux
    // Tommyternal build all use that flat shape). Reading the handful of
    // files an actual install needs straight out of the .deb - an ar
    // archive wrapping control.tar.gz/data.tar.gz - and laying them out
    // flat avoids requiring dpkg or root just to get at them.
    //
    // Unverified on real Linux hardware: jk2mvmenu_amd64.so ships at
    // /usr/lib in the .deb, but the binary's own strings have no hardcoded
    // path for it, only the bare name - and every other build here
    // (including this same codebase's Windows build) keeps its equivalent
    // menu library flat next to the main binary rather than in a lib/
    // folder, which is the closest evidence available for where this
    // engine actually looks. If jk2mvmp can't find its menu library at
    // runtime, this placement is the first thing to revisit.
    let deb_path = app_data.join("jk2mv_linux_x64.deb");
    let _ = std::fs::remove_dir_all(dest);
    std::fs::create_dir_all(dest.join("base")).map_err(|e| e.to_string())?;

    let deb_file = std::fs::File::open(&deb_path).map_err(|e| e.to_string())?;
    let mut deb_archive = ar::Archive::new(deb_file);
    let mut data_tar_gz: Option<Vec<u8>> = None;
    while let Some(entry_result) = deb_archive.next_entry() {
        let mut entry = entry_result.map_err(|e| e.to_string())?;
        let name = String::from_utf8_lossy(entry.header().identifier()).to_string();
        if name.starts_with("data.tar.gz") {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;
            data_tar_gz = Some(buf);
            break;
        }
    }
    let data_bytes = data_tar_gz
        .ok_or_else(|| "jk2mv .deb has no data.tar.gz entry - upstream may have changed its packaging".to_string())?;

    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(data_bytes));
    let mut tar_archive = tar::Archive::new(gz);
    for entry_result in tar_archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry_result.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
        let out_path = match path.as_str() {
            "./usr/share/jk2mv/base/assetsmv.pk3" => Some(dest.join("base").join("assetsmv.pk3")),
            "./usr/share/jk2mv/base/assetsmv2.pk3" => Some(dest.join("base").join("assetsmv2.pk3")),
            "./usr/bin/jk2mvmp" => Some(dest.join("jk2mvmp")),
            "./usr/lib/jk2mvmenu_amd64.so" => Some(dest.join("jk2mvmenu_amd64.so")),
            _ => None,
        };
        if let Some(out_path) = out_path {
            entry.unpack(&out_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn extract_jk2mv(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = app_data.join("extracted").join("jk2mv");

    #[cfg(target_os = "linux")]
    {
        extract_jk2mv_linux(&app_data, &dest)?;
        return Ok(format!("Extracted to {}", dest.display()));
    }

    #[cfg(target_os = "windows")]
    {
        // The Windows portable build wraps everything (base/ plus the
        // client/dedicated exes) in one versioned top-level folder, unlike
        // the macOS dmg's payload, which already sits flat. Extract to a
        // scratch location, then move that single folder's contents up to
        // dest so resolve_jk2mv_install's payload_dir is flat on every
        // platform, same as find_single_subdir already does for Tommyternal.
        let zip_path = app_data.join("jk2mv_windows_x64.zip");
        let raw_dest = app_data.join("extracted").join("jk2mv_raw");
        let _ = std::fs::remove_dir_all(&raw_dest);
        let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        archive.extract(&raw_dest).map_err(|e| e.to_string())?;
        let inner = find_single_subdir(&raw_dest)?;
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&inner, &dest).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&raw_dest);
        return Ok(format!("Extracted to {}", dest.display()));
    }

    #[cfg(target_os = "macos")]
    {
        let dmg_path = app_data.join("jk2mv_macos_x86_64.dmg");
        let mount_point = app_data.join("dmg_mount_jk2mv");

        // Defensive: clear any stale mount left by a previous crashed attempt.
        let _ = std::process::Command::new("hdiutil")
            .args(["detach", mount_point.to_str().unwrap()])
            .output();
        std::fs::create_dir_all(&mount_point).map_err(|e| e.to_string())?;

        let attach = std::process::Command::new("hdiutil")
            .args([
                "attach",
                dmg_path.to_str().unwrap(),
                "-nobrowse",
                "-mountpoint",
                mount_point.to_str().unwrap(),
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if !attach.success() {
            return Err("hdiutil attach failed".to_string());
        }

        let copy_result = copy_dir_recursive(&mount_point.join("jk2mvmp.app"), &dest.join("jk2mvmp.app"));

        let _ = std::process::Command::new("hdiutil")
            .args(["detach", mount_point.to_str().unwrap()])
            .status();

        copy_result?;
        resign_app_bundle(&dest.join("jk2mvmp.app"))?;
        return Ok(format!("Extracted to {}", dest.display()));
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

// Lets the frontend pick the right manifest entry (each client mod ships a
// different download per OS) without needing its own OS-detection plugin -
// std::env::consts::OS already returns exactly "macos"/"windows"/"linux".
#[tauri::command]
fn current_platform() -> &'static str {
    std::env::consts::OS
}

const JK2_STEAM_APP_ID: u32 = 6030;

fn folder_override_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data.join("game_folder_override.json"))
}

// The override document:
//   { "path": "<default for every client>",
//     "clients": { "<mod_id>": "<that client's own folder>" } }
//
// "path" alone is the original single-folder shape and is still read as the
// default, so an existing install keeps working untouched. Per-client entries
// exist because a client doesn't have to live beside the others: someone
// without a stock Steam install can perfectly well keep a separate, complete
// game folder per client (reported first-hand - one each for Tommyternal,
// EternalJK and NWH), and a single global path can only ever point at one of
// them.
fn load_override_doc(app: &tauri::AppHandle) -> serde_json::Value {
    folder_override_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

// `mod_id` None asks for the default folder; Some(id) prefers that client's
// own folder and falls back to the default when it hasn't got one.
fn load_folder_override(app: &tauri::AppHandle, mod_id: Option<&str>) -> Option<std::path::PathBuf> {
    let doc = load_override_doc(app);
    let per_client = mod_id
        .and_then(|id| doc.get("clients")?.get(id)?.as_str().map(std::path::PathBuf::from))
        .filter(|d| d.is_dir());
    per_client.or_else(|| {
        let dir = std::path::PathBuf::from(doc.get("path")?.as_str()?);
        dir.is_dir().then_some(dir)
    })
}

fn save_folder_override(
    app: &tauri::AppHandle,
    mod_id: Option<&str>,
    dir: &std::path::Path,
) -> Result<(), String> {
    let path = folder_override_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Read-modify-write: setting one client's folder must not drop the
    // default or any other client's.
    let mut doc = load_override_doc(app);
    match mod_id {
        Some(id) => {
            if !doc.get("clients").is_some_and(|c| c.is_object()) {
                doc["clients"] = serde_json::json!({});
            }
            doc["clients"][id] = serde_json::json!(dir.to_string_lossy());
        }
        None => doc["path"] = serde_json::json!(dir.to_string_lossy()),
    }
    std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap()).map_err(|e| e.to_string())
}

fn clear_folder_override(app: &tauri::AppHandle, mod_id: &str) -> Result<(), String> {
    let path = folder_override_path(app)?;
    let mut doc = load_override_doc(app);
    if let Some(clients) = doc.get_mut("clients").and_then(|c| c.as_object_mut()) {
        clients.remove(mod_id);
    }
    std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap()).map_err(|e| e.to_string())
}

// Where Steam has JK2, found once and kept: steamlocate re-reads Steam's
// library files every call, and this is asked on every path the launcher
// resolves - a page of Media thumbnails alone asked hundreds of times. Only
// a successful find is kept, so installing the game while the launcher is
// open still gets noticed on the next ask.
static STEAM_JK2_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn steam_jk2_install() -> Result<std::path::PathBuf, String> {
    if let Some(dir) = STEAM_JK2_DIR.get() {
        return Ok(dir.clone());
    }
    let steam_dir = steamlocate::locate().map_err(|e| format!("Steam not found: {e}"))?;
    let (app_entry, library) = steam_dir
        .find_app(JK2_STEAM_APP_ID)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Jedi Knight II isn't installed via Steam, or wasn't found in any library.".to_string())?;
    let dir = library.resolve_app_dir(&app_entry);
    Ok(STEAM_JK2_DIR.get_or_init(|| dir).clone())
}

fn find_jk2_install(app: &tauri::AppHandle, mod_id: Option<&str>) -> Result<std::path::PathBuf, String> {
    if let Some(dir) = load_folder_override(app, mod_id) {
        return Ok(dir);
    }
    steam_jk2_install()
}

#[tauri::command]
fn locate_jk2(app: tauri::AppHandle) -> Result<String, String> {
    let install_root = find_jk2_install(&app, None)?;
    Ok(format!("Found Jedi Knight II at {}", install_root.display()))
}

#[tauri::command]
fn get_game_folder_override(app: tauri::AppHandle) -> Option<String> {
    load_folder_override(&app, None).map(|p| p.to_string_lossy().to_string())
}

// What a given client will actually use, and whether that's its own folder
// or just the shared default - the UI shows the difference so "which copy of
// the game is this going to touch" is never a guess.
#[derive(serde::Serialize)]
struct ClientFolder {
    path: Option<String>,
    is_own: bool,
}

#[tauri::command]
fn get_client_folder(app: tauri::AppHandle, mod_id: String) -> ClientFolder {
    let doc = load_override_doc(&app);
    let own = doc
        .get("clients")
        .and_then(|c| c.get(&mod_id))
        .and_then(|p| p.as_str())
        .map(std::path::PathBuf::from)
        .filter(|d| d.is_dir());
    match own {
        Some(dir) => ClientFolder { path: Some(dir.to_string_lossy().to_string()), is_own: true },
        None => ClientFolder {
            path: find_jk2_install(&app, None).ok().map(|p| p.to_string_lossy().to_string()),
            is_own: false,
        },
    }
}

#[tauri::command]
fn clear_client_folder(app: tauri::AppHandle, mod_id: String) -> Result<(), String> {
    clear_folder_override(&app, &mod_id)
}

// Accepting a detected folder (see detect_client_folder) - no file dialog,
// the path is one this launcher already found and validated. Re-validated
// here anyway rather than trusted, since it arrives back via the frontend.
#[tauri::command]
fn set_client_folder(app: tauri::AppHandle, mod_id: String, path: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("{path} isn't a folder"));
    }
    find_base_dir(&dir)?;
    save_folder_override(&app, Some(&mod_id), &dir)
}

// Clients very often sit side by side rather than inside one shared folder -
// a "Games" directory holding a complete game folder per client is a normal
// way to set this up without Steam involved at all. When a client isn't in
// the folder we're currently pointed at, the neighbours are the obvious next
// place to look, and finding it there beats telling someone it isn't
// installed when it demonstrably is.
//
// Returns a suggestion only, never applied on its own: the UI offers it and
// the user accepts. Stays quiet unless the answer is unambiguous - one
// neighbour, holding a real base/ folder and this client's own executable.
#[tauri::command]
fn detect_client_folder(app: tauri::AppHandle, mod_id: String) -> Option<String> {
    let binary = client_binary_name(&mod_id)?;

    // Already resolves to somewhere this client actually is - nothing to say.
    if let Ok((_, game_root)) = find_jk2_base_and_root(&app, Some(&mod_id)) {
        if game_root.join(binary).exists() {
            return None;
        }
    }

    let current = find_jk2_install(&app, Some(&mod_id)).ok()?;
    let siblings = std::fs::read_dir(current.parent()?).ok()?;
    let mut hits: Vec<std::path::PathBuf> = siblings
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|dir| dir.is_dir())
        .filter(|dir| {
            find_base_dir(dir)
                .ok()
                .and_then(|base| base.parent().map(|root| root.join(binary).exists()))
                .unwrap_or(false)
        })
        .collect();

    (hits.len() == 1).then(|| hits.remove(0).to_string_lossy().to_string())
}

// blocking_pick_folder's own docs say not to call it on the main thread - an
// async command runs on a worker instead, which is what stopped this
// crashing (the same fix pick_pk3_files needed).
async fn pick_folder_into(app: &tauri::AppHandle, mod_id: Option<&str>, title: &str) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_title(title).blocking_pick_folder();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let dir = file_path.into_path().map_err(|e| e.to_string())?;
    // Validate before accepting - refuse a folder that doesn't actually resolve
    // to a base/ dir, same shape Steam's own auto-detection guarantees.
    find_base_dir(&dir)?;
    save_folder_override(app, mod_id, &dir)?;
    Ok(Some(dir.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_game_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    pick_folder_into(&app, None, "Select your Jedi Knight II install folder").await
}

#[tauri::command]
async fn pick_client_folder(app: tauri::AppHandle, mod_id: String) -> Result<Option<String>, String> {
    pick_folder_into(&app, Some(&mod_id), "Select this client's own game folder").await
}

fn find_base_dir(install_root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let direct = install_root.join("base");
    if direct.is_dir() {
        return Ok(direct);
    }
    // Steam's Windows release of Jedi Outcast nests everything under a
    // GameData\ folder (confirmed against the game's own Steam community
    // install guides) instead of putting base/ at the install root - and
    // since there's no native Linux build of the game at all, a Linux Steam
    // install runs it through Proton, which stages the exact same Windows
    // directory layout on disk. So this same check covers both platforms.
    let gamedata = install_root.join("GameData").join("base");
    if gamedata.is_dir() {
        return Ok(gamedata);
    }
    let entries = std::fs::read_dir(install_root).map_err(|e| e.to_string())?;
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("app") {
            let nested = path.join("Contents").join("base");
            if nested.is_dir() {
                return Ok(nested);
            }
        }
    }
    Err(format!("Could not find a 'base' folder under {}", install_root.display()))
}

#[tauri::command]
fn locate_jk2_base(app: tauri::AppHandle) -> Result<String, String> {
    let install_root = find_jk2_install(&app, None)?;
    let base_dir = find_base_dir(&install_root)?;
    Ok(format!("Found base folder at {}", base_dir.display()))
}

fn find_single_subdir(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let subdirs: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    match subdirs.len() {
        1 => Ok(subdirs.into_iter().next().unwrap()),
        n => Err(format!("Expected exactly one subdirectory under {}, found {n}", dir.display())),
    }
}

enum InstallAction {
    MergeBaseFile {
        src: std::path::PathBuf,
        dest: std::path::PathBuf,
    },
    CopyModDir {
        src: std::path::PathBuf,
        dest: std::path::PathBuf,
    },
    CopyRootFile {
        src: std::path::PathBuf,
        dest: std::path::PathBuf,
    },
}

fn describe_action(action: &InstallAction) -> String {
    let (src, dest, kind) = match action {
        InstallAction::MergeBaseFile { src, dest } => (src, dest, "merge into base"),
        InstallAction::CopyModDir { src, dest } => (src, dest, "mod folder"),
        InstallAction::CopyRootFile { src, dest } => (src, dest, "game root"),
    };
    let status = if dest.exists() { "update" } else { "new" };
    format!("{} -> {} ({kind}, {status})", src.display(), dest.display())
}

const TOMMYTERNAL_MOD_ID: &str = "tommyternal";

fn installed_manifest_path(game_root: &std::path::Path) -> std::path::PathBuf {
    game_root.join(".soracle_installed_mods.json")
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct InstalledModRecord {
    paths: Vec<String>,
    #[serde(default)]
    version: String,
}

#[derive(serde::Serialize)]
struct InstalledStatus {
    installed: bool,
    version: Option<String>,
}

fn load_installed_mods(
    game_root: &std::path::Path,
) -> std::collections::HashMap<String, InstalledModRecord> {
    let Ok(contents) = std::fs::read_to_string(installed_manifest_path(game_root)) else {
        return Default::default();
    };
    if let Ok(records) = serde_json::from_str(&contents) {
        return records;
    }
    // Pre-version-tracking format: mod_id -> plain list of installed paths.
    // Version is unknown for anything installed before this migration.
    serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(&contents)
        .unwrap_or_default()
        .into_iter()
        .map(|(id, paths)| (id, InstalledModRecord { paths, version: String::new() }))
        .collect()
}

fn save_installed_mods(
    game_root: &std::path::Path,
    mods: &std::collections::HashMap<String, InstalledModRecord>,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(mods).map_err(|e| e.to_string())?;
    std::fs::write(installed_manifest_path(game_root), json).map_err(|e| e.to_string())
}

// What each client's launchable file is called inside the game folder, per
// OS - the single source of truth for both launching one (the play_*
// commands) and noticing one is already there (installed_status). On macOS
// these are .app bundles, which are directories, so callers check .exists()
// rather than assuming a plain file.
fn client_binary_name(mod_id: &str) -> Option<&'static str> {
    Some(match mod_id {
        TOMMYTERNAL_MOD_ID => {
            if cfg!(target_os = "windows") { "eternaljk2mvmp.exe" } else { "eternaljk2mvmp" }
        }
        OPENJO_MOD_ID => {
            if cfg!(target_os = "macos") {
                "openjo_sp.arm64.app"
            } else if cfg!(target_os = "windows") {
                "openjo_sp.x86_64.exe"
            } else {
                "openjo_sp.x86_64"
            }
        }
        JK2MV_MOD_ID => {
            if cfg!(target_os = "macos") {
                "jk2mvmp.app"
            } else if cfg!(target_os = "windows") {
                "jk2mvmp.exe"
            } else {
                "jk2mvmp"
            }
        }
        NWH_MOD_ID => {
            if cfg!(target_os = "macos") {
                "NWH.app"
            } else if cfg!(target_os = "windows") {
                "nwhmp.exe"
            } else {
                "nwhmp"
            }
        }
        _ => return None,
    })
}

fn installed_status(mod_id: &str, game_root: &std::path::Path) -> InstalledStatus {
    if let Some(record) = load_installed_mods(game_root).get(mod_id) {
        if !record.paths.is_empty() {
            return InstalledStatus { installed: true, version: Some(record.version.clone()) };
        }
    }
    // Nothing tracked - but the client's own executable may still be sitting
    // right there. Someone who set the game up by hand, or who points the
    // launcher at an existing standalone client folder (common for anyone
    // whose copy of JK2 isn't a stock Steam install), has a perfectly good
    // install this launcher simply didn't create, and reporting it as
    // missing makes Play refuse to run something that works fine. Version is
    // genuinely unknown here, which leaves Update offered - taking it is what
    // brings the install under this launcher's tracking.
    if client_binary_name(mod_id).is_some_and(|name| game_root.join(name).exists()) {
        return InstalledStatus { installed: true, version: None };
    }
    InstalledStatus { installed: false, version: None }
}

// Climbs from `dir` up toward (not including) `stop_at`, removing each
// directory as long as it's completely empty, stopping at the first one
// that isn't (or at stop_at itself, which is never removed).
fn remove_empty_ancestors(dir: &std::path::Path, stop_at: &std::path::Path) {
    let mut dir = dir.to_path_buf();
    while dir != stop_at {
        let is_empty = std::fs::read_dir(&dir).map(|mut e| e.next().is_none()).unwrap_or(false);
        if !is_empty || std::fs::remove_dir(&dir).is_err() {
            break;
        }
        let Some(parent) = dir.parent() else { break };
        dir = parent.to_path_buf();
    }
}

// Removes exactly what install_mod recorded as this mod's own footprint -
// not a full "restore game_root to how it looked before," since shared
// base/ content from other installed clients is left untouched either way.
fn uninstall_mod(mod_id: &str, game_root: &std::path::Path) -> Result<String, String> {
    let mut installed_mods = load_installed_mods(game_root);
    let Some(record) = installed_mods.remove(mod_id) else {
        return Ok("Nothing to uninstall.".to_string());
    };

    let mut removed = 0;
    let mut failed = 0;
    let mut skipped = 0;
    for rel_path in &record.paths {
        let path = game_root.join(rel_path);
        // install_mod tracks individual files, never a directory as one
        // opaque unit - so a tracked path that turns out to be a directory
        // here can only be leftover data from before that was true (or some
        // other surprise). Never blanket-delete it: a mod's own folder can
        // end up holding things we didn't ship at all once it's actually
        // used (Tommyternal's "eternaljk2" folder picks up a live user cfg
        // and chat logs the moment the game runs) - recursively wiping it
        // on uninstall was exactly the bug behind settings resetting after
        // an uninstall/reinstall. Skipping it is a little untidy but never
        // destroys anything that wasn't ours.
        if path.is_dir() && !path.is_symlink() {
            skipped += 1;
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                removed += 1;
                // Once every file inside e.g. jk2mvmp.app/Contents/... is
                // gone, the directory tree left behind is just an empty
                // shell - clean it up so a later install doesn't run into
                // check_ownership refusing to touch a directory it thinks
                // is unrelated leftover content. Only ever removes a
                // directory that's actually empty, so anything still
                // holding real content (tracked or not) is left alone.
                if let Some(parent) = path.parent() {
                    remove_empty_ancestors(parent, game_root);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // already gone
            Err(_) => failed += 1,
        }
    }

    save_installed_mods(game_root, &installed_mods)?;
    let mut message = format!("Uninstalled ({removed} item(s) removed)");
    if failed > 0 {
        message.push_str(&format!("; {failed} couldn't be deleted (may need manual cleanup)"));
    }
    if skipped > 0 {
        message.push_str(&format!("; left {skipped} folder(s) in place to avoid deleting anything not from this install"));
    }
    message.push('.');
    Ok(message)
}

fn check_ownership(
    dest: &std::path::Path,
    game_root: &std::path::Path,
    already_ours: &std::collections::HashSet<String>,
) -> Result<(), String> {
    if dest.exists() {
        let rel = dest
            .strip_prefix(game_root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        // A tracked entry can be this exact path (a single copied file) or
        // something nested under it - a whole app bundle like JK2MV's
        // jk2mvmp.app is tracked file-by-file since the fix that stopped
        // uninstall from wiping data a client writes into its own folder
        // (Tommyternal's cfg/chat logs), so the bundle's own top-level
        // directory name never appears verbatim in already_ours anymore.
        let owns_it = already_ours.contains(&rel) || already_ours.iter().any(|p| p.starts_with(&format!("{rel}/")));
        if !owns_it {
            return Err(format!(
                "{} already exists and wasn't installed by this launcher - refusing to overwrite",
                dest.display()
            ));
        }
    }
    Ok(())
}

fn plan_install(
    payload_dir: &std::path::Path,
    real_base: &std::path::Path,
    game_root: &std::path::Path,
    already_ours: &std::collections::HashSet<String>,
) -> Result<Vec<InstallAction>, String> {
    let mut actions = Vec::new();

    for entry in std::fs::read_dir(payload_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();

        if path.is_dir() && name == "base" {
            for inner in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                let inner_path = inner.map_err(|e| e.to_string())?.path();
                let dest = real_base.join(inner_path.file_name().unwrap());
                check_ownership(&dest, game_root, already_ours)?;
                actions.push(InstallAction::MergeBaseFile {
                    src: inner_path,
                    dest,
                });
            }
        } else {
            let dest = game_root.join(&name);
            if path.is_dir() {
                // No top-level ownership check here - a mod's own folder
                // can (by design, and confirmed for real: Tommyternal's
                // "eternaljk2") end up holding files we never shipped once
                // the game actually runs in it, and after a full uninstall
                // there's no tracking record left to compare against at
                // all even though reinstalling into that same surviving
                // folder is completely normal. copy_dir_recursive only
                // ever adds/overwrites the specific files in our own
                // payload, so it can't clobber anything we don't already
                // know about regardless.
                actions.push(InstallAction::CopyModDir { src: path, dest });
            } else {
                check_ownership(&dest, game_root, already_ours)?;
                actions.push(InstallAction::CopyRootFile { src: path, dest });
            }
        }
    }
    Ok(actions)
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        if file_type.is_symlink() {
            // Recreate the symlink itself rather than dereferencing it.
            // macOS .framework bundles (JK2MV's bundled SDL2.framework, for
            // one) rely on their internal Versions/Current -> Versions/A
            // style symlinks to read as a valid framework at all - copying
            // their *targets' contents* instead leaves three ambiguous
            // copies of the same files, and codesign refuses to sign it
            // ("bundle format is ambiguous (could be app or framework)").
            let target = std::fs::read_link(&path).map_err(|e| e.to_string())?;
            // A previous install from before this fix could have left a
            // *real* directory sitting where a symlink now needs to go
            // (this exact bundle used to get flattened) - remove_file alone
            // can't clear that, so check which kind of thing is actually
            // there rather than assuming.
            if dest_path.is_symlink() {
                let _ = std::fs::remove_file(&dest_path);
            } else if dest_path.is_dir() {
                let _ = std::fs::remove_dir_all(&dest_path);
            } else {
                let _ = std::fs::remove_file(&dest_path);
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &dest_path).map_err(|e| e.to_string())?;
            #[cfg(not(unix))]
            {
                // This helper is only ever used for macOS .app/.framework
                // extraction today, so there's nothing that exercises this
                // branch yet - falling back to copying the target's actual
                // content rather than leaving it broken if that changes.
                if target.is_dir() {
                    copy_dir_recursive(&target, &dest_path)?;
                } else {
                    std::fs::copy(&target, &dest_path).map_err(|e| e.to_string())?;
                }
            }
        } else if file_type.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            // A source file with read-only permissions (e.g. anything that
            // traces back to a Homebrew Cellar copy, like OpenJO's bundled
            // SDL3) makes std::fs::copy produce an equally read-only
            // destination the first time. An Update then re-runs this same
            // copy against that now-existing, still-read-only file and fails
            // with EACCES. Clearing it first avoids that regardless of which
            // file it is.
            let _ = std::fs::remove_file(&dest_path);
            std::fs::copy(&path, &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Every file actually sitting under dir right now (not the directory names
// themselves) - used so a whole-folder install can still be uninstalled
// file-by-file rather than as one deletable unit.
fn list_files_recursive(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            files.extend(list_files_recursive(&path)?);
        } else {
            files.push(path);
        }
    }
    Ok(files)
}

fn find_jk2_base_and_root(
    app: &tauri::AppHandle,
    mod_id: Option<&str>,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let install_root = find_jk2_install(app, mod_id)?;
    let base_dir = find_base_dir(&install_root)?;
    let game_root = base_dir
        .parent()
        .ok_or_else(|| "base folder has no parent directory".to_string())?
        .to_path_buf();
    Ok((base_dir, game_root))
}

const NWH_MOD_ID: &str = "nwh";

fn resolve_nwh_install(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let payload_dir = find_single_subdir(&app_data.join("extracted").join("nwh"))?;
    let (base_dir, game_root) = find_jk2_base_and_root(app, Some(NWH_MOD_ID))?;
    Ok((payload_dir, base_dir, game_root))
}

#[tauri::command]
fn preview_install_nwh(app: tauri::AppHandle) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_nwh_install(&app)?;
    preview_install(NWH_MOD_ID, &payload_dir, &base_dir, &game_root)
}

#[tauri::command]
fn install_nwh(app: tauri::AppHandle, version: String) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_nwh_install(&app)?;
    install_mod(NWH_MOD_ID, &version, &payload_dir, &base_dir, &game_root)
}

#[tauri::command]
fn is_nwh_installed(app: tauri::AppHandle) -> Result<InstalledStatus, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(NWH_MOD_ID))?;
    Ok(installed_status(NWH_MOD_ID, &game_root))
}

#[tauri::command]
fn uninstall_nwh(app: tauri::AppHandle) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(NWH_MOD_ID))?;
    uninstall_mod(NWH_MOD_ID, &game_root)
}

// How long a freshly launched client gets to prove it actually started.
// Nothing that fails to *start* - a missing library, a bad signature, a
// binary for the wrong architecture - survives anywhere near this long;
// dyld kills those within milliseconds. A game that got as far as opening
// its window is well past the point where these failures happen.
const LAUNCH_GRACE_PERIOD: std::time::Duration = std::time::Duration::from_secs(2);

// Spawns a client binary directly and only reports success once it has
// stayed alive through LAUNCH_GRACE_PERIOD. Just spawning isn't enough:
// spawn() succeeds as soon as the OS creates the process, so a client that
// dies on startup (Tommyternal on a Mac without Homebrew, before its
// libraries were bundled) still read as "Launched" while nothing appeared.
// Its output goes to a per-client log in the app data folder, truncated
// each launch, so a failure can quote what the client itself said.
fn spawn_client(
    app: &tauri::AppHandle,
    mod_id: &str,
    mut cmd: std::process::Command,
    binary: &std::path::Path,
) -> Result<String, String> {
    let log_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log_path = log_dir.join(format!("{mod_id}-last-launch.log"));
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    cmd.stdout(log.try_clone().map_err(|e| e.to_string())?);
    cmd.stderr(log);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    while started.elapsed() < LAUNCH_GRACE_PERIOD {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(describe_failed_launch(binary, status, &log_path));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(format!("Launched {}", binary.display()))
}

fn describe_failed_launch(
    binary: &std::path::Path,
    status: std::process::ExitStatus,
    log_path: &std::path::Path,
) -> String {
    #[cfg(unix)]
    let how = match std::os::unix::process::ExitStatusExt::signal(&status) {
        Some(signal) => format!("was killed by the system (signal {signal})"),
        None => format!("exited immediately ({status})"),
    };
    #[cfg(not(unix))]
    let how = format!("exited immediately ({status})");

    // The last few lines are where the reason lives - dyld's "Library not
    // loaded: ..." or the engine's own fatal error - and the whole log can
    // be long enough to bury it.
    let log = std::fs::read_to_string(log_path).unwrap_or_default();
    let lines: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(8)..].join("\n");
    let name = binary.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    if tail.is_empty() {
        format!("{name} {how} without printing anything. Full log: {}", log_path.display())
    } else {
        format!("{name} {how}:\n{tail}\n\nFull log: {}", log_path.display())
    }
}

// NWH runs out of its own "nwh" game folder (its config lands in nwh/), so
// unlike the other clients it's never pointed at a launchermods_ folder with
// fs_game - that would switch its own client code off. Its PK3 mods go where
// it already looks instead (see nwh_mod_dir).
fn play_nwh_blocking(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(NWH_MOD_ID))?;
    let mut args = nwh_launch_args(&game_root);
    args.extend(shared_settings_args(&app, NWH_MOD_ID));
    if let Some(address) = connect_address {
        args.extend(["+connect".to_string(), address]);
    }
    launch_client(&app, &game_root, NWH_MOD_ID, &args)
}

// What every NWH start needs, whatever it's starting into (play_nwh,
// play_demo). NWH.app keeps its own data inside the bundle and only takes the
// retail paks (assets0-5) from the game folder, via fs_assetspath. It finds a
// stock Steam install on its own; passing the folder covers every other setup.
fn nwh_launch_args(game_root: &std::path::Path) -> Vec<String> {
    if cfg!(target_os = "macos") {
        vec!["+set".to_string(), "fs_assetspath".to_string(), game_root.to_string_lossy().to_string()]
    } else {
        Vec::new()
    }
}

// Async so spawn_client's grace-period wait runs on the blocking pool
// rather than the main thread, which would freeze the window meanwhile.
// The other play_* commands wrap their blocking halves the same way.
#[tauri::command]
async fn play_nwh(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || play_nwh_blocking(app, connect_address))
        .await
        .map_err(|e| e.to_string())?
}

fn resolve_tommyternal_install(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let payload_dir = find_single_subdir(&app_data.join("extracted").join("tommyternal"))?;
    let (base_dir, game_root) = find_jk2_base_and_root(app, Some(TOMMYTERNAL_MOD_ID))?;
    Ok((payload_dir, base_dir, game_root))
}

#[tauri::command]
fn is_tommyternal_installed(app: tauri::AppHandle) -> Result<InstalledStatus, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(TOMMYTERNAL_MOD_ID))?;
    Ok(installed_status(TOMMYTERNAL_MOD_ID, &game_root))
}

#[tauri::command]
fn uninstall_tommyternal(app: tauri::AppHandle) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(TOMMYTERNAL_MOD_ID))?;
    uninstall_mod(TOMMYTERNAL_MOD_ID, &game_root)
}

fn play_tommyternal_blocking(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(TOMMYTERNAL_MOD_ID))?;
    let binary = game_root.join(client_binary_name(TOMMYTERNAL_MOD_ID).unwrap());
    let mut cmd = std::process::Command::new(&binary);
    cmd.current_dir(&game_root);
    if client_has_pk3_mods(&game_root, TOMMYTERNAL_MOD_ID) {
        cmd.args(["+set", "fs_game", &client_mod_folder_name(TOMMYTERNAL_MOD_ID)]);
    }
    cmd.args(shared_settings_args(&app, TOMMYTERNAL_MOD_ID));
    if let Some(address) = &connect_address {
        cmd.args(["+connect", address]);
    }
    // Tommyternal's macOS build links SDL2 (sdl2-compat) and OpenSSL at
    // their Homebrew paths, /opt/homebrew/opt/..., so on a Mac without
    // Homebrew dyld kills it before a window opens. dyld retries any library
    // missing from its recorded path by file name in each
    // DYLD_FALLBACK_LIBRARY_PATH directory, so pointing that at this app's
    // own Resources - where the release build ships copies of all three
    // (scripts/fetch-macos-dylibs.sh), next to the libSDL3.dylib that
    // sdl2-compat loads from its own folder - lets it start. Someone who
    // does have Homebrew still gets theirs; the fallback only applies to
    // what's missing. Setting the variable replaces dyld's default fallback
    // list, so that's carried along rather than lost.
    if cfg!(target_os = "macos") {
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let home = std::env::var("HOME").unwrap_or_default();
        cmd.env(
            "DYLD_FALLBACK_LIBRARY_PATH",
            format!("{}:{home}/lib:/usr/local/lib:/usr/lib", resources.display()),
        );
    }
    spawn_client(&app, TOMMYTERNAL_MOD_ID, cmd, &binary)
}

#[tauri::command]
async fn play_tommyternal(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || play_tommyternal_blocking(app, connect_address))
        .await
        .map_err(|e| e.to_string())?
}

fn preview_install(
    mod_id: &str,
    payload_dir: &std::path::Path,
    base_dir: &std::path::Path,
    game_root: &std::path::Path,
) -> Result<String, String> {
    let installed_mods = load_installed_mods(game_root);
    let already_ours: std::collections::HashSet<String> = installed_mods
        .get(mod_id)
        .map(|r| r.paths.clone())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let actions = plan_install(payload_dir, base_dir, game_root, &already_ours)?;
    Ok(actions.iter().map(describe_action).collect::<Vec<_>>().join("\n"))
}

fn install_mod(
    mod_id: &str,
    version: &str,
    payload_dir: &std::path::Path,
    base_dir: &std::path::Path,
    game_root: &std::path::Path,
) -> Result<String, String> {
    let mut installed_mods = load_installed_mods(game_root);
    let already_ours: std::collections::HashSet<String> = installed_mods
        .get(mod_id)
        .map(|r| r.paths.clone())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let actions = plan_install(payload_dir, base_dir, game_root, &already_ours)?;

    let mut installed_paths = Vec::new();
    for action in &actions {
        match action {
            InstallAction::MergeBaseFile { src, dest } | InstallAction::CopyRootFile { src, dest } => {
                std::fs::copy(src, dest).map_err(|e| e.to_string())?;
                installed_paths.push(dest.strip_prefix(game_root).unwrap().to_string_lossy().to_string());
            }
            InstallAction::CopyModDir { src, dest } => {
                copy_dir_recursive(src, dest)?;
                // Track every individual file actually placed, not the
                // directory as one opaque unit - a mod's own folder can
                // pick up things we never shipped once it's actually used
                // (a live user config, chat logs, ...), and uninstall must
                // be able to remove exactly what came from this install
                // without also deleting whatever else ended up alongside it.
                for file in list_files_recursive(dest)? {
                    installed_paths.push(file.strip_prefix(game_root).unwrap().to_string_lossy().to_string());
                }
            }
        };
    }

    installed_mods.insert(
        mod_id.to_string(),
        InstalledModRecord { paths: installed_paths, version: version.to_string() },
    );
    save_installed_mods(game_root, &installed_mods)?;

    Ok(format!(
        "Installed {} items into {}",
        actions.len(),
        game_root.display()
    ))
}

#[tauri::command]
fn preview_install_tommyternal(app: tauri::AppHandle) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_tommyternal_install(&app)?;
    preview_install(TOMMYTERNAL_MOD_ID, &payload_dir, &base_dir, &game_root)
}

#[tauri::command]
fn install_tommyternal(app: tauri::AppHandle, version: String) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_tommyternal_install(&app)?;
    install_mod(TOMMYTERNAL_MOD_ID, &version, &payload_dir, &base_dir, &game_root)
}

const OPENJO_MOD_ID: &str = "openjo";

fn resolve_openjo_install(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let payload_dir = app_data.join("extracted").join("openjo");
    let (base_dir, game_root) = find_jk2_base_and_root(app, Some(OPENJO_MOD_ID))?;
    Ok((payload_dir, base_dir, game_root))
}

#[tauri::command]
fn preview_install_openjo(app: tauri::AppHandle) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_openjo_install(&app)?;
    preview_install(OPENJO_MOD_ID, &payload_dir, &base_dir, &game_root)
}

#[tauri::command]
fn install_openjo(app: tauri::AppHandle, version: String) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_openjo_install(&app)?;
    install_mod(OPENJO_MOD_ID, &version, &payload_dir, &base_dir, &game_root)
}

#[tauri::command]
fn is_openjo_installed(app: tauri::AppHandle) -> Result<InstalledStatus, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(OPENJO_MOD_ID))?;
    Ok(installed_status(OPENJO_MOD_ID, &game_root))
}

#[tauri::command]
fn uninstall_openjo(app: tauri::AppHandle) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(OPENJO_MOD_ID))?;
    uninstall_mod(OPENJO_MOD_ID, &game_root)
}

fn play_openjo_blocking(app: tauri::AppHandle) -> Result<String, String> {
    // Single-player only - no +connect support here (see manifest description).
    let (_, game_root) = find_jk2_base_and_root(&app, Some(OPENJO_MOD_ID))?;
    let mut args: Vec<String> = Vec::new();
    if client_has_pk3_mods(&game_root, OPENJO_MOD_ID) {
        args.extend(["+set".to_string(), "fs_game".to_string(), client_mod_folder_name(OPENJO_MOD_ID)]);
    }
    args.extend(shared_settings_args(&app, OPENJO_MOD_ID));
    // launch_client goes through `open --args` for the macOS .app bundle and
    // runs the binary directly elsewhere, with the start-up check.
    launch_client(&app, &game_root, OPENJO_MOD_ID, &args)
}

#[tauri::command]
async fn play_openjo(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || play_openjo_blocking(app))
        .await
        .map_err(|e| e.to_string())?
}

const JK2MV_MOD_ID: &str = "jk2mv";

fn resolve_jk2mv_install(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let payload_dir = app_data.join("extracted").join("jk2mv");
    let (base_dir, game_root) = find_jk2_base_and_root(app, Some(JK2MV_MOD_ID))?;
    Ok((payload_dir, base_dir, game_root))
}

#[tauri::command]
fn preview_install_jk2mv(app: tauri::AppHandle) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_jk2mv_install(&app)?;
    preview_install(JK2MV_MOD_ID, &payload_dir, &base_dir, &game_root)
}

#[tauri::command]
fn install_jk2mv(app: tauri::AppHandle, version: String) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_jk2mv_install(&app)?;
    install_mod(JK2MV_MOD_ID, &version, &payload_dir, &base_dir, &game_root)
}

#[tauri::command]
fn is_jk2mv_installed(app: tauri::AppHandle) -> Result<InstalledStatus, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(JK2MV_MOD_ID))?;
    Ok(installed_status(JK2MV_MOD_ID, &game_root))
}

#[tauri::command]
fn uninstall_jk2mv(app: tauri::AppHandle) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(JK2MV_MOD_ID))?;
    uninstall_mod(JK2MV_MOD_ID, &game_root)
}

fn play_jk2mv_blocking(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, Some(JK2MV_MOD_ID))?;

    // `open --args` only accepts one --args flag - everything after it is
    // passed straight through to the app, so both +set and +connect (when
    // present) have to be collected first and appended together. Collected
    // up front since Windows/Linux want the exact same flags, just passed
    // straight on the command line instead of behind `open --args`.
    let mut extra_args: Vec<String> = Vec::new();
    if client_has_pk3_mods(&game_root, JK2MV_MOD_ID) {
        extra_args.push("+set".to_string());
        extra_args.push("fs_game".to_string());
        extra_args.push(client_mod_folder_name(JK2MV_MOD_ID));
    }
    extra_args.extend(shared_settings_args(&app, JK2MV_MOD_ID));
    if let Some(address) = &connect_address {
        extra_args.push("+connect".to_string());
        extra_args.push(address.clone());
    }

    if cfg!(target_os = "macos") {
        let app_bundle = game_root.join(client_binary_name(JK2MV_MOD_ID).unwrap());
        let mut cmd = std::process::Command::new("open");
        cmd.arg(&app_bundle);
        if !extra_args.is_empty() {
            cmd.arg("--args");
            cmd.args(&extra_args);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(format!("Launched {}", app_bundle.display()));
    }

    let binary = game_root.join(client_binary_name(JK2MV_MOD_ID).unwrap());
    let mut cmd = std::process::Command::new(&binary);
    cmd.current_dir(&game_root);
    cmd.args(&extra_args);
    spawn_client(&app, JK2MV_MOD_ID, cmd, &binary)
}

#[tauri::command]
async fn play_jk2mv(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || play_jk2mv_blocking(app, connect_address))
        .await
        .map_err(|e| e.to_string())?
}

// --- Custom PK3 mods --------------------------------------------------------
// Distinct from the "mod" = game client naming used everywhere else in this
// file - these are user-added content PK3s (maps, skins, etc.), tracked
// separately from the client-install system above.

const PK3_CLIENT_IDS: [&str; 4] =
    [TOMMYTERNAL_MOD_ID, OPENJO_MOD_ID, JK2MV_MOD_ID, NWH_MOD_ID];
const PK3_ALL_TARGET: &str = "all";

// Clients that bring their own menu module and menus. A PK3 that swaps out
// the stock multiplayer menus stops them starting at all: Tommyternal's menu
// dies loading Expanded_Menu.pk3's, with nothing more than "Error during
// initialization" to show for it.
const OWN_MENU_CLIENT_IDS: [&str; 2] = [TOMMYTERNAL_MOD_ID, NWH_MOD_ID];

// Whether a PK3 carries its own multiplayer menus - the menu lists the UI
// loads, or any of the menus in them. Only the zip's directory is read.
fn pk3_replaces_menus(path: &std::path::Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    let replaces = archive.file_names().filter_map(Result::ok).any(|name| {
        let name = name.replace('\\', "/").to_ascii_lowercase();
        name == "ui/jk2mpmenus.txt"
            || name == "ui/jk2mpingame.txt"
            || (name.starts_with("ui/jk2mp/") && name.ends_with(".menu"))
    });
    replaces
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Pk3Mod {
    filename: String,
    #[serde(default)]
    targets: Vec<String>,
    // When it was added, in Unix seconds - the Mods view lists newest first.
    // 0 for entries from before this was tracked, until list_pk3_mods
    // backfills them (see added_time).
    #[serde(default)]
    added: u64,
    // Worked out from the file each time the list is read, never trusted
    // from the manifest.
    #[serde(default, skip_deserializing)]
    replaces_menus: bool,
}

fn unix_secs(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn now_secs() -> u64 {
    unix_secs(std::time::SystemTime::now())
}

// Best guess at when a file arrived: its creation time where the filesystem
// keeps one (macOS, Windows), else when it was last written - for a PK3
// nobody edits, that's when it was copied or downloaded.
fn added_time(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.created().or_else(|_| m.modified()).ok())
        .map(unix_secs)
        .unwrap_or(0)
}

// A PK3 name as the frontend hands it back: a bare filename, nothing that
// could be a path. Everything that joins one onto a folder checks this
// first, so "../x" can never reach outside the folder it's meant for.
fn check_pk3_filename(filename: &str) -> Result<(), String> {
    let bare = !filename.contains(['/', '\\']) && filename != "." && filename != "..";
    if bare && filename.to_lowercase().ends_with(".pk3") {
        Ok(())
    } else {
        Err(format!("{filename} isn't a PK3 filename"))
    }
}

fn pk3_library_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("mods_library"))
}

fn pk3_manifest_path(game_root: &std::path::Path) -> std::path::PathBuf {
    game_root.join(".soracle_pk3_mods.json")
}

fn load_pk3_mods(game_root: &std::path::Path) -> Vec<Pk3Mod> {
    std::fs::read_to_string(pk3_manifest_path(game_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_pk3_mods(game_root: &std::path::Path, mods: &[Pk3Mod]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(mods).map_err(|e| e.to_string())?;
    std::fs::write(pk3_manifest_path(game_root), json).map_err(|e| e.to_string())
}

fn client_mod_folder_name(client_id: &str) -> String {
    format!("launchermods_{client_id}")
}

// Every client's own launcher-managed mod folder, activated via `+set
// fs_game` at launch - separate from base/ so a mod assigned to one client
// never touches another's.
fn client_mod_folder(game_root: &std::path::Path, client_id: &str) -> std::path::PathBuf {
    game_root.join(client_mod_folder_name(client_id))
}

fn client_has_pk3_mods(game_root: &std::path::Path, client_id: &str) -> bool {
    std::fs::read_dir(client_mod_folder(game_root, client_id))
        .map(|mut d| d.next().is_some())
        .unwrap_or(false)
}

// Every distinct game folder currently in play: the shared default plus any
// client pointed at its own. Deduped by game root, since the common case is
// still everything living in one folder.
fn all_game_roots(app: &tauri::AppHandle) -> Vec<(std::path::PathBuf, std::path::PathBuf)> {
    let mut seen = std::collections::HashSet::new();
    let mut roots = Vec::new();
    let candidates = std::iter::once(None).chain(PK3_CLIENT_IDS.iter().map(|id| Some(*id)));
    for mod_id in candidates {
        if let Ok((base_dir, game_root)) = find_jk2_base_and_root(app, mod_id) {
            if seen.insert(game_root.clone()) {
                roots.push((base_dir, game_root));
            }
        }
    }
    roots
}

// Where a PK3 aimed at `target` has to physically land.
//
// Once clients can each have their own game folder, this stops being one
// path. A client only ever reads the base/ and fs_game folder inside its
// *own* folder, so "All Clients" means one copy in every distinct game
// folder, and a specific client means that client's folder - not the
// default's. Getting this wrong is silent: the file lands somewhere real,
// the client just never looks there, and the mod quietly does nothing.
fn pk3_target_dests(
    app: &tauri::AppHandle,
    target: &str,
    filename: &str,
) -> Vec<std::path::PathBuf> {
    if target == PK3_ALL_TARGET {
        let mut dests: Vec<std::path::PathBuf> = all_game_roots(app)
            .into_iter()
            .map(|(base_dir, _)| base_dir.join(filename))
            .collect();
        // NWH.app takes only the retail paks from the game folder, so on
        // macOS "All Clients" has to reach NWH's own folder as well - once
        // NWH is actually there to use it.
        if cfg!(target_os = "macos") {
            if let Some(dir) = nwh_mod_dir(app).filter(|d| d.is_dir() || nwh_installed(app)) {
                dests.push(dir.join(filename));
            }
        }
        dests
    } else {
        client_pk3_dir(app, target).map(|dir| vec![dir.join(filename)]).unwrap_or_default()
    }
}

// The folder PK3s aimed at just one client go into - one only that client
// loads.
fn client_pk3_dir(app: &tauri::AppHandle, client_id: &str) -> Option<std::path::PathBuf> {
    if client_id == NWH_MOD_ID {
        return nwh_mod_dir(app);
    }
    find_jk2_base_and_root(app, Some(client_id))
        .ok()
        .map(|(_, game_root)| client_mod_folder(&game_root, client_id))
}

// Folders only this client reads PK3s from, on top of the one the launcher
// deploys to: the base/ of its own home folder(s). An installed (non-
// portable) build - JK2MV's macOS and Linux ones - keeps its data there, so
// that's where its auto-downloads land and where people drop files by hand.
// Scanned and cleaned up, never deployed to: the launcher's own folder is
// read by every build of the client, this one only by the installed kind.
fn client_home_pk3_dirs(app: &tauri::AppHandle, client_id: &str) -> Vec<std::path::PathBuf> {
    let own = client_pk3_dir(app, client_id).and_then(|d| d.canonicalize().ok());
    let mut dirs: Vec<std::path::PathBuf> = client_home_dirs(app, client_id)
        .into_iter()
        .map(|home| home.join("base"))
        // Canonical, so one folder reached by two spellings on a
        // case-insensitive disk (OpenJO/ and openjo/) is listed once.
        .filter_map(|dir| dir.canonicalize().ok())
        // NWH's home base/ on macOS is already its deploy folder.
        .filter(|dir| Some(dir) != own.as_ref())
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

// NWH keeps its own "nwh" game folder active (see play_nwh), so its PK3s go
// where it already looks. The Linux and Windows builds are portable - they
// run and save in the game folder, so that's game folder/nwh. The macOS
// NWH.app keeps its game data inside the bundle (which can't be written to
// without breaking its signature) and saves to Application Support/NWHClient,
// whose base/ it always loads.
fn nwh_mod_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if cfg!(target_os = "macos") {
        return app.path().data_dir().ok().map(|d| d.join("NWHClient").join("base"));
    }
    find_jk2_base_and_root(app, Some(NWH_MOD_ID)).ok().map(|(_, game_root)| game_root.join("nwh"))
}

fn nwh_installed(app: &tauri::AppHandle) -> bool {
    find_jk2_base_and_root(app, Some(NWH_MOD_ID))
        .map(|(_, game_root)| installed_status(NWH_MOD_ID, &game_root).installed)
        .unwrap_or(false)
}

// Everything a client install put in place, as full paths - so a client's own
// paks (NWH's nwh-bins.pk3, say) are never mistaken for mods sitting beside them.
fn installed_client_files(game_root: &std::path::Path, client_id: &str) -> std::collections::HashSet<std::path::PathBuf> {
    load_installed_mods(game_root)
        .remove(client_id)
        .map(|record| record.paths.into_iter().map(|p| game_root.join(p)).collect())
        .unwrap_or_default()
}

// NWH's PK3s used to go to launchermods_nwh, switched on with fs_game - which
// also switched NWH's own nwh/ folder off. Moves anything left there to where
// NWH looks now.
fn migrate_legacy_nwh_mods(app: &tauri::AppHandle) {
    let (Some(new_dir), Ok((_, game_root))) = (nwh_mod_dir(app), find_jk2_base_and_root(app, Some(NWH_MOD_ID))) else {
        return;
    };
    let old_dir = client_mod_folder(&game_root, NWH_MOD_ID);
    let names = list_pk3_filenames(&old_dir);
    if names.is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(&new_dir);
    for name in names {
        let (from, to) = (old_dir.join(&name), new_dir.join(&name));
        if std::fs::rename(&from, &to).is_err() && std::fs::copy(&from, &to).is_ok() {
            let _ = std::fs::remove_file(&from);
        }
    }
    let _ = std::fs::remove_dir(&old_dir); // only goes if it's now empty
}

fn deploy_pk3_to_targets(
    app: &tauri::AppHandle,
    library_path: &std::path::Path,
    filename: &str,
    targets: &[String],
) -> Result<(), String> {
    for target in targets {
        for dest in pk3_target_dests(app, target, filename) {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(library_path, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn undeploy_pk3_from_targets(
    app: &tauri::AppHandle,
    filename: &str,
    targets: &[String],
) -> Result<(), String> {
    for target in targets {
        let mut dests = pk3_target_dests(app, target, filename);
        // A client-specific mod may have been found in the client's home
        // folder rather than put there by the launcher - taking it off that
        // client means taking it from there too.
        if target != PK3_ALL_TARGET {
            dests.extend(client_home_pk3_dirs(app, target).into_iter().map(|d| d.join(filename)));
        }
        for dest in dests {
            if dest.exists() {
                std::fs::remove_file(&dest).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

// Every core JK2/JK2MV asset pak - Raven's originals and every fork's own
// base content alike - is named assetsN.pk3 or assetsmv.pk3 (a stray
// "%assets5.pk3" turned up on a real install too). Never let one of these
// through as a "mod": reconciliation would track it, and remove_pk3_mod would
// then delete a file the game needs to run at all.
fn is_core_pk3(filename: &str) -> bool {
    let name = filename.trim_start_matches('%').to_lowercase();
    // NWH ships its own client code and assets as paks in its nwh/ folder
    // (nwh-bins.pk3, nwh-assets.pk3, jk2pro-assets.pk3) - part of the client,
    // not mods, and a hand-installed NWH has no install record to say so.
    name.starts_with("assets") || name.starts_with("nwh-") || name.starts_with("jk2pro-")
}

fn list_pk3_filenames(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.eq_ignore_ascii_case("pk3"))
                })
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                .filter(|filename| !is_core_pk3(filename))
                .collect()
        })
        .unwrap_or_default()
}

// Picks up PK3s that never went through add_pk3_mod/add_pk3_mod_from_download
// - dropped into base/ by hand, or auto-downloaded by the game itself when
// joining a server that serves custom content (confirmed by hand: these land
// straight in base/, dl_-prefixed, no separate download/ folder). Without
// this the Mods view would just never know they exist.
fn reconcile_pk3_mods_with_disk(
    app: &tauri::AppHandle,
    mods: &mut Vec<Pk3Mod>,
) -> Result<(), String> {
    let library_dir = pk3_library_dir(app)?;
    std::fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;

    let mut found: std::collections::HashMap<String, (Vec<String>, std::path::PathBuf)> = std::collections::HashMap::new();
    // Scans every game folder in play, not just the default one - a client
    // pointed at its own folder keeps its base/ and its auto-downloaded PK3s
    // there, and those are exactly as real as the default folder's.
    for (base_dir, _) in all_game_roots(app) {
        for filename in list_pk3_filenames(&base_dir) {
            let path = base_dir.join(&filename);
            found.entry(filename).or_insert((Vec::new(), path)).0.push(PK3_ALL_TARGET.to_string());
        }
    }
    for client_id in PK3_CLIENT_IDS {
        let (Some(folder), Ok((_, game_root))) = (client_pk3_dir(app, client_id), find_jk2_base_and_root(app, Some(client_id))) else {
            continue;
        };
        let shipped = installed_client_files(&game_root, client_id);
        let mut folders = vec![folder];
        folders.extend(client_home_pk3_dirs(app, client_id));
        for folder in folders {
            for filename in list_pk3_filenames(&folder) {
                let path = folder.join(&filename);
                if shipped.contains(&path) {
                    continue;
                }
                found.entry(filename).or_insert((Vec::new(), path)).0.push(client_id.to_string());
            }
        }
    }

    for (filename, (mut targets, source_path)) in found {
        // The same file showing up in several folders is one mod aimed at
        // "all", not the same target listed repeatedly.
        targets.sort();
        targets.dedup();
        // An all-clients mod is also found in a client's own folder (NWH's on
        // macOS, where "all" deploys there too) - "all" already covers it.
        if targets.iter().any(|t| t == PK3_ALL_TARGET) {
            targets = vec![PK3_ALL_TARGET.to_string()];
        }
        let library_path = library_dir.join(&filename);
        if !library_path.exists() {
            let _ = std::fs::copy(&source_path, &library_path);
        }
        match mods.iter_mut().find(|m| m.filename == filename) {
            Some(entry) => {
                let already_all = entry.targets.iter().any(|t| t == PK3_ALL_TARGET);
                for t in &targets {
                    if !already_all && !entry.targets.contains(t) {
                        entry.targets.push(t.clone());
                    }
                }
            }
            None => {
                let added = added_time(&source_path);
                mods.push(Pk3Mod { filename, targets, added, replaces_menus: false });
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn list_pk3_mods(app: tauri::AppHandle) -> Result<Vec<Pk3Mod>, String> {
    let (_, game_root) = find_jk2_base_and_root(&app, None)?;
    migrate_legacy_nwh_mods(&app);
    let mut mods = load_pk3_mods(&game_root);
    reconcile_pk3_mods_with_disk(&app, &mut mods)?;
    // Entries from before `added` existed get dated once from their library
    // copy, then keep that date.
    let library_dir = pk3_library_dir(&app)?;
    for m in mods.iter_mut().filter(|m| m.added == 0) {
        m.added = added_time(&library_dir.join(&m.filename));
    }
    save_pk3_mods(&game_root, &mods)?;
    for m in mods.iter_mut() {
        m.replaces_menus = pk3_replaces_menus(&library_dir.join(&m.filename));
    }
    mods.sort_by(|a, b| b.added.cmp(&a.added).then_with(|| a.filename.cmp(&b.filename)));
    Ok(mods)
}

#[tauri::command]
async fn pick_pk3_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    // blocking_pick_files' own docs say not to call it on the main thread -
    // an async command runs on a worker thread instead of wherever a plain
    // sync command lands, which is what actually made this crash.
    let picked = app
        .dialog()
        .file()
        .add_filter("PK3 Archive", &["pk3"])
        .set_title("Select PK3 mod file(s)")
        .blocking_pick_files();
    let Some(files) = picked else {
        return Ok(Vec::new());
    };
    files
        .into_iter()
        .map(|f| f.into_path().map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string()))
        .collect()
}

// Shared by add_pk3_mod (a local file the user picked) and
// add_pk3_mod_from_download (a file the JS side already fetched and wrote
// into AppData) - same validation, same library copy, same manifest entry.
fn add_pk3_mod_from_path(app: &tauri::AppHandle, source: &std::path::Path) -> Result<String, String> {
    let filename = source
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy()
        .to_string();
    if !filename.to_lowercase().ends_with(".pk3") {
        return Err("Only .pk3 files are supported".to_string());
    }

    let library_dir = pk3_library_dir(app)?;
    std::fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;
    let library_path = library_dir.join(&filename);
    std::fs::copy(source, &library_path).map_err(|e| e.to_string())?;

    // A new mod goes to All Clients straight away - picking clients is for
    // narrowing it down, not a step needed before it does anything. The one
    // exception is a menu replacement, which goes only to the clients that
    // use the stock menus. Adding one that's already tracked keeps whatever
    // it was set to, but refreshes the copies the clients load, in case this
    // is a newer version of it.
    let (_, game_root) = find_jk2_base_and_root(app, None)?;
    let mut mods = load_pk3_mods(&game_root);
    let targets = match mods.iter().find(|m| m.filename == filename) {
        Some(existing) => existing.targets.clone(),
        None => {
            let targets = if pk3_replaces_menus(&library_path) {
                PK3_CLIENT_IDS
                    .iter()
                    .filter(|id| !OWN_MENU_CLIENT_IDS.contains(id))
                    .map(|id| id.to_string())
                    .collect()
            } else {
                vec![PK3_ALL_TARGET.to_string()]
            };
            mods.push(Pk3Mod {
                filename: filename.clone(),
                targets: targets.clone(),
                added: now_secs(),
                replaces_menus: false,
            });
            save_pk3_mods(&game_root, &mods)?;
            targets
        }
    };
    deploy_pk3_to_targets(app, &library_path, &filename, &targets)?;
    Ok(filename)
}

#[tauri::command]
fn add_pk3_mod(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
    add_pk3_mod_from_path(&app, std::path::Path::new(&source_path))
}

// The Monolith-catalog download flow: JS fetches the PK3 bytes (it already
// has the http capability for jk2t.ddns.net) and writes them into AppData at
// `relative_path`, then hands this command just that relative path - Rust
// resolves it against the real AppData dir itself, so the frontend never
// needs to know that absolute path.
#[tauri::command]
fn add_pk3_mod_from_download(app: tauri::AppHandle, relative_path: String) -> Result<String, String> {
    // Only ever pk3_downloads/<name> - the one place the JS side writes to.
    let filename = relative_path
        .strip_prefix("pk3_downloads/")
        .ok_or_else(|| format!("{relative_path} isn't a launcher download"))?;
    check_pk3_filename(filename)?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let source = app_data.join("pk3_downloads").join(filename);
    let result = add_pk3_mod_from_path(&app, &source);
    let _ = std::fs::remove_file(&source);
    result
}

#[tauri::command]
fn set_pk3_mod_targets(app: tauri::AppHandle, filename: String, targets: Vec<String>) -> Result<(), String> {
    check_pk3_filename(&filename)?;
    for t in &targets {
        if t != PK3_ALL_TARGET && !PK3_CLIENT_IDS.contains(&t.as_str()) {
            return Err(format!("Unknown target: {t}"));
        }
    }

    let (_, game_root) = find_jk2_base_and_root(&app, None)?;
    let library_path = pk3_library_dir(&app)?.join(&filename);
    if !library_path.exists() {
        return Err(format!("{filename} is not in the mod library"));
    }

    let mut mods = load_pk3_mods(&game_root);
    let entry = mods
        .iter_mut()
        .find(|m| m.filename == filename)
        .ok_or_else(|| format!("{filename} is not tracked"))?;

    undeploy_pk3_from_targets(&app, &filename, &entry.targets)?;
    deploy_pk3_to_targets(&app, &library_path, &filename, &targets)?;
    entry.targets = targets;
    save_pk3_mods(&game_root, &mods)
}

#[tauri::command]
fn remove_pk3_mod(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    check_pk3_filename(&filename)?;
    let (_, game_root) = find_jk2_base_and_root(&app, None)?;
    let mut mods = load_pk3_mods(&game_root);
    if let Some(entry) = mods.iter().find(|m| m.filename == filename) {
        undeploy_pk3_from_targets(&app, &filename, &entry.targets)?;
    }
    mods.retain(|m| m.filename != filename);
    save_pk3_mods(&game_root, &mods)?;

    let library_path = pk3_library_dir(&app)?.join(&filename);
    if library_path.exists() {
        std::fs::remove_file(&library_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Config presets: a client's settings, named, applied to any client ----
// Each client keeps its own config, so binds and settings drift apart. A
// preset is one config's worth of binds and settings - saved from a client
// or imported from a .cfg - and each client can have one preset applied.
// Launching a client from here writes its preset as launcher_shared.cfg
// into the folders it reads and adds `+exec launcher_shared.cfg`: the
// engine runs that after the client's own config, so the preset wins, and
// the client then saves those values itself. The clients' own config files
// are never edited.

const SHARED_CFG_NAME: &str = "launcher_shared.cfg";

// Settings that mustn't travel between clients: where files are, server
// and network setup, memory sizes, and a client's own identity (NWH's
// anti-cheat id, for one).
const PRESET_SKIP_PREFIXES: [&str; 12] = [
    "fs_", "sv_", "net_", "g_", "rcon", "password", "dedicated", "com_hunkmegs", "com_zonemegs", "com_soundmegs",
    "logfile", "nwh_",
];

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ConfigPreset {
    id: String,
    name: String,
    // "Saved from Tommyternal", "Imported from tourney.cfg" - for the list.
    origin: String,
    // The client it was saved from, if any - what Update re-reads.
    #[serde(default)]
    source_client: Option<String>,
    created: u64,
    updated: u64,
    #[serde(default)]
    controls_only: bool,
    lines: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct ConfigPresetStore {
    #[serde(default)]
    presets: Vec<ConfigPreset>,
    // client id -> preset id
    #[serde(default)]
    assignments: std::collections::HashMap<String, String>,
}

fn preset_store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("config_presets.json"))
}

fn load_presets(app: &tauri::AppHandle) -> ConfigPresetStore {
    preset_store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_presets(app: &tauri::AppHandle, store: &ConfigPresetStore) -> Result<(), String> {
    let path = preset_store_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string_pretty(store).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn new_preset_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis:x}")
}

// The config each client writes and the game dir it writes it into, plus
// the "global" config JK2MV-family clients keep in base/ for settings that
// apply whatever mod is active - that's where sensitivity, video and audio
// live for them; the main config holds the binds. OpenJO has no global one.
fn client_cfg_spec(client_id: &str) -> Option<(&'static str, &'static str, Option<&'static str>)> {
    Some(match client_id {
        TOMMYTERNAL_MOD_ID => ("eternaljk2", "eternaljk2mv.cfg", Some("eternaljk2mvglobal.cfg")),
        NWH_MOD_ID => ("nwh", "nwh.cfg", Some("nwhglobal.cfg")),
        JK2MV_MOD_ID => ("base", "jk2mvconfig.cfg", Some("jk2mvglobal.cfg")),
        OPENJO_MOD_ID => ("base", "openjo_sp.cfg", None),
        _ => return None,
    })
}

// Every folder a client might read or write configs under: its game folder
// and its own home folder(s), where an installed (non-portable) build
// keeps its data instead.
fn client_cfg_roots(app: &tauri::AppHandle, client_id: &str) -> Vec<std::path::PathBuf> {
    let mut roots = client_home_dirs(app, client_id);
    if let Ok((_, game_root)) = find_jk2_base_and_root(app, Some(client_id)) {
        roots.push(game_root);
    }
    roots
}

fn newest_file(candidates: impl Iterator<Item = std::path::PathBuf>) -> Option<std::path::PathBuf> {
    candidates
        .filter(|p| p.is_file())
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

// The client's current config - the newest copy wherever it writes one.
// With PK3 mods active a client runs in its launchermods_ folder and writes
// its config there instead, so that's checked too.
fn find_client_cfg(app: &tauri::AppHandle, client_id: &str) -> Option<std::path::PathBuf> {
    let (subdir, filename, _) = client_cfg_spec(client_id)?;
    newest_file(
        client_cfg_roots(app, client_id)
            .into_iter()
            .flat_map(|root| [root.join(subdir).join(filename), root.join(client_mod_folder_name(client_id)).join(filename)]),
    )
}

fn find_client_global_cfg(app: &tauri::AppHandle, client_id: &str) -> Option<std::path::PathBuf> {
    let (_, _, global) = client_cfg_spec(client_id)?;
    let global = global?;
    newest_file(client_cfg_roots(app, client_id).into_iter().map(|root| root.join("base").join(global)))
}

// Both of a client's configs as one text, global first so the main config
// wins where they overlap.
fn read_client_cfgs(app: &tauri::AppHandle, client_id: &str) -> Result<String, String> {
    let main = find_client_cfg(app, client_id)
        .ok_or_else(|| "That client hasn't saved a config yet - run it once first".to_string())?;
    let mut text = String::new();
    if let Some(global) = find_client_global_cfg(app, client_id) {
        text.push_str(&std::fs::read_to_string(global).map_err(|e| e.to_string())?);
        text.push('\n');
    }
    text.push_str(&std::fs::read_to_string(main).map_err(|e| e.to_string())?);
    Ok(text)
}

// Where launcher_shared.cfg goes so `exec` finds it: base/ under each of the
// client's roots - the engine looks in base/ of its home and game folders
// whatever game dir is active. NWH.app on macOS reads no loose files from
// the game folder at all, only its NWHClient folder, so that one is always
// included for it.
fn shared_cfg_dirs(app: &tauri::AppHandle, client_id: &str) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = client_cfg_roots(app, client_id).into_iter().map(|r| r.join("base")).collect();
    if client_id == NWH_MOD_ID && cfg!(target_os = "macos") {
        dirs.extend(nwh_mod_dir(app));
    }
    // A case-insensitive disk reaches one folder by two spellings
    // (OpenJO/ and openjo/, seen for real) - canonicalize what exists so it
    // isn't written twice or counted twice.
    let mut dirs: Vec<std::path::PathBuf> = dirs.into_iter().map(|d| d.canonicalize().unwrap_or(d)).collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

// What a cfg line is for a preset: a bind, a setting, or neither.
enum CfgLineKind {
    Bind,
    Setting,
}

fn classify_cfg_line(line: &str) -> Option<(CfgLineKind, String)> {
    let mut words = line.split_whitespace();
    let first = words.next()?.to_ascii_lowercase();
    if first == "unbindall" {
        return Some((CfgLineKind::Bind, "unbindall".to_string()));
    }
    let name = words.next()?.to_ascii_lowercase();
    match first.as_str() {
        "bind" => Some((CfgLineKind::Bind, format!("bind {name}"))),
        "seta" | "set" => {
            if PRESET_SKIP_PREFIXES.iter().any(|p| name.starts_with(p)) {
                None
            } else {
                Some((CfgLineKind::Setting, name))
            }
        }
        _ => None,
    }
}

// Keeps only the lines a preset carries, a later line replacing an earlier
// one for the same key (the main config after the global one), binds
// first so `unbindall` runs before anything else.
fn preset_lines_from_text(text: &str) -> Vec<String> {
    let mut binds: Vec<(String, String)> = Vec::new();
    let mut settings: Vec<(String, String)> = Vec::new();
    for raw in text.lines() {
        let Some((kind, key)) = classify_cfg_line(raw) else { continue };
        let list = match kind {
            CfgLineKind::Bind => &mut binds,
            CfgLineKind::Setting => &mut settings,
        };
        let line = raw.trim().to_string();
        match list.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = line,
            None => list.push((key, line)),
        }
    }
    binds.sort_by_key(|(k, _)| k != "unbindall");
    binds.into_iter().chain(settings).map(|(_, line)| line).collect()
}

fn preset_counts(preset: &ConfigPreset) -> (usize, usize) {
    let binds = preset.lines.iter().filter(|l| l.to_ascii_lowercase().starts_with("bind ")).count();
    let settings = preset.lines.iter().filter(|l| matches!(classify_cfg_line(l), Some((CfgLineKind::Setting, _)))).count();
    (binds, settings)
}

fn preset_applied_lines(preset: &ConfigPreset) -> Vec<&String> {
    preset
        .lines
        .iter()
        .filter(|l| !preset.controls_only || matches!(classify_cfg_line(l), Some((CfgLineKind::Bind, _))))
        .collect()
}

fn preset_cfg_text(preset: &ConfigPreset) -> String {
    let mut text = format!(
        "// \"{}\" - written by JK2 Launcher (Config). Edit the preset there; this file is rewritten at every launch.\n",
        preset.name.replace('\n', " ")
    );
    for line in preset_applied_lines(preset) {
        text.push_str(line);
        text.push('\n');
    }
    text
}

fn assigned_preset<'a>(store: &'a ConfigPresetStore, client_id: &str) -> Option<&'a ConfigPreset> {
    let id = store.assignments.get(client_id)?;
    store.presets.iter().find(|p| &p.id == id)
}

// Writes (or, with no preset applied, removes) the client's copies.
// Returns how many were written.
fn write_shared_cfg(app: &tauri::AppHandle, store: &ConfigPresetStore, client_id: &str) -> Result<usize, String> {
    let dirs = shared_cfg_dirs(app, client_id);
    let Some(preset) = assigned_preset(store, client_id).filter(|p| !preset_applied_lines(p).is_empty()) else {
        for dir in &dirs {
            let _ = std::fs::remove_file(dir.join(SHARED_CFG_NAME));
        }
        return Ok(0);
    };
    let text = preset_cfg_text(preset);
    let mut written = 0;
    for dir in &dirs {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(SHARED_CFG_NAME), &text).map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}

// What a client's launch gets on top of its usual arguments. Rewrites the
// file first, so a launch always runs the preset as it is now.
fn shared_settings_args(app: &tauri::AppHandle, client_id: &str) -> Vec<String> {
    let store = load_presets(app);
    match write_shared_cfg(app, &store, client_id) {
        Ok(n) if n > 0 => vec!["+exec".to_string(), SHARED_CFG_NAME.to_string()],
        _ => Vec::new(),
    }
}

#[derive(serde::Serialize)]
struct ConfigPresetView {
    id: String,
    name: String,
    origin: String,
    source_client: Option<String>,
    updated: u64,
    controls_only: bool,
    binds: usize,
    settings: usize,
    applied_to: Vec<String>,
}

#[derive(serde::Serialize)]
struct ConfigClientView {
    id: &'static str,
    // Whether "Save from" this client is possible yet.
    has_cfg: bool,
}

#[derive(serde::Serialize)]
struct ConfigView {
    presets: Vec<ConfigPresetView>,
    clients: Vec<ConfigClientView>,
}

fn config_view(app: &tauri::AppHandle, store: &ConfigPresetStore) -> ConfigView {
    let presets = store
        .presets
        .iter()
        .map(|p| {
            let (binds, settings) = preset_counts(p);
            let mut applied_to: Vec<String> = store.assignments.iter().filter(|(_, pid)| *pid == &p.id).map(|(c, _)| c.clone()).collect();
            applied_to.sort();
            ConfigPresetView {
                id: p.id.clone(),
                name: p.name.clone(),
                origin: p.origin.clone(),
                source_client: p.source_client.clone(),
                updated: p.updated,
                controls_only: p.controls_only,
                binds,
                settings,
                applied_to,
            }
        })
        .collect();
    let clients = PK3_CLIENT_IDS.iter().map(|id| ConfigClientView { id, has_cfg: find_client_cfg(app, id).is_some() }).collect();
    ConfigView { presets, clients }
}

fn find_preset_mut<'a>(store: &'a mut ConfigPresetStore, id: &str) -> Result<&'a mut ConfigPreset, String> {
    store.presets.iter_mut().find(|p| p.id == id).ok_or_else(|| "That preset no longer exists".to_string())
}

// "Preset 1", "Preset 2", ... - the lowest number not already taken.
fn next_preset_name(store: &ConfigPresetStore) -> String {
    (1..)
        .map(|n| format!("Preset {n}"))
        .find(|candidate| !store.presets.iter().any(|p| p.name.eq_ignore_ascii_case(candidate)))
        .unwrap()
}

fn clean_preset_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the preset a name".to_string());
    }
    Ok(name.chars().take(60).collect())
}

#[tauri::command]
fn list_config_presets(app: tauri::AppHandle) -> ConfigView {
    config_view(&app, &load_presets(&app))
}

#[tauri::command]
fn save_preset_from_client(app: tauri::AppHandle, client_id: String, name: String) -> Result<ConfigView, String> {
    if !PK3_CLIENT_IDS.contains(&client_id.as_str()) {
        return Err(format!("Unknown client: {client_id}"));
    }
    let lines = preset_lines_from_text(&read_client_cfgs(&app, &client_id)?);
    let now = now_secs();
    let mut store = load_presets(&app);
    store.presets.push(ConfigPreset {
        id: new_preset_id(),
        name: clean_preset_name(&name)?,
        origin: format!("Saved from {client_id}"),
        source_client: Some(client_id),
        created: now,
        updated: now,
        controls_only: false,
        lines,
    });
    save_presets(&app, &store)?;
    Ok(config_view(&app, &store))
}

// A file dialog, so it runs on a worker thread like the other pickers.
#[tauri::command]
async fn import_config_preset(app: tauri::AppHandle) -> Result<Option<ConfigView>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Config file", &["cfg"])
        .set_title("Choose a .cfg to import as a preset")
        .blocking_pick_file();
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines = preset_lines_from_text(&text);
    if lines.is_empty() {
        return Err("That file has no binds or settings in it".to_string());
    }
    let filename = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "config.cfg".to_string());
    let now = now_secs();
    let mut store = load_presets(&app);
    store.presets.push(ConfigPreset {
        id: new_preset_id(),
        name: next_preset_name(&store),
        origin: format!("Imported from {filename}"),
        source_client: None,
        created: now,
        updated: now,
        controls_only: false,
        lines,
    });
    save_presets(&app, &store)?;
    Ok(Some(config_view(&app, &store)))
}

#[tauri::command]
fn update_preset_from_client(app: tauri::AppHandle, id: String) -> Result<ConfigView, String> {
    let mut store = load_presets(&app);
    let preset = find_preset_mut(&mut store, &id)?;
    let client_id = preset.source_client.clone().ok_or_else(|| "This preset was imported from a file, not a client".to_string())?;
    preset.lines = preset_lines_from_text(&read_client_cfgs(&app, &client_id)?);
    preset.updated = now_secs();
    save_presets(&app, &store)?;
    Ok(config_view(&app, &store))
}

#[tauri::command]
fn rename_config_preset(app: tauri::AppHandle, id: String, name: String) -> Result<ConfigView, String> {
    let mut store = load_presets(&app);
    find_preset_mut(&mut store, &id)?.name = clean_preset_name(&name)?;
    save_presets(&app, &store)?;
    Ok(config_view(&app, &store))
}

#[tauri::command]
fn set_preset_controls_only(app: tauri::AppHandle, id: String, controls_only: bool) -> Result<ConfigView, String> {
    let mut store = load_presets(&app);
    find_preset_mut(&mut store, &id)?.controls_only = controls_only;
    save_presets(&app, &store)?;
    Ok(config_view(&app, &store))
}

#[tauri::command]
fn get_preset_text(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let mut store = load_presets(&app);
    Ok(find_preset_mut(&mut store, &id)?.lines.join("\n"))
}

// Edited text goes through the same filter as a saved or imported config,
// so a stray fs_game line can't be typed in either.
#[tauri::command]
fn set_preset_text(app: tauri::AppHandle, id: String, text: String) -> Result<ConfigView, String> {
    let lines = preset_lines_from_text(&text);
    if lines.is_empty() {
        return Err("A preset needs at least one bind or setting".to_string());
    }
    let mut store = load_presets(&app);
    let preset = find_preset_mut(&mut store, &id)?;
    preset.lines = lines;
    preset.updated = now_secs();
    save_presets(&app, &store)?;
    Ok(config_view(&app, &store))
}

#[tauri::command]
fn delete_config_preset(app: tauri::AppHandle, id: String) -> Result<ConfigView, String> {
    let mut store = load_presets(&app);
    store.presets.retain(|p| p.id != id);
    store.assignments.retain(|_, pid| *pid != id);
    save_presets(&app, &store)?;
    // Clients that used it lose their launcher_shared.cfg straight away.
    for client in PK3_CLIENT_IDS {
        let _ = write_shared_cfg(&app, &store, client);
    }
    Ok(config_view(&app, &store))
}

// Sets exactly which clients use this preset. A client uses one preset at
// a time, so naming it here takes it off whichever preset had it.
#[tauri::command]
fn assign_config_preset(app: tauri::AppHandle, id: String, clients: Vec<String>) -> Result<ConfigView, String> {
    if let Some(bad) = clients.iter().find(|c| !PK3_CLIENT_IDS.contains(&c.as_str())) {
        return Err(format!("Unknown client: {bad}"));
    }
    let mut store = load_presets(&app);
    find_preset_mut(&mut store, &id)?;
    store.assignments.retain(|_, pid| *pid != id);
    for client in &clients {
        store.assignments.insert(client.clone(), id.clone());
    }
    save_presets(&app, &store)?;
    for client in PK3_CLIENT_IDS {
        let _ = write_shared_cfg(&app, &store, client);
    }
    Ok(config_view(&app, &store))
}

// --- Media: screenshots and demos -------------------------------------------
// A client doesn't save these in one predictable place. It writes into
// whichever game dir is active (base/, or its launchermods_ folder once it
// has PK3s, or its own built-in mod folder), and an "installed" (non-
// portable) build writes under its fs_homepath instead of the game folder at
// all - JK2MV's own source puts that at ~/Library/Application Support/jk2mv
// on macOS, ~/.jk2mv on Linux and Documents\jk2mv on Windows. So rather than
// predict where the next one will land, every folder one *could* be in gets
// looked at.

#[derive(Clone, Copy, PartialEq)]
enum MediaKind {
    Screenshot,
    Demo,
}

impl MediaKind {
    fn subdir(self) -> &'static str {
        match self {
            MediaKind::Screenshot => "screenshots",
            MediaKind::Demo => "demos",
        }
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            MediaKind::Screenshot => &["jpg", "jpeg", "png", "tga"],
            // dm_15 = 1.02, dm_16 = 1.04 - the only two protocols JK2 has.
            MediaKind::Demo => &["dm_15", "dm_16"],
        }
    }

    fn matches(self, path: &std::path::Path) -> bool {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| self.extensions().contains(&e.to_ascii_lowercase().as_str()))
    }
}

// Where a client keeps its fs_homepath. Only folders that exist are
// returned, so guessing generously here costs nothing - OpenJO's macOS one
// is confirmed first-hand, JK2MV's from its source, the rest follow the same
// conventions.
fn client_home_dirs(app: &tauri::AppHandle, client_id: &str) -> Vec<std::path::PathBuf> {
    let names: &[&str] = match client_id {
        JK2MV_MOD_ID => &["jk2mv"],
        TOMMYTERNAL_MOD_ID => &["eternaljk2mv"],
        OPENJO_MOD_ID => &["OpenJO", "openjo"],
        NWH_MOD_ID => &["NWHClient"],
        _ => &[],
    };
    let paths = app.path();
    let data = paths.data_dir().ok();
    let docs = paths.document_dir().ok();
    let home = paths.home_dir().ok();
    let mut dirs = Vec::new();
    for name in names {
        dirs.extend(data.as_ref().map(|d| d.join(name)));
        dirs.extend(home.as_ref().map(|h| h.join(format!(".{name}"))));
        dirs.extend(docs.as_ref().map(|d| d.join(name)));
        dirs.extend(docs.as_ref().map(|d| d.join("My Games").join(name)));
    }
    dirs.retain(|d| d.is_dir());
    dirs
}

// Game dirs inside a shared game folder that belong to one client only - a
// screenshot in launchermods_jk2mv/ is JK2MV's, never OpenJO's, even though
// both clients point at the same game folder.
fn game_dir_owner(dir_name: &str) -> Option<&'static str> {
    PK3_CLIENT_IDS
        .iter()
        .find(|id| client_mod_folder_name(id) == dir_name)
        .copied()
        .or(match dir_name {
            "eternaljk2" => Some(TOMMYTERNAL_MOD_ID),
            "nwh" => Some(NWH_MOD_ID),
            _ => None,
        })
}

fn subdirs(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

// Every existing screenshots/ or demos/ folder, paired with the clients that
// could have written into it. More than one client per folder is normal:
// base/ in a game folder several clients share belongs to all of them.
fn media_dirs(app: &tauri::AppHandle, kind: MediaKind) -> Vec<(std::path::PathBuf, Vec<String>)> {
    let mut found: Vec<(std::path::PathBuf, Vec<String>)> = Vec::new();
    let mut add = |dir: std::path::PathBuf, client: &str| {
        // Canonicalizing both skips folders that don't exist and folds
        // together two routes to the same place (case-insensitive
        // filesystems, symlinked Steam libraries).
        let Ok(dir) = dir.canonicalize() else { return };
        match found.iter_mut().find(|(d, _)| *d == dir) {
            Some((_, clients)) if !clients.iter().any(|c| c == client) => clients.push(client.to_string()),
            Some(_) => {}
            None => found.push((dir, vec![client.to_string()])),
        }
    };
    for client in PK3_CLIENT_IDS {
        // OpenJO is single-player, which has no demo recording.
        if kind == MediaKind::Demo && client == OPENJO_MOD_ID {
            continue;
        }
        for home in client_home_dirs(app, client) {
            for game_dir in subdirs(&home) {
                add(game_dir.join(kind.subdir()), client);
            }
        }
        // NWH.app on macOS never reads or writes the game folder's own dirs -
        // only NWHClient (scanned above) - so a demo in base/ there isn't one
        // it could play.
        if cfg!(target_os = "macos") && client == NWH_MOD_ID {
            continue;
        }
        if let Ok((_, game_root)) = find_jk2_base_and_root(app, Some(client)) {
            // A shared dir like base/ only counts for clients actually in
            // this folder. A client's own dir counts whether or not it's
            // still installed - uninstalling leaves player data behind.
            let installed_here = client_binary_name(client).is_some_and(|b| game_root.join(b).exists());
            for game_dir in subdirs(&game_root) {
                let owner = game_dir.file_name().and_then(|n| n.to_str()).and_then(game_dir_owner);
                let counts = match owner {
                    Some(owner) => owner == client,
                    None => installed_here,
                };
                if counts {
                    add(game_dir.join(kind.subdir()), client);
                }
            }
        }
    }
    found
}

#[derive(serde::Serialize)]
struct MediaItem {
    path: String,
    name: String,
    kind: &'static str,
    clients: Vec<String>,
    size: u64,
    modified: u64,
    width: Option<u32>,
    height: Option<u32>,
}

fn list_media_blocking(app: &tauri::AppHandle) -> Vec<MediaItem> {
    let mut items = Vec::new();
    for kind in [MediaKind::Screenshot, MediaKind::Demo] {
        for (dir, clients) in media_dirs(app, kind) {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for path in entries.filter_map(|e| e.ok()).map(|e| e.path()) {
                if !kind.matches(&path) {
                    continue;
                }
                let Ok(meta) = path.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                // Reads the header only, not the whole image.
                let dims = (kind == MediaKind::Screenshot)
                    .then(|| image::image_dimensions(&path).ok())
                    .flatten();
                items.push(MediaItem {
                    name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    kind: if kind == MediaKind::Screenshot { "screenshot" } else { "demo" },
                    clients: clients.clone(),
                    size: meta.len(),
                    modified,
                    width: dims.map(|d| d.0),
                    height: dims.map(|d| d.1),
                });
            }
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.modified));
    items
}

#[tauri::command]
async fn list_media(app: tauri::AppHandle) -> Result<Vec<MediaItem>, String> {
    tauri::async_runtime::spawn_blocking(move || list_media_blocking(&app))
        .await
        .map_err(|e| e.to_string())
}

// Every path arrives back from the frontend, so none is trusted: it has to
// be a screenshot or demo sitting directly in one of the folders list_media
// scans, or nothing here will open, move or delete it.
fn resolve_media_file(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<(std::path::PathBuf, MediaKind, Vec<String>), String> {
    let file = std::path::Path::new(path)
        .canonicalize()
        .map_err(|_| format!("{path} no longer exists"))?;
    let parent = file.parent().map(|p| p.to_path_buf());
    for kind in [MediaKind::Screenshot, MediaKind::Demo] {
        if !kind.matches(&file) {
            continue;
        }
        if let Some((_, clients)) = media_dirs(app, kind).into_iter().find(|(d, _)| Some(d) == parent.as_ref()) {
            return Ok((file, kind, clients));
        }
    }
    Err(format!("{path} isn't a screenshot or demo the launcher manages"))
}

// Keyed on size and modified time as well as path, so a screenshot that's
// overwritten in place (shot0001 again after a reinstall) gets a fresh
// thumbnail rather than the old one.
fn thumbnail_cache_path(app: &tauri::AppHandle, file: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    file.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    meta.modified().ok().hash(&mut hasher);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("media_thumbs");
    Ok(dir.join(format!("{:016x}.jpg", hasher.finish())))
}

fn media_thumbnail_blocking(app: &tauri::AppHandle, path: &str) -> Result<Vec<u8>, String> {
    let (file, kind, _) = resolve_media_file(app, path)?;
    if kind != MediaKind::Screenshot {
        return Err("Only screenshots have thumbnails".to_string());
    }
    let cached = thumbnail_cache_path(app, &file)?;
    if let Ok(bytes) = std::fs::read(&cached) {
        return Ok(bytes);
    }
    let thumb = image::open(&file).map_err(|e| e.to_string())?.thumbnail(480, 300).to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode_image(&thumb)
        .map_err(|e| e.to_string())?;
    if let Some(dir) = cached.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&cached, &bytes);
    Ok(bytes)
}

#[tauri::command]
async fn media_thumbnail(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || media_thumbnail_blocking(&app, &path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

// Full-size image for the viewer. JPEG and PNG go across untouched; TGA is
// re-encoded as PNG, since no webview can display one.
fn media_image_blocking(app: &tauri::AppHandle, path: &str) -> Result<Vec<u8>, String> {
    let (file, kind, _) = resolve_media_file(app, path)?;
    if kind != MediaKind::Screenshot {
        return Err("Only screenshots can be viewed".to_string());
    }
    let is_tga = file.extension().is_some_and(|e| e.eq_ignore_ascii_case("tga"));
    if !is_tga {
        return std::fs::read(&file).map_err(|e| e.to_string());
    }
    let img = image::open(&file).map_err(|e| e.to_string())?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    img.write_to(&mut bytes, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(bytes.into_inner())
}

#[tauri::command]
async fn media_image(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || media_image_blocking(&app, &path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn reveal_media(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let (file, _, _) = resolve_media_file(&app, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(file).map_err(|e| e.to_string())
}

// To the system Trash/Recycle Bin, never deleted outright - a demo of a
// match that can't be replayed is gone for good otherwise.
#[tauri::command]
fn trash_media(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let (file, _, _) = resolve_media_file(&app, &path)?;
    if let Ok(cached) = thumbnail_cache_path(&app, &file) {
        let _ = std::fs::remove_file(cached);
    }
    trash::delete(&file).map_err(|e| e.to_string())
}

// Keeps the extension (the protocol is in it) and allows no spaces: the
// client's `demo` command takes its argument as one console token.
#[tauri::command]
fn rename_demo(app: tauri::AppHandle, path: String, new_name: String) -> Result<String, String> {
    let (file, kind, _) = resolve_media_file(&app, &path)?;
    if kind != MediaKind::Demo {
        return Err("Only demos can be renamed".to_string());
    }
    let new_name = new_name.trim();
    if new_name.is_empty()
        || !new_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("Use letters, numbers, dashes, underscores or dots only - no spaces".to_string());
    }
    let ext = file.extension().unwrap_or_default().to_string_lossy().to_string();
    let target = file.with_file_name(format!("{new_name}.{ext}"));
    if target.exists() {
        return Err(format!("{new_name}.{ext} already exists"));
    }
    std::fs::rename(&file, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

// A file dialog for screenshots and demos to bring in - on a worker thread,
// like the other pickers. The choice of client comes after, from the page.
#[tauri::command]
async fn pick_media_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Screenshots and demos", &["jpg", "jpeg", "png", "tga", "dm_15", "dm_16"])
        .set_title("Choose screenshots or demos to add")
        .blocking_pick_files();
    let Some(files) = picked else { return Ok(Vec::new()) };
    files
        .into_iter()
        .map(|f| f.into_path().map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string()))
        .collect()
}

// Where added media for a client goes: that client's own game dir (the one
// its PK3 mods live in), so it shows under that client alone and the
// client finds it when the dir is active. "all" means base/ of the default
// game folder, which every client there reads.
fn media_import_dir(app: &tauri::AppHandle, client: &str, kind: MediaKind) -> Result<std::path::PathBuf, String> {
    let dir = if client == PK3_ALL_TARGET {
        find_jk2_base_and_root(app, None)?.0
    } else if PK3_CLIENT_IDS.contains(&client) {
        client_pk3_dir(app, client).ok_or_else(|| format!("No game folder for {client}"))?
    } else {
        return Err(format!("Unknown client: {client}"));
    };
    Ok(dir.join(kind.subdir()))
}

#[derive(serde::Serialize)]
struct MediaImportResult {
    added: usize,
    skipped: Vec<String>,
}

// Copies the picked files into place. A name already there is left alone
// and reported, rather than overwritten: a demo of a match that's gone is
// not something to lose to a stray click.
#[tauri::command]
fn import_media_files(app: tauri::AppHandle, client: String, paths: Vec<String>) -> Result<MediaImportResult, String> {
    let mut result = MediaImportResult { added: 0, skipped: Vec::new() };
    for path in &paths {
        let source = std::path::Path::new(path);
        let name = source
            .file_name()
            .ok_or_else(|| format!("{path} isn't a file"))?
            .to_string_lossy()
            .to_string();
        let Some(kind) = [MediaKind::Screenshot, MediaKind::Demo].into_iter().find(|k| k.matches(source)) else {
            result.skipped.push(format!("{name} (not a screenshot or demo)"));
            continue;
        };
        let dir = media_import_dir(&app, &client, kind)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&name);
        if dest.exists() {
            result.skipped.push(format!("{name} (already there)"));
            continue;
        }
        std::fs::copy(source, &dest).map_err(|e| format!("{name}: {e}"))?;
        result.added += 1;
    }
    Ok(result)
}

// Launches a client with extra console arguments. Goes by the binary's
// shape rather than a per-client special case: a macOS .app bundle has to go
// through `open --args` (which returns at once, so there's no start-up check
// to make), anything else runs straight from its game folder through
// spawn_client, with its start-up check and launch log.
fn launch_client(app: &tauri::AppHandle, game_root: &std::path::Path, mod_id: &str, args: &[String]) -> Result<String, String> {
    let binary_name = client_binary_name(mod_id).ok_or_else(|| format!("Unknown client: {mod_id}"))?;
    let binary = game_root.join(binary_name);
    if !binary.exists() {
        return Err(format!("{} isn't installed", binary.display()));
    }
    if binary_name.ends_with(".app") {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(&binary);
        if !args.is_empty() {
            cmd.arg("--args");
            cmd.args(args);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(format!("Launched {}", binary.display()));
    }
    let mut cmd = std::process::Command::new(&binary);
    cmd.current_dir(game_root);
    cmd.args(args);
    spawn_client(app, mod_id, cmd, &binary)
}

fn play_demo_blocking(app: tauri::AppHandle, client_id: String, path: String) -> Result<String, String> {
    let (file, kind, clients) = resolve_media_file(&app, &path)?;
    if kind != MediaKind::Demo {
        return Err("Not a demo".to_string());
    }
    // OpenJO is single-player and has no demo playback.
    if client_id == OPENJO_MOD_ID || !clients.contains(&client_id) {
        return Err(format!("{client_id} can't play this demo"));
    }
    let (_, game_root) = find_jk2_base_and_root(&app, Some(&client_id))?;

    // The client looks for demos/<name> inside its active game dir (plus
    // base/, which every game dir layers on top of). A demo in base/ plays
    // with the usual launch, PK3 mods and all; one anywhere else needs that
    // folder made the active game dir or the client won't find it.
    let game_dir = file
        .parent()
        .and_then(|d| d.parent())
        .and_then(|d| d.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut args: Vec<String> = Vec::new();
    if client_id == NWH_MOD_ID {
        // NWH is never switched off its own nwh/ folder (see play_nwh) - and
        // between that and base/, it already sees everywhere it records demos.
        args.extend(nwh_launch_args(&game_root));
    } else if game_dir != "base" {
        args.extend(["+set".to_string(), "fs_game".to_string(), game_dir]);
    } else if client_has_pk3_mods(&game_root, &client_id) {
        args.extend(["+set".to_string(), "fs_game".to_string(), client_mod_folder_name(&client_id)]);
    }
    args.extend(shared_settings_args(&app, &client_id));
    // The name becomes part of a console command line. The client splits
    // those on ';' and reads '"' as quoting, so a file named with either
    // (one renamed outside the launcher - rename_demo refuses both) could
    // smuggle commands in after the +demo. Not worth any workaround.
    let name = file.file_name().unwrap_or_default().to_string_lossy().to_string();
    if name.contains([';', '"']) {
        return Err(format!("{name} can't be played by name - rename it without ; or \" first"));
    }
    // A name with spaces is fine as one argv: the engine wraps any argument
    // containing spaces in quotes itself when it builds its command line.
    args.push("+demo".to_string());
    args.push(name);
    launch_client(&app, &game_root, &client_id, &args)
}

#[tauri::command]
async fn play_demo(app: tauri::AppHandle, client_id: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || play_demo_blocking(app, client_id, path))
        .await
        .map_err(|e| e.to_string())?
}

// --- Server browser: direct-connect + live status via the idTech3
// out-of-band UDP protocol (the same "getstatus" query every Q3-engine
// server browser uses - no server-side cooperation beyond the engine
// itself needed).

#[derive(serde::Serialize)]
struct ServerPlayer {
    name: String,
    score: i32,
    ping: i32,
}

#[derive(serde::Serialize)]
struct ServerStatus {
    address: String,
    hostname: String,
    map: String,
    max_clients: i32,
    players: Vec<ServerPlayer>,
    ping_ms: u64,
}

// The actual blocking work (UDP send/recv with a multi-second timeout) -
// kept separate from the #[tauri::command] wrapper below so it's not
// piling an extra layer of async/spawn_blocking on top of what the
// wrapper already provides.
fn query_server_status_blocking(address: String) -> Result<ServerStatus, String> {
    use std::net::UdpSocket;
    use std::time::{Duration, Instant};

    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;

    // Out-of-band packets are prefixed with four 0xFF bytes.
    let mut packet: Vec<u8> = vec![0xFF, 0xFF, 0xFF, 0xFF];
    packet.extend_from_slice(b"getstatus");

    let start = Instant::now();
    socket
        .send_to(&packet, &address)
        .map_err(|e| format!("Couldn't reach {}: {}", address, e))?;

    let mut buf = [0u8; 8192];
    let (len, _) = socket
        .recv_from(&mut buf)
        .map_err(|e| format!("No response from {}: {}", address, e))?;
    let ping_ms = start.elapsed().as_millis() as u64;

    // Response: <ff ff ff ff>statusResponse\n\key\value\key\value...\n
    // followed by one "score ping "name"" line per connected player.
    let text = String::from_utf8_lossy(&buf[..len]);
    let mut sections = text.splitn(2, '\n');
    sections.next(); // "\xff\xff\xff\xffstatusResponse" header line
    let rest = sections.next().unwrap_or("");
    let mut rest_lines = rest.split('\n');

    let mut info = std::collections::HashMap::new();
    if let Some(info_line) = rest_lines.next() {
        let parts: Vec<&str> = info_line.split('\\').collect();
        let mut i = 1; // parts[0] is empty - the line starts with a backslash
        while i + 1 < parts.len() {
            info.insert(parts[i].to_string(), parts[i + 1].to_string());
            i += 2;
        }
    }

    let mut players = Vec::new();
    for line in rest_lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(quote) = line.find('"') {
            let (head, name_part) = line.split_at(quote);
            let mut head_fields = head.split_whitespace();
            let score = head_fields.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let ping = head_fields.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            players.push(ServerPlayer {
                name: name_part.trim_matches('"').to_string(),
                score,
                ping,
            });
        }
    }

    Ok(ServerStatus {
        hostname: info.get("sv_hostname").cloned().unwrap_or_else(|| address.clone()),
        map: info.get("mapname").cloned().unwrap_or_default(),
        max_clients: info.get("sv_maxclients").and_then(|s| s.parse().ok()).unwrap_or(0),
        players,
        ping_ms,
        address,
    })
}

// Runs the actual query on Tauri's blocking thread pool rather than
// whatever thread dispatches the command - a single query only blocks for
// up to a few seconds, but there's no reason to risk it landing on
// something IPC/UI-adjacent.
#[tauri::command]
async fn query_server_status(address: String) -> Result<ServerStatus, String> {
    tauri::async_runtime::spawn_blocking(move || query_server_status_blocking(address))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The blank-white-window bug on Linux (window opens, never paints a
    // pixel, "Could not create default EGL display: EGL_BAD_PARAMETER" on
    // stderr) turned out to be the AppImage bundling Ubuntu 22.04's own
    // libwayland-*, which shadowed the host's newer ones and broke Mesa's
    // EGL setup. It's fixed where it actually lives - the release workflow
    // strips those libs so the host's are used (see patch-appimage in
    // .github/workflows/release.yml).
    //
    // Five env-var workarounds were tried here first and every one of them
    // was dead on arrival: WebKitGTK initialises EGL before it reads any of
    // them. They're deliberately gone rather than left in "just in case" -
    // LIBGL_ALWAYS_SOFTWARE in particular forced every pixel through the
    // CPU, which is real, measurable lag on a Steam Deck, and GDK_BACKEND=x11
    // gave up native Wayland for XWayland. Nothing to trade for a fix they
    // never provided.

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            current_platform,
            extract_nwh,
            extract_tommyternal,
            extract_openjo,
            extract_jk2mv,
            locate_jk2,
            locate_jk2_base,
            get_game_folder_override,
            pick_game_folder,
            get_client_folder,
            pick_client_folder,
            clear_client_folder,
            set_client_folder,
            detect_client_folder,
            preview_install_nwh,
            install_nwh,
            is_nwh_installed,
            play_nwh,
            uninstall_nwh,
            preview_install_tommyternal,
            install_tommyternal,
            is_tommyternal_installed,
            play_tommyternal,
            uninstall_tommyternal,
            preview_install_openjo,
            install_openjo,
            is_openjo_installed,
            play_openjo,
            uninstall_openjo,
            preview_install_jk2mv,
            install_jk2mv,
            is_jk2mv_installed,
            play_jk2mv,
            uninstall_jk2mv,
            list_pk3_mods,
            pick_pk3_files,
            add_pk3_mod,
            add_pk3_mod_from_download,
            set_pk3_mod_targets,
            remove_pk3_mod,
            list_media,
            media_thumbnail,
            media_image,
            reveal_media,
            trash_media,
            rename_demo,
            play_demo,
            pick_media_files,
            import_media_files,
            list_config_presets,
            save_preset_from_client,
            import_config_preset,
            update_preset_from_client,
            rename_config_preset,
            set_preset_controls_only,
            get_preset_text,
            set_preset_text,
            delete_config_preset,
            assign_config_preset,
            query_server_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

