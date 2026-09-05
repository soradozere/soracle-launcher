const MANIFEST_URL = "https://gist.githubusercontent.com/soradozere/a5ac8df67ac85687d20b4901ae1f1af0/raw/manifest.json";

const MOD_HANDLERS = {
  TommyternalJK2MV: {
    filename: "tommyternal_macos_arm64.zip",
    extractCommand: "extract_tommyternal",
    installCommand: "install_tommyternal",
    checkInstalledCommand: "is_tommyternal_installed",
    playCommand: "play_tommyternal",
  },
};

let mods = [];
let modState = {};

async function downloadFile(url, filename) {
  const { fetch } = window.__TAURI__.http;
  const { writeFile, mkdir, BaseDirectory } = window.__TAURI__.fs;
  await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
  const res = await fetch(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(filename, bytes, { baseDir: BaseDirectory.AppData });
}

function renderCard(mod) {
  const handler = MOD_HANDLERS[mod.name];
  const state = modState[mod.name] || {};
  let actions = `<span class="mod-badge">Not yet supported</span>`;
  if (handler) {
    actions = state.installed
      ? `<button data-action="update" data-mod="${mod.name}" ${state.busy ? "disabled" : ""}>Update</button>
         <button data-action="play" data-mod="${mod.name}" ${state.busy ? "disabled" : ""}>Play</button>`
      : `<button data-action="install" data-mod="${mod.name}" ${state.busy ? "disabled" : ""}>Install</button>`;
  }
  return `<div class="mod-card" id="mod-card-${mod.name}">
    <div class="mod-card-header"><span class="mod-name">${mod.name}</span><span class="mod-version">${mod.version}</span></div>
    <p class="mod-description">${mod.description ?? ""}</p>
    <div class="mod-card-actions">${actions}</div>
    <div class="mod-card-status">${state.message ?? ""}</div>
  </div>`;
}

function updateCard(name) {
  document.getElementById(`mod-card-${name}`).outerHTML = renderCard(mods.find((m) => m.name === name));
}

async function handleAction(name, action) {
  const handler = MOD_HANDLERS[name];
  const mod = mods.find((m) => m.name === name);
  const { invoke } = window.__TAURI__.core;
  modState[name] = { ...modState[name], busy: true, message: "Working..." };
  updateCard(name);
  try {
    if (action === "install" || action === "update") {
      modState[name].message = "Downloading...";
      updateCard(name);
      await downloadFile(mod.url, handler.filename);
      modState[name].message = "Extracting...";
      updateCard(name);
      await invoke(handler.extractCommand);
      modState[name].message = "Installing...";
      updateCard(name);
      await invoke(handler.installCommand);
      modState[name].installed = true;
      modState[name].message = "Done.";
    } else if (action === "play") {
      modState[name].message = "Launching...";
      updateCard(name);
      const result = await invoke(handler.playCommand);
      modState[name].message = result;
    }
  } catch (err) {
    modState[name].message = `Error: ${err}`;
    console.error(`${action} failed for ${name}:`, err);
  } finally {
    modState[name].busy = false;
    updateCard(name);
  }
}

async function init() {
  const modsListEl = document.getElementById("mods-list");
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(MANIFEST_URL);
    mods = (await res.json()).mods;
  } catch (err) {
    modsListEl.textContent = `Error loading manifest: ${err}`;
    console.error("Manifest fetch failed:", err);
    return;
  }

  const { invoke } = window.__TAURI__.core;
  for (const mod of mods) {
    const handler = MOD_HANDLERS[mod.name];
    if (handler) {
      try {
        modState[mod.name] = { installed: await invoke(handler.checkInstalledCommand) };
      } catch (err) {
        modState[mod.name] = { installed: false };
      }
    }
  }

  modsListEl.innerHTML = mods.map(renderCard).join("");
}

document.getElementById("mods-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) handleAction(btn.dataset.mod, btn.dataset.action);
});

init();
