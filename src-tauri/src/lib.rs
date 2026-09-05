use tauri::Manager;

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

const JK2_STEAM_APP_ID: u32 = 6030;

fn find_jk2_install() -> Result<std::path::PathBuf, String> {
    let steam_dir = steamlocate::locate().map_err(|e| format!("Steam not found: {e}"))?;
    let (app, library) = steam_dir
        .find_app(JK2_STEAM_APP_ID)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Jedi Knight II isn't installed via Steam, or wasn't found in any library.".to_string())?;
    Ok(library.resolve_app_dir(&app))
}

#[tauri::command]
fn locate_jk2() -> Result<String, String> {
    let install_root = find_jk2_install()?;
    Ok(format!("Found Jedi Knight II at {}", install_root.display()))
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
fn locate_jk2_base() -> Result<String, String> {
    let install_root = find_jk2_install()?;
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

fn load_installed_mods(
    game_root: &std::path::Path,
) -> std::collections::HashMap<String, Vec<String>> {
    std::fs::read_to_string(installed_manifest_path(game_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_installed_mods(
    game_root: &std::path::Path,
    mods: &std::collections::HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(mods).map_err(|e| e.to_string())?;
    std::fs::write(installed_manifest_path(game_root), json).map_err(|e| e.to_string())
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
        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            std::fs::copy(&path, &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_jk2_base_and_root() -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let install_root = find_jk2_install()?;
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
    let (base_dir, game_root) = find_jk2_base_and_root()?;
    Ok((payload_dir, base_dir, game_root))
}

#[tauri::command]
fn is_tommyternal_installed() -> Result<bool, String> {
    let (_, game_root) = find_jk2_base_and_root()?;
    Ok(load_installed_mods(&game_root)
        .get(TOMMYTERNAL_MOD_ID)
        .map(|paths| !paths.is_empty())
        .unwrap_or(false))
}

#[tauri::command]
fn play_tommyternal() -> Result<String, String> {
    let (_, game_root) = find_jk2_base_and_root()?;
    let binary = game_root.join("eternaljk2mvmp");
    let mut child = std::process::Command::new(&binary)
        .current_dir(&game_root)
        .spawn()
        .map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(format!("Launched {}", binary.display()))
}

#[tauri::command]
fn preview_install_tommyternal(app: tauri::AppHandle) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_tommyternal_install(&app)?;
    let installed_mods = load_installed_mods(&game_root);
    let already_ours: std::collections::HashSet<String> = installed_mods
        .get(TOMMYTERNAL_MOD_ID)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let actions = plan_install(&payload_dir, &base_dir, &game_root, &already_ours)?;
    Ok(actions.iter().map(describe_action).collect::<Vec<_>>().join("\n"))
}

#[tauri::command]
fn install_tommyternal(app: tauri::AppHandle) -> Result<String, String> {
    let (payload_dir, base_dir, game_root) = resolve_tommyternal_install(&app)?;
    let mut installed_mods = load_installed_mods(&game_root);
    let already_ours: std::collections::HashSet<String> = installed_mods
        .get(TOMMYTERNAL_MOD_ID)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let actions = plan_install(&payload_dir, &base_dir, &game_root, &already_ours)?;

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
            dest.strip_prefix(&game_root)
                .unwrap()
                .to_string_lossy()
                .to_string(),
        );
    }

    installed_mods.insert(TOMMYTERNAL_MOD_ID.to_string(), installed_paths);
    save_installed_mods(&game_root, &installed_mods)?;

    Ok(format!(
        "Installed {} items into {}",
        actions.len(),
        game_root.display()
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            extract_nwh,
            extract_tommyternal,
            locate_jk2,
            locate_jk2_base,
            preview_install_tommyternal,
            install_tommyternal,
            is_tommyternal_installed,
            play_tommyternal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
