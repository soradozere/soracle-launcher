const MANIFEST_URL = "https://gist.githubusercontent.com/soradozere/a5ac8df67ac85687d20b4901ae1f1af0/raw/manifest.json";
const button = document.getElementById("fetch-manifest-btn");
const output = document.getElementById("manifest-output");

button.addEventListener("click", async () => {
  output.textContent = "Fetching...";
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(MANIFEST_URL);
    const data = await res.json();
    output.textContent = JSON.stringify(data, null, 2);
    console.log("Manifest fetched:", data);
  } catch (err) {
    output.textContent = `Error fetching manifest: ${err}`;
    console.error("Manifest fetch failed:", err);
  }
});

async function downloadFile(url, filename) {
  const { fetch } = window.__TAURI__.http;
  const { writeFile, mkdir, BaseDirectory } = window.__TAURI__.fs;
  await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
  const res = await fetch(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(filename, bytes, { baseDir: BaseDirectory.AppData });
}

const NWH_URL = "https://jk2t.ddns.net/nwhfiles/nwh_linux_x64.tar.gz";
const NWH_FILENAME = "nwh_linux_x64.tar.gz";
const downloadButton = document.getElementById("download-nwh-btn");
const downloadOutput = document.getElementById("download-output");

downloadButton.addEventListener("click", async () => {
  downloadOutput.textContent = "Downloading...";
  try {
    await downloadFile(NWH_URL, NWH_FILENAME);
    downloadOutput.textContent = `Saved ${NWH_FILENAME} to the app data directory.`;
    console.log("Download complete:", NWH_FILENAME);
  } catch (err) {
    downloadOutput.textContent = `Error downloading: ${err}`;
    console.error("Download failed:", err);
  }
});

const extractButton = document.getElementById("extract-nwh-btn");
const extractOutput = document.getElementById("extract-output");

extractButton.addEventListener("click", async () => {
  extractOutput.textContent = "Extracting...";
  try {
    const { invoke } = window.__TAURI__.core;
    const result = await invoke("extract_nwh");
    extractOutput.textContent = result;
    console.log("Extraction complete:", result);
  } catch (err) {
    extractOutput.textContent = `Error extracting: ${err}`;
    console.error("Extraction failed:", err);
  }
});

const locateButton = document.getElementById("locate-jk2-btn");
const locateOutput = document.getElementById("locate-output");

locateButton.addEventListener("click", async () => {
  locateOutput.textContent = "Locating...";
  try {
    const { invoke } = window.__TAURI__.core;
    const result = await invoke("locate_jk2");
    locateOutput.textContent = result;
    console.log("Locate result:", result);
  } catch (err) {
    locateOutput.textContent = `Error locating JK2: ${err}`;
    console.error("Locate failed:", err);
  }
});

const locateBaseButton = document.getElementById("locate-jk2-base-btn");
const locateBaseOutput = document.getElementById("locate-base-output");

locateBaseButton.addEventListener("click", async () => {
  locateBaseOutput.textContent = "Locating...";
  try {
    const { invoke } = window.__TAURI__.core;
    const result = await invoke("locate_jk2_base");
    locateBaseOutput.textContent = result;
    console.log("Locate base result:", result);
  } catch (err) {
    locateBaseOutput.textContent = `Error locating base folder: ${err}`;
    console.error("Locate base failed:", err);
  }
});

const TOMMYTERNAL_URL = "https://github.com/TomArrow/jk2mv/releases/download/latest-postxp/macOS.Package.Portable.Release.arm64.zip";
const TOMMYTERNAL_FILENAME = "tommyternal_macos_arm64.zip";
const downloadTommyternalButton = document.getElementById("download-tommyternal-btn");
const downloadTommyternalOutput = document.getElementById("download-tommyternal-output");

downloadTommyternalButton.addEventListener("click", async () => {
  downloadTommyternalOutput.textContent = "Downloading...";
  try {
    await downloadFile(TOMMYTERNAL_URL, TOMMYTERNAL_FILENAME);
    downloadTommyternalOutput.textContent = `Saved ${TOMMYTERNAL_FILENAME} to the app data directory.`;
    console.log("Download complete:", TOMMYTERNAL_FILENAME);
  } catch (err) {
    downloadTommyternalOutput.textContent = `Error downloading: ${err}`;
    console.error("Tommyternal download failed:", err);
  }
});

const extractTommyternalButton = document.getElementById("extract-tommyternal-btn");
const extractTommyternalOutput = document.getElementById("extract-tommyternal-output");

extractTommyternalButton.addEventListener("click", async () => {
  extractTommyternalOutput.textContent = "Extracting...";
  try {
    const { invoke } = window.__TAURI__.core;
    const result = await invoke("extract_tommyternal");
    extractTommyternalOutput.textContent = result;
    console.log("Tommyternal extraction complete:", result);
  } catch (err) {
    extractTommyternalOutput.textContent = `Error extracting: ${err}`;
    console.error("Tommyternal extraction failed:", err);
  }
});
