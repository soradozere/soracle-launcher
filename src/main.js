const MANIFEST_URL = "https://gist.githubusercontent.com/soradozere/a5ac8df67ac85687d20b4901ae1f1af0/raw/manifest.json";

const MOD_HANDLERS = {
  TommyternalJK2MV: {
    filename: "tommyternal_macos_arm64.zip",
    extractCommand: "extract_tommyternal",
    installCommand: "install_tommyternal",
    checkInstalledCommand: "is_tommyternal_installed",
    playCommand: "play_tommyternal",
  },
  OpenJO: {
    filename: "openjo_macos_arm64.tar.gz",
    extractCommand: "extract_openjo",
    installCommand: "install_openjo",
    checkInstalledCommand: "is_openjo_installed",
    playCommand: "play_openjo",
  },
  JK2MV: {
    filename: "jk2mv_macos_x86_64.dmg",
    extractCommand: "extract_jk2mv",
    installCommand: "install_jk2mv",
    checkInstalledCommand: "is_jk2mv_installed",
    playCommand: "play_jk2mv",
  },
};

let mods = [];
let modState = {};
let selected = null;

async function downloadFile(url, filename) {
  const { fetch } = window.__TAURI__.http;
  const { writeFile, mkdir, BaseDirectory } = window.__TAURI__.fs;
  await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
  const res = await fetch(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(filename, bytes, { baseDir: BaseDirectory.AppData });
}

function renderSidebar() {
  document.getElementById("client-list").innerHTML = mods
    .map((mod) => {
      const state = modState[mod.name] || {};
      const status = state.installed ? "installed" : MOD_HANDLERS[mod.name] ? "" : "unsupported";
      const classes = ["client-row", mod.name === selected ? "active" : "", state.installed ? "installed" : ""]
        .filter(Boolean)
        .join(" ");
      return `<div class="${classes}" data-name="${mod.name}">
        <span class="client-row-name">${mod.name}</span>
        <span class="client-row-status">${status}</span>
      </div>`;
    })
    .join("");
}

function renderMain() {
  const mainEl = document.getElementById("main");
  const mod = mods.find((m) => m.name === selected);
  if (!mod) {
    mainEl.innerHTML = `<div class="main-empty">Select a client</div>`;
    return;
  }
  const handler = MOD_HANDLERS[mod.name];
  const state = modState[mod.name] || {};
  let actions = `<span class="detail-badge">Not yet supported</span>`;
  if (handler) {
    actions = state.installed
      ? `<button data-action="update" ${state.busy ? "disabled" : ""}>Update</button>
         <button data-action="play" ${state.busy ? "disabled" : ""}>Play</button>`
      : `<button data-action="install" ${state.busy ? "disabled" : ""}>Install</button>`;
  }
  mainEl.innerHTML = `
    <div class="detail-header"><h2>${mod.name}</h2><span class="detail-version">${mod.version}</span></div>
    <p class="detail-description">${mod.description ?? ""}</p>
    <div class="detail-actions">${actions}</div>
    <p class="detail-status">${state.message ?? ""}</p>
  `;
}

async function handleAction(name, action) {
  const handler = MOD_HANDLERS[name];
  const mod = mods.find((m) => m.name === name);
  const { invoke } = window.__TAURI__.core;
  modState[name] = { ...modState[name], busy: true, message: "Working..." };
  renderSidebar();
  renderMain();
  try {
    if (action === "install" || action === "update") {
      modState[name].message = "Downloading...";
      renderMain();
      await downloadFile(mod.url, handler.filename);
      modState[name].message = "Extracting...";
      renderMain();
      await invoke(handler.extractCommand);
      modState[name].message = "Installing...";
      renderMain();
      await invoke(handler.installCommand);
      modState[name].installed = true;
      modState[name].message = "Done.";
    } else if (action === "play") {
      modState[name].message = "Launching...";
      renderMain();
      modState[name].message = await invoke(handler.playCommand);
    }
  } catch (err) {
    modState[name].message = `Error: ${err}`;
    console.error(`${action} failed for ${name}:`, err);
  } finally {
    modState[name].busy = false;
    renderSidebar();
    renderMain();
  }
}

function selectClient(name) {
  selected = name;
  renderSidebar();
  renderMain();
}

async function checkGameFolder() {
  const dot = document.getElementById("game-folder-status");
  try {
    const { invoke } = window.__TAURI__.core;
    await invoke("locate_jk2");
    dot.classList.remove("missing");
  } catch (err) {
    dot.classList.add("missing");
    console.error("Game folder not found:", err);
  }
}

async function init() {
  checkGameFolder();

  const clientListEl = document.getElementById("client-list");
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(MANIFEST_URL);
    mods = (await res.json()).mods;
  } catch (err) {
    clientListEl.innerHTML = `<p class="sidebar-loading">Error: ${err}</p>`;
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

  renderSidebar();
  renderMain();
}

document.getElementById("client-list").addEventListener("click", (e) => {
  const row = e.target.closest(".client-row");
  if (row) selectClient(row.dataset.name);
});

document.getElementById("main").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) handleAction(selected, btn.dataset.action);
});

document.getElementById("change-folder-btn").addEventListener("click", () => {
  document.getElementById("main").insertAdjacentHTML(
    "afterbegin",
    `<p class="detail-status" style="margin-bottom: 1rem;">Manual folder selection isn't built yet - the game folder is found automatically via Steam.</p>`
  );
});

init();
