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

const JK2_STEAM_APP_ID: u32 = 6030;

#[tauri::command]
fn locate_jk2() -> Result<String, String> {
    let steam_dir = steamlocate::locate().map_err(|e| format!("Steam not found: {e}"))?;
    match steam_dir.find_app(JK2_STEAM_APP_ID).map_err(|e| e.to_string())? {
        Some((app, library)) => {
            let install_dir = library.resolve_app_dir(&app);
            Ok(format!("Found Jedi Knight II at {}", install_dir.display()))
        }
        None => Err("Jedi Knight II isn't installed via Steam, or wasn't found in any library.".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![extract_nwh, locate_jk2])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
