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

// OpenJO's bundled "libSDL2-2.0.0.dylib" is actually sdl2-compat (SDL2's API
// re-implemented on top of SDL3), confirmed by strings in the binary itself
// ("Failed to initialize sdl2-compat library"). It dlopens a real SDL3 at
// runtime from a fixed set of relative paths - none of which are where
// Homebrew installs it - so the bundle needs its own copy placed at
// @loader_path/libSDL3.dylib (sdl2-compat's own directory, Contents/Frameworks)
// for it to find. Homebrew is the natural source since asking the user to
// `brew install` a missing system dependency is already how Tommyternal's own
// SDL2 gap was handled.
// Vendored directly rather than reached into Homebrew: OpenJO's bundled
// sdl2-compat needs a real SDL3 to forward to, and requiring every user to
// `brew install sdl3` before Install even worked was real, needless friction
// for a general download. This is the official upstream macOS universal
// binary (SDL3-3.4.16.dmg from github.com/libsdl-org/SDL, the same version
// Homebrew's own formula builds from) - see resources/libSDL3-LICENSE.txt
// (zlib, redistribution is fine).
const BUNDLED_SDL3: &[u8] = include_bytes!("../resources/libSDL3.dylib");

#[tauri::command]
fn extract_nwh(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let archive_path = app_data.join("nwh_linux_x64.tar.gz");
    let dest = app_data.join("extracted").join("nwh");

    let file = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    archive.unpack(&dest).map_err(|e| e.to_string())?;

    Ok(format!("Extracted to {}", dest.display()))
}

#[tauri::command]
fn extract_tommyternal(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let zip_path = app_data.join("tommyternal_macos_arm64.zip");
    let dest = app_data.join("extracted").join("tommyternal");

    let zip_file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut zip_archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;
    let inner_targz = zip_archive.by_index(0).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(inner_targz);
    tar::Archive::new(gz).unpack(&dest).map_err(|e| e.to_string())?;

    Ok(format!("Extracted to {}", dest.display()))
}

#[tauri::command]
fn extract_openjo(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let archive_path = app_data.join("openjo_macos_arm64.tar.gz");
    let dest = app_data.join("extracted").join("openjo");

    let file = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    tar::Archive::new(gz).unpack(&dest).map_err(|e| e.to_string())?;

    let app_bundle = dest.join("openjo_sp.arm64.app");
    // Removing any stale copy first means an Update (re-extracting into the
    // same app_data path) never trips over a previous write's permissions;
    // the explicit chmod after is defensive so this stays ours to overwrite
    // next time regardless.
    let sdl3_dest = app_bundle.join("Contents/Frameworks/libSDL3.dylib");
    let _ = std::fs::remove_file(&sdl3_dest);
    std::fs::write(&sdl3_dest, BUNDLED_SDL3).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        let mut perms = std::fs::metadata(&sdl3_dest).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&sdl3_dest, perms).map_err(|e| e.to_string())?;
    }
    resign_app_bundle(&app_bundle)?;

    Ok(format!("Extracted to {}", dest.display()))
}

#[tauri::command]
fn extract_jk2mv(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dmg_path = app_data.join("jk2mv_macos_x86_64.dmg");
    let mount_point = app_data.join("dmg_mount_jk2mv");
    let dest = app_data.join("extracted").join("jk2mv");

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
    Ok(format!("Extracted to {}", dest.display()))
}

const JK2_STEAM_APP_ID: u32 = 6030;

fn folder_override_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data.join("game_folder_override.json"))
}

fn load_folder_override(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let path = folder_override_path(app).ok()?;
    let contents = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let dir = std::path::PathBuf::from(value.get("path")?.as_str()?);
    dir.is_dir().then_some(dir)
}

fn save_folder_override(app: &tauri::AppHandle, dir: &std::path::Path) -> Result<(), String> {
    let path = folder_override_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let value = serde_json::json!({ "path": dir.to_string_lossy() });
    std::fs::write(path, serde_json::to_string_pretty(&value).unwrap()).map_err(|e| e.to_string())
}

fn find_jk2_install(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(dir) = load_folder_override(app) {
        return Ok(dir);
    }
    let steam_dir = steamlocate::locate().map_err(|e| format!("Steam not found: {e}"))?;
    let (app_entry, library) = steam_dir
        .find_app(JK2_STEAM_APP_ID)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Jedi Knight II isn't installed via Steam, or wasn't found in any library.".to_string())?;
    Ok(library.resolve_app_dir(&app_entry))
}

#[tauri::command]
fn locate_jk2(app: tauri::AppHandle) -> Result<String, String> {
    let install_root = find_jk2_install(&app)?;
    Ok(format!("Found Jedi Knight II at {}", install_root.display()))
}

#[tauri::command]
fn get_game_folder_override(app: tauri::AppHandle) -> Option<String> {
    load_folder_override(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_game_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // Same crash as pick_pk3_files used to hit: blocking_pick_folder's own
    // docs say not to call it on the main thread - this command was missed
    // when that fix went in for the PK3 picker.
    let picked = app
        .dialog()
        .file()
        .set_title("Select your Jedi Knight II install folder")
        .blocking_pick_folder();

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let dir = file_path.into_path().map_err(|e| e.to_string())?;
    // Validate before accepting - refuse a folder that doesn't actually resolve
    // to a base/ dir, same shape Steam's own auto-detection guarantees.
    find_base_dir(&dir)?;
    save_folder_override(&app, &dir)?;
    Ok(Some(dir.to_string_lossy().to_string()))
}

fn find_base_dir(install_root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let direct = install_root.join("base");
    if direct.is_dir() {
        return Ok(direct);
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
    let install_root = find_jk2_install(&app)?;
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

fn installed_status(mod_id: &str, game_root: &std::path::Path) -> InstalledStatus {
    match load_installed_mods(game_root).get(mod_id) {
        Some(record) if !record.paths.is_empty() => InstalledStatus {
            installed: true,
            version: Some(record.version.clone()),
        },
        _ => InstalledStatus { installed: false, version: None },
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
    for rel_path in &record.paths {
        let path = game_root.join(rel_path);
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match result {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // already gone
            Err(_) => failed += 1,
        }
    }

    save_installed_mods(game_root, &installed_mods)?;
    if failed > 0 {
        Ok(format!(
            "Removed {removed} item(s); {failed} couldn't be deleted (may need manual cleanup)."
        ))
    } else {
        Ok(format!("Uninstalled ({removed} item(s) removed)."))
    }
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
        if !already_ours.contains(&rel) {
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
            check_ownership(&dest, game_root, already_ours)?;
            if path.is_dir() {
                actions.push(InstallAction::CopyModDir { src: path, dest });
            } else {
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

fn find_jk2_base_and_root(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let install_root = find_jk2_install(app)?;
    let base_dir = find_base_dir(&install_root)?;
    let game_root = base_dir
        .parent()
        .ok_or_else(|| "base folder has no parent directory".to_string())?
        .to_path_buf();
    Ok((base_dir, game_root))
}

fn resolve_tommyternal_install(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let payload_dir = find_single_subdir(&app_data.join("extracted").join("tommyternal"))?;
    let (base_dir, game_root) = find_jk2_base_and_root(app)?;
    Ok((payload_dir, base_dir, game_root))
}

#[tauri::command]
fn is_tommyternal_installed(app: tauri::AppHandle) -> Result<InstalledStatus, String> {
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    Ok(installed_status(TOMMYTERNAL_MOD_ID, &game_root))
}

#[tauri::command]
fn uninstall_tommyternal(app: tauri::AppHandle) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    uninstall_mod(TOMMYTERNAL_MOD_ID, &game_root)
}

#[tauri::command]
fn play_tommyternal(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    let binary = game_root.join("eternaljk2mvmp");
    let mut cmd = std::process::Command::new(&binary);
    cmd.current_dir(&game_root);
    if client_has_pk3_mods(&game_root, TOMMYTERNAL_MOD_ID) {
        cmd.args(["+set", "fs_game", &client_mod_folder_name(TOMMYTERNAL_MOD_ID)]);
    }
    if let Some(address) = &connect_address {
        cmd.args(["+connect", address]);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(format!("Launched {}", binary.display()))
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
        let dest = match action {
            InstallAction::MergeBaseFile { src, dest } | InstallAction::CopyRootFile { src, dest } => {
                std::fs::copy(src, dest).map_err(|e| e.to_string())?;
                dest
            }
            InstallAction::CopyModDir { src, dest } => {
                copy_dir_recursive(src, dest)?;
                dest
            }
        };
        installed_paths.push(
            dest.strip_prefix(game_root)
                .unwrap()
                .to_string_lossy()
                .to_string(),
        );
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
    let (base_dir, game_root) = find_jk2_base_and_root(app)?;
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
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    Ok(installed_status(OPENJO_MOD_ID, &game_root))
}

#[tauri::command]
fn uninstall_openjo(app: tauri::AppHandle) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    uninstall_mod(OPENJO_MOD_ID, &game_root)
}

#[tauri::command]
fn play_openjo(app: tauri::AppHandle) -> Result<String, String> {
    // Single-player only - no +connect support here (see manifest description).
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    let app_bundle = game_root.join("openjo_sp.arm64.app");
    let mut cmd = std::process::Command::new("open");
    cmd.arg(&app_bundle);
    if client_has_pk3_mods(&game_root, OPENJO_MOD_ID) {
        cmd.args(["--args", "+set", "fs_game", &client_mod_folder_name(OPENJO_MOD_ID)]);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(format!("Launched {}", app_bundle.display()))
}

const JK2MV_MOD_ID: &str = "jk2mv";

fn resolve_jk2mv_install(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let payload_dir = app_data.join("extracted").join("jk2mv");
    let (base_dir, game_root) = find_jk2_base_and_root(app)?;
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
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    Ok(installed_status(JK2MV_MOD_ID, &game_root))
}

#[tauri::command]
fn uninstall_jk2mv(app: tauri::AppHandle) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    uninstall_mod(JK2MV_MOD_ID, &game_root)
}

#[tauri::command]
fn play_jk2mv(app: tauri::AppHandle, connect_address: Option<String>) -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root(&app)?;
    let app_bundle = game_root.join("jk2mvmp.app");
    let mut cmd = std::process::Command::new("open");
    cmd.arg(&app_bundle);
    // `open --args` only accepts one --args flag - everything after it is
    // passed straight through to the app, so both +set and +connect (when
    // present) have to be collected first and appended together.
    let mut extra_args: Vec<String> = Vec::new();
    if client_has_pk3_mods(&game_root, JK2MV_MOD_ID) {
        extra_args.push("+set".to_string());
        extra_args.push("fs_game".to_string());
        extra_args.push(client_mod_folder_name(JK2MV_MOD_ID));
    }
    if let Some(address) = &connect_address {
        extra_args.push("+connect".to_string());
        extra_args.push(address.clone());
    }
    if !extra_args.is_empty() {
        cmd.arg("--args");
        cmd.args(&extra_args);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(format!("Launched {}", app_bundle.display()))
}

// --- Custom PK3 mods --------------------------------------------------------
// Distinct from the "mod" = game client naming used everywhere else in this
// file - these are user-added content PK3s (maps, skins, etc.), tracked
// separately from the client-install system above.

const PK3_CLIENT_IDS: [&str; 3] = [TOMMYTERNAL_MOD_ID, OPENJO_MOD_ID, JK2MV_MOD_ID];
const PK3_ALL_TARGET: &str = "all";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Pk3Mod {
    filename: String,
    #[serde(default)]
    targets: Vec<String>,
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

fn pk3_target_dest(
    base_dir: &std::path::Path,
    game_root: &std::path::Path,
    target: &str,
    filename: &str,
) -> std::path::PathBuf {
    if target == PK3_ALL_TARGET {
        base_dir.join(filename)
    } else {
        client_mod_folder(game_root, target).join(filename)
    }
}

fn deploy_pk3_to_targets(
    library_path: &std::path::Path,
    base_dir: &std::path::Path,
    game_root: &std::path::Path,
    filename: &str,
    targets: &[String],
) -> Result<(), String> {
    for target in targets {
        let dest = pk3_target_dest(base_dir, game_root, target, filename);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(library_path, &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn undeploy_pk3_from_targets(
    base_dir: &std::path::Path,
    game_root: &std::path::Path,
    filename: &str,
    targets: &[String],
) -> Result<(), String> {
    for target in targets {
        let dest = pk3_target_dest(base_dir, game_root, target, filename);
        if dest.exists() {
            std::fs::remove_file(&dest).map_err(|e| e.to_string())?;
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
    filename.trim_start_matches('%').to_lowercase().starts_with("assets")
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
    base_dir: &std::path::Path,
    game_root: &std::path::Path,
    mods: &mut Vec<Pk3Mod>,
) -> Result<(), String> {
    let library_dir = pk3_library_dir(app)?;
    std::fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;

    let mut found: std::collections::HashMap<String, (Vec<String>, std::path::PathBuf)> = std::collections::HashMap::new();
    for filename in list_pk3_filenames(base_dir) {
        let path = base_dir.join(&filename);
        found.entry(filename).or_insert((Vec::new(), path)).0.push(PK3_ALL_TARGET.to_string());
    }
    for client_id in PK3_CLIENT_IDS {
        let folder = client_mod_folder(game_root, client_id);
        for filename in list_pk3_filenames(&folder) {
            let path = folder.join(&filename);
            found.entry(filename).or_insert((Vec::new(), path)).0.push(client_id.to_string());
        }
    }

    for (filename, (targets, source_path)) in found {
        let library_path = library_dir.join(&filename);
        if !library_path.exists() {
            let _ = std::fs::copy(&source_path, &library_path);
        }
        match mods.iter_mut().find(|m| m.filename == filename) {
            Some(entry) => {
                for t in &targets {
                    if !entry.targets.contains(t) {
                        entry.targets.push(t.clone());
                    }
                }
            }
            None => mods.push(Pk3Mod { filename, targets }),
        }
    }
    Ok(())
}

#[tauri::command]
fn list_pk3_mods(app: tauri::AppHandle) -> Result<Vec<Pk3Mod>, String> {
    let (base_dir, game_root) = find_jk2_base_and_root(&app)?;
    let mut mods = load_pk3_mods(&game_root);
    reconcile_pk3_mods_with_disk(&app, &base_dir, &game_root, &mut mods)?;
    save_pk3_mods(&game_root, &mods)?;
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
    std::fs::copy(source, library_dir.join(&filename)).map_err(|e| e.to_string())?;

    let (_, game_root) = find_jk2_base_and_root(app)?;
    let mut mods = load_pk3_mods(&game_root);
    if !mods.iter().any(|m| m.filename == filename) {
        mods.push(Pk3Mod { filename: filename.clone(), targets: Vec::new() });
        save_pk3_mods(&game_root, &mods)?;
    }
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
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let source = app_data.join(&relative_path);
    let result = add_pk3_mod_from_path(&app, &source);
    let _ = std::fs::remove_file(&source);
    result
}

#[tauri::command]
fn set_pk3_mod_targets(app: tauri::AppHandle, filename: String, targets: Vec<String>) -> Result<(), String> {
    for t in &targets {
        if t != PK3_ALL_TARGET && !PK3_CLIENT_IDS.contains(&t.as_str()) {
            return Err(format!("Unknown target: {t}"));
        }
    }

    let (base_dir, game_root) = find_jk2_base_and_root(&app)?;
    let library_path = pk3_library_dir(&app)?.join(&filename);
    if !library_path.exists() {
        return Err(format!("{filename} is not in the mod library"));
    }

    let mut mods = load_pk3_mods(&game_root);
    let entry = mods
        .iter_mut()
        .find(|m| m.filename == filename)
        .ok_or_else(|| format!("{filename} is not tracked"))?;

    undeploy_pk3_from_targets(&base_dir, &game_root, &filename, &entry.targets)?;
    deploy_pk3_to_targets(&library_path, &base_dir, &game_root, &filename, &targets)?;
    entry.targets = targets;
    save_pk3_mods(&game_root, &mods)
}

#[tauri::command]
fn remove_pk3_mod(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let (base_dir, game_root) = find_jk2_base_and_root(&app)?;
    let mut mods = load_pk3_mods(&game_root);
    if let Some(entry) = mods.iter().find(|m| m.filename == filename) {
        undeploy_pk3_from_targets(&base_dir, &game_root, &filename, &entry.targets)?;
    }
    mods.retain(|m| m.filename != filename);
    save_pk3_mods(&game_root, &mods)?;

    let library_path = pk3_library_dir(&app)?.join(&filename);
    if library_path.exists() {
        std::fs::remove_file(&library_path).map_err(|e| e.to_string())?;
    }
    Ok(())
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
// kept separate from the #[tauri::command] wrapper below so list_servers can
// call it directly from its own already-spawned OS threads, without piling
// another layer of async/spawn_blocking on top per-server.
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
// something IPC/UI-adjacent (see list_servers below for why this matters).
#[tauri::command]
async fn query_server_status(address: String) -> Result<ServerStatus, String> {
    tauri::async_runtime::spawn_blocking(move || query_server_status_blocking(address))
        .await
        .map_err(|e| e.to_string())?
}

// JK2's community master server - the same one NWH and Tommyternal both
// have baked in (confirmed via `strings` on the real binaries: both
// reference "master.jk2mv.org" alongside the long-dead original
// "masterjk2.ravensoft.com"). Protocol 15 is JK2 1.02's protocol version,
// confirmed against a real server's own getstatus response.
const JK2_MASTER_HOST: &str = "master.jk2mv.org";
const JK2_MASTER_PORT: u16 = 28060;
const JK2_PROTOCOL: u16 = 15;

fn query_master_servers() -> Result<Vec<String>, String> {
    use std::net::UdpSocket;
    use std::time::Duration;

    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .map_err(|e| e.to_string())?;

    let mut packet: Vec<u8> = vec![0xFF, 0xFF, 0xFF, 0xFF];
    packet.extend_from_slice(format!("getservers {} empty full", JK2_PROTOCOL).as_bytes());

    let master_addr = format!("{}:{}", JK2_MASTER_HOST, JK2_MASTER_PORT);
    socket
        .send_to(&packet, &master_addr)
        .map_err(|e| format!("Couldn't reach master server: {}", e))?;

    let mut addresses = Vec::new();
    let mut buf = [0u8; 16384];
    // A big list can span more than one reply packet - keep reading until
    // the master goes quiet (recv times out).
    loop {
        let (len, _) = match socket.recv_from(&mut buf) {
            Ok(r) => r,
            Err(_) => break,
        };
        let data = &buf[..len];
        let marker = b"getserversResponse";
        let Some(pos) = data.windows(marker.len()).position(|w| w == marker) else {
            continue;
        };
        let body = &data[pos + marker.len()..];
        let mut i = 0;
        while i < body.len() {
            if body[i] != b'\\' {
                i += 1;
                continue;
            }
            let rest = &body[i + 1..];
            if rest.starts_with(b"EOT") {
                break;
            }
            if rest.len() < 6 {
                break;
            }
            let chunk = &rest[..6];
            let port = ((chunk[4] as u16) << 8) | chunk[5] as u16;
            addresses.push(format!("{}.{}.{}.{}:{}", chunk[0], chunk[1], chunk[2], chunk[3], port));
            i += 7;
        }
    }
    Ok(addresses)
}

// This fans out to ~20-30 OS threads, each blocking on its own UDP socket
// for up to a few seconds - genuinely heavy blocking work, not something to
// risk running on whatever thread Tauri happens to dispatch commands on.
// spawn_blocking guarantees it runs on the blocking pool instead (this was
// very likely the cause of the launcher appearing to hang/crash the first
// time someone opened the Servers page).
#[tauri::command]
async fn list_servers() -> Result<Vec<ServerStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<ServerStatus>, String> {
        let addresses = query_master_servers()?;
        let handles: Vec<_> = addresses
            .into_iter()
            .map(|address| std::thread::spawn(move || query_server_status_blocking(address)))
            .collect();

        let mut servers: Vec<ServerStatus> = handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter_map(|r| r.ok())
            .collect();
        // Busiest servers first - the ones people actually want to see.
        servers.sort_by(|a, b| b.players.len().cmp(&a.players.len()));
        Ok(servers)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            extract_nwh,
            extract_tommyternal,
            extract_openjo,
            extract_jk2mv,
            locate_jk2,
            locate_jk2_base,
            get_game_folder_override,
            pick_game_folder,
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
            query_server_status,
            list_servers
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
