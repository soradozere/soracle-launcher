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
