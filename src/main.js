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

const NWH_URL = "https://jk2t.ddns.net/nwhfiles/nwh_linux_x64.tar.gz";
const NWH_FILENAME = "nwh_linux_x64.tar.gz";
const downloadButton = document.getElementById("download-nwh-btn");
const downloadOutput = document.getElementById("download-output");

downloadButton.addEventListener("click", async () => {
  downloadOutput.textContent = "Downloading...";
  try {
    const { fetch } = window.__TAURI__.http;
    const { writeFile, BaseDirectory } = window.__TAURI__.fs;
    const res = await fetch(NWH_URL);
    await writeFile(NWH_FILENAME, res.body, { baseDir: BaseDirectory.AppData });
    downloadOutput.textContent = `Saved ${NWH_FILENAME} to the app data directory.`;
    console.log("Download complete:", NWH_FILENAME);
  } catch (err) {
    downloadOutput.textContent = `Error downloading: ${err}`;
    console.error("Download failed:", err);
  }
});
