const MANIFEST_URL = "https://gist.githubusercontent.com/soradozere/a5ac8df67ac85687d20b4901ae1f1af0/raw/manifest.json";
const SORACLE_BASE = "https://jk2ctf.com";
const SESSION_FILE = "soracle_session.json";
const STEAM_STORE_URL = "https://store.steampowered.com/app/6030/STAR_WARS_Jedi_Knight_II__Jedi_Outcast/";

// One filename per OS per client - has to match exactly what that OS's
// extract_* Rust command expects to find under AppData (see lib.rs).
const MOD_HANDLERS = {
  TommyternalJK2MV: {
    modId: "tommyternal",
    filenames: {
      macos: "tommyternal_macos_arm64.zip",
      windows: "tommyternal_windows_x64.zip",
      linux: "tommyternal_linux_x64.zip",
    },
    extractCommand: "extract_tommyternal",
    installCommand: "install_tommyternal",
    checkInstalledCommand: "is_tommyternal_installed",
    playCommand: "play_tommyternal",
    uninstallCommand: "uninstall_tommyternal",
  },
  OpenJO: {
    modId: "openjo",
    filenames: {
      macos: "openjo_macos_arm64.tar.gz",
      windows: "openjo_windows_x64.zip",
      linux: "openjo_linux_x64.tar.gz",
    },
    extractCommand: "extract_openjo",
    installCommand: "install_openjo",
    checkInstalledCommand: "is_openjo_installed",
    playCommand: "play_openjo",
    uninstallCommand: "uninstall_openjo",
  },
  JK2MV: {
    modId: "jk2mv",
    filenames: {
      macos: "jk2mv_macos_x86_64.dmg",
      windows: "jk2mv_windows_x64.zip",
      linux: "jk2mv_linux_x64.deb",
    },
    extractCommand: "extract_jk2mv",
    installCommand: "install_jk2mv",
    checkInstalledCommand: "is_jk2mv_installed",
    playCommand: "play_jk2mv",
    uninstallCommand: "uninstall_jk2mv",
  },
  // Builds for all three now, from jk2ctf.com/nwh-download. The macOS one is
  // Apple Silicon only, like this launcher's own macOS build.
  NWH: {
    modId: "nwh",
    filenames: {
      macos: "nwh_macos_arm64.zip",
      windows: "nwh_windows_x64.zip",
      linux: "nwh_linux_x64.tar.gz",
    },
    extractCommand: "extract_nwh",
    installCommand: "install_nwh",
    checkInstalledCommand: "is_nwh_installed",
    playCommand: "play_nwh",
    uninstallCommand: "uninstall_nwh",
  },
};

// Set once at startup from the Rust side (std::env::consts::OS) - "macos",
// "windows", or "linux". Defaults to macos only so nothing throws if it's
// ever read before init() finishes.
let currentPlatform = "macos";

// A mod's download moved from one flat {url, sha256} to a
// {platforms: {macos: {...}, windows: {...}, linux: {...}}} shape so each
// OS can point at its own release asset. Falls back to the mod object
// itself for anything not yet updated to carry a platforms block (or the
// macOS entry, if the current platform specifically hasn't been added yet)
// so an older manifest shape never just breaks instead of degrading.
function modPlatformInfo(mod) {
  if (!mod.platforms) return mod;
  return mod.platforms[currentPlatform] ?? mod.platforms.macos ?? mod;
}

// A handler can carry `platforms` to limit which OS it's offered on (NWH
// used to be Linux-only). None does right now, so this is true for every
// client with a handler.
function modSupportedOnCurrentPlatform(name) {
  const handler = MOD_HANDLERS[name];
  return !!handler && (!handler.platforms || handler.platforms.includes(currentPlatform));
}

// Only clients that actually speak the multiplayer protocol can join -
// OpenJO is single-player only.
const JOINABLE_CLIENTS = ["TommyternalJK2MV", "JK2MV", "NWH"];

// The Servers page used to discover this list live from the community
// master server, but that discovery query proved unreliable (consistently
// returned zero addresses when run from a compiled binary, even retried
// with fresh sockets, while a direct query to a known address always
// works). A maintained list traded auto-discovery for the same reliability
// favorites already had.
const KNOWN_SERVERS = [
  "185.163.117.39:28075", // Ownage City
  "176.103.220.40:28070", // freedom defrag
  "176.103.220.40:28071", // slowburn defrag
  "185.163.117.39:28070", // O.C Funmaps
  "185.163.117.39:28071", // O.C Manhunt
  "159.195.145.214:28077", // [DARK] Homebase
  "74.91.115.117:28072", // American FFA
  "74.91.115.117:28070", // American NWH
  "192.223.24.74:28070", // NA East
  "54.238.175.102:28070", // NWH Tokyo
  "176.103.220.40:28072", // freedom duels
  "199.19.72.85:28070", // Dozer NY NWH
  "108.248.225.180:28070", // Saberology
  "208.167.239.201:28070", // New Jersey
];
// Servers a user added themselves on the Servers page, on top of
// KNOWN_SERVERS - kept per install, never shared.
const CUSTOM_SERVERS_KEY = "jk2launcher.customServers";
const DEFAULT_SERVER_PORT = 28070;
const FAVORITE_SERVERS_KEY = "jk2launcher.favoriteServers";
const FAVORITE_SERVERS_SEEDED_KEY = "jk2launcher.favoriteServersSeeded";
const LEGACY_FAVORITE_SERVER_KEY = "jk2launcher.favoriteServer"; // pre-multi-favorite, single address
const MAX_FAVORITE_SERVERS = 3;
const DEFAULT_FAVORITE_SERVERS = [
  "192.223.24.74:28070", // NA East
  "176.103.220.40:28070", // freedomdefrag
];

let mods = [];
let modState = {};
let selected = "__home__";
let session = null; // { name } once signed in to a Soracle player account
let activityFeed = null;
let activityFeedError = null;
let recentVideos = undefined; // undefined = not yet loaded, else an array (possibly empty)
const statsCache = {}; // player name -> stats data, null (not found), or { error }

let pk3Mods = null; // list from list_pk3_mods, or null while loading
let pk3ModsError = null;

// Which game folder each client resolves to, and whether that's a folder
// set for this client specifically or the shared default. Clients don't
// have to live together: a setup with no Steam install at all can have one
// complete game folder per client, which a single global path can't express.
const clientFolders = {}; // client name -> { path, is_own }, or undefined while loading

async function loadClientFolder(name) {
  const modId = MOD_HANDLERS[name]?.modId;
  if (!modId) return;
  try {
    clientFolders[name] = await window.__TAURI__.core.invoke("get_client_folder", { modId });
  } catch (err) {
    clientFolders[name] = { path: null, is_own: false };
    console.error("Failed to read client folder:", err);
  }
  if (selected === name) renderMain();
}

// Picking a folder for one client leaves every other client - and the
// shared default - exactly as they were. Re-checks install state after,
// since "is this installed" is answered relative to whichever folder the
// client now points at.
async function setClientFolder(name) {
  const modId = MOD_HANDLERS[name]?.modId;
  if (!modId) return;
  try {
    const picked = await window.__TAURI__.core.invoke("pick_client_folder", { modId });
    if (picked === null) return; // cancelled
    clientFolders[name] = { path: picked, is_own: true };
    clientFolderSuggestions[name] = undefined;
    await refreshModStates();
  } catch (err) {
    modState[name] = { ...modState[name], message: `Error: ${err}` };
    renderMain();
  }
}

// A client that isn't in the folder we're pointed at is very often sitting
// in a sibling folder (a "Games" dir with one game folder per client is a
// normal setup). Ask the backend whether it can see it next door, so we can
// offer that instead of insisting it isn't installed.
const clientFolderSuggestions = {}; // name -> path, null (none), or undefined while loading

async function loadFolderSuggestion(name) {
  const modId = MOD_HANDLERS[name]?.modId;
  if (!modId) return;
  try {
    clientFolderSuggestions[name] = await window.__TAURI__.core.invoke("detect_client_folder", { modId });
  } catch (err) {
    clientFolderSuggestions[name] = null;
    console.error("Folder detection failed:", err);
  }
  if (selected === name) renderMain();
}

async function useSuggestedFolder(name, path) {
  const modId = MOD_HANDLERS[name]?.modId;
  if (!modId) return;
  try {
    await window.__TAURI__.core.invoke("set_client_folder", { modId, path });
    clientFolders[name] = { path, is_own: true };
    clientFolderSuggestions[name] = null;
    await refreshModStates();
  } catch (err) {
    modState[name] = { ...modState[name], message: `Error: ${err}` };
    renderMain();
  }
}

async function resetClientFolder(name) {
  const modId = MOD_HANDLERS[name]?.modId;
  if (!modId) return;
  try {
    await window.__TAURI__.core.invoke("clear_client_folder", { modId });
    clientFolders[name] = undefined;
    clientFolderSuggestions[name] = undefined;
    await refreshModStates();
  } catch (err) {
    modState[name] = { ...modState[name], message: `Error: ${err}` };
    renderMain();
  }
}

const serverStatusCache = {}; // address -> ServerStatus, undefined while loading, or { error }
const serverJoinMessage = {}; // address -> status text shown under that server's card

// Seeds everyone's very first launch with two favorites already set, without
// permanently overriding someone who later changes their favorites on
// purpose - the seeded-marker means this only ever fires once per install.
// Also migrates the old single-favorite key from before multi-favorite
// support, so an existing pick isn't silently dropped.
function ensureDefaultFavoriteServers() {
  try {
    if (localStorage.getItem(FAVORITE_SERVERS_SEEDED_KEY) !== null) return;
    const legacy = localStorage.getItem(LEGACY_FAVORITE_SERVER_KEY);
    const seeded = legacy
      ? [legacy, ...DEFAULT_FAVORITE_SERVERS.filter((a) => a !== legacy)].slice(0, MAX_FAVORITE_SERVERS)
      : DEFAULT_FAVORITE_SERVERS;
    localStorage.setItem(FAVORITE_SERVERS_KEY, JSON.stringify(seeded));
    localStorage.setItem(FAVORITE_SERVERS_SEEDED_KEY, "1");
  } catch {
    // Private-browsing-style storage block - just skip the default.
  }
}

function getFavoriteServers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITE_SERVERS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isFavoriteServer(address) {
  return getFavoriteServers().includes(address);
}

function getCustomServers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_SERVERS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setCustomServers(list) {
  try {
    localStorage.setItem(CUSTOM_SERVERS_KEY, JSON.stringify(list));
  } catch {
    // Private-browsing-style storage block - the server just won't stick.
  }
}

function isCustomServer(address) {
  return getCustomServers().includes(address) && !KNOWN_SERVERS.includes(address);
}

// Everything the Servers page lists: the maintained list, then the user's own.
function allServers() {
  return Array.from(new Set([...KNOWN_SERVERS, ...getCustomServers()]));
}

// Accepts what people actually paste - "1.2.3.4:28070", a bare IP (JK2's
// default port is assumed), a hostname, or a whole "/connect 1.2.3.4" line
// copied from a Discord post - and returns a canonical "host:port", or null
// with nothing that could be mistaken for an address. The narrow character
// set also means the result is safe to drop straight into markup.
function normalizeServerAddress(input) {
  const raw = input.trim().replace(/^\/?connect\s+/i, "").trim();
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(raw);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : DEFAULT_SERVER_PORT;
  if (port < 1 || port > 65535) return null;
  return `${match[1].toLowerCase()}:${port}`;
}

let addServerMessage = "";
// The Servers page redraws as each server answers, so a half-typed address
// lives here rather than only in the input it would otherwise be wiped from.
let addServerDraft = "";

function addCustomServer(input) {
  const address = normalizeServerAddress(input);
  if (!address) {
    addServerMessage = "That doesn't look like a server address - try something like 1.2.3.4:28070.";
    return;
  }
  if (allServers().includes(address)) {
    addServerMessage = `${address} is already on the list.`;
    return;
  }
  setCustomServers([...getCustomServers(), address]);
  addServerMessage = `Added ${address}.`;
  addServerDraft = "";
}

function removeCustomServer(address) {
  setCustomServers(getCustomServers().filter((a) => a !== address));
  // A server that's gone from the list shouldn't linger as a favorite
  // either, with no row left to un-star it from.
  if (isFavoriteServer(address)) toggleFavoriteServer(address);
  delete serverStatusCache[address];
  expandedServers.delete(address);
  addServerMessage = "";
}

// Returns false (and changes nothing) if this would add a new favorite past
// the cap - callers that let a user reach this in the first place should
// disable the control instead of relying solely on this.
function toggleFavoriteServer(address) {
  const current = getFavoriteServers();
  const already = current.includes(address);
  if (!already && current.length >= MAX_FAVORITE_SERVERS) return false;
  const next = already ? current.filter((a) => a !== address) : [...current, address];
  try {
    localStorage.setItem(FAVORITE_SERVERS_KEY, JSON.stringify(next));
  } catch {
    // Private-browsing-style storage block - favoriting just won't stick.
  }
  return true;
}

// The four game modes on Home - one banner each, tied to the client that
// plays it. `defaultServer` is what Play joins until someone picks their own
// with the gear; null means Play just opens the game to its main menu.
// Campaign is OpenJO's single-player, so it has no server at all.
const GAME_MODES = [
  { id: "ctf", title: "Capture the Flag (NWH)", client: "NWH", defaultServer: "192.223.24.74:28070" }, // NA East
  { id: "defrag", title: "Defrag (Tommyternal)", client: "TommyternalJK2MV", defaultServer: "176.103.220.40:28070" }, // freedom defrag
  { id: "ffa", title: "FFA (JK2MV)", client: "JK2MV", defaultServer: null },
  { id: "campaign", title: "Campaign (OpenJO)", client: "OpenJO", singlePlayer: true },
];
const MODE_SERVERS_KEY = "jk2launcher.modeServers";
const LEGACY_PINNED_ACTIONS_KEY = "jk2launcher.pinnedActions"; // the old Play CTF / Play Defrag buttons

// Servers picked with the old Play CTF / Play Defrag buttons carry over, so
// nobody's choice is lost to the redesign.
function loadModeServers() {
  const servers = Object.fromEntries(
    GAME_MODES.filter((m) => !m.singlePlayer).map((m) => [m.id, m.defaultServer])
  );
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_PINNED_ACTIONS_KEY) ?? "null");
    if (legacy?.ctf?.server) servers.ctf = legacy.ctf.server;
    if (legacy?.defrag?.server) servers.defrag = legacy.defrag.server;
    Object.assign(servers, JSON.parse(localStorage.getItem(MODE_SERVERS_KEY) ?? "null"));
  } catch {
    // Private-browsing-style storage block - defaults it is.
  }
  return servers;
}

let modeServers = loadModeServers();

function saveModeServers() {
  try {
    localStorage.setItem(MODE_SERVERS_KEY, JSON.stringify(modeServers));
  } catch {
    // Private-browsing-style storage block - the pick just won't stick.
  }
}

// The client a mode's Play button uses, or null where it can't run.
function modeClient(mode) {
  return modSupportedOnCurrentPlatform(mode.client) ? mode.client : null;
}

function serverDisplayName(address) {
  const data = serverStatusCache[address];
  return data && !data.error ? stripQuakeColors(data.hostname) : address;
}

// `name` is the MOD_HANDLERS key, so a target can be filtered out on a
// platform that can't install that client at all.
const PK3_CLIENTS = [
  { id: "jk2mv", label: "JK2MV", name: "JK2MV" },
  { id: "tommyternal", label: "TommyternalJK2MV", name: "TommyternalJK2MV" },
  { id: "openjo", label: "OpenJO", name: "OpenJO" },
  { id: "nwh", label: "NWH", name: "NWH" },
];

function pk3TargetClients() {
  return PK3_CLIENTS.filter((c) => modSupportedOnCurrentPlatform(c.name));
}

// Clients with their own menus, which won't start with a PK3 that replaces
// the stock ones (OWN_MENU_CLIENT_IDS on the Rust side).
const OWN_MENU_CLIENT_IDS = ["tommyternal", "nwh"];

function ownMenuClientsIn(targets) {
  return pk3TargetClients()
    .map((c) => c.id)
    .filter((id) => OWN_MENU_CLIENT_IDS.includes(id) && (targets.includes("all") || targets.includes(id)));
}

// Kept in sync by hand with jk2ctf.com/faq's ACCOUNT + LAUNCHER sections -
// embedded here so opening it doesn't leave the app. /ctf-101 (gameplay) has
// no launcher equivalent since none of it is launcher-specific. Ordered
// orientation-first within LAUNCHER (what this is -> what you can install ->
// how you'd use it day to day -> what goes wrong), matching how someone
// actually opening this page for the first time thinks about it, rather
// than the previous arbitrary order that opened on a PK3 question before
// ever saying what the app even does.
const FAQ_ENTRIES = [
  {
    section: "Launcher",
    q: "What is the JK2 Launcher?",
    a: "This app - it installs and updates JK2 client mods for you, no manually copying files into your Jedi Outcast folder. It finds your Steam install automatically.",
  },
  {
    section: "Launcher",
    q: "Which clients can I install?",
    a: "NWH (the anti-cheat client organised CTF runs on), JK2MV (the modernised engine most other clients build on), TomArrow's Tommyternal fork (defrag/FFA-focused), and OpenJO (a stability-focused rebuild of the single-player campaign). All four run natively on macOS, Windows, and Linux.",
  },
  {
    section: "Launcher",
    q: "What about NWH?",
    a: "NWH is the anti-cheat client organised CTF matches run on. Install it from its page under Clients - there are builds for macOS (Apple Silicon), Windows and Linux, the same ones offered at jk2ctf.com/nwh-download.",
  },
  {
    section: "Launcher",
    q: "How do I install custom maps or mods (PK3s)?",
    a: "Use the Mods section in the sidebar. Add PK3s from your own computer, or search and download straight from the Monolith community database - either way, you then choose whether a mod applies to All Clients or just specific ones, and the launcher handles putting it in the right place.",
  },
  {
    section: "Launcher",
    q: "It says it can't find Jedi Outcast.",
    a: 'Use Change... next to Game Folder in the sidebar to point the launcher at your install directly, if it\'s somewhere non-standard.',
  },
  {
    section: "Launcher",
    q: "A client won't launch, or crashes immediately.",
    a: "Try Update first - a fresh install often clears it. If that doesn't help, ask in Discord with what you tried.",
  },
  {
    section: "Account",
    q: "How do I get a player account?",
    a: "There's no sign-up form - an admin sets your name and an initial password. Ask in the community Discord and someone will get you set up.",
  },
  {
    section: "Account",
    q: "I forgot my password.",
    a: "Same answer - ask an admin to reset it. There's no email tied to the account, so there's no self-serve reset flow.",
  },
  {
    section: "Account",
    q: "What's a player profile actually for?",
    a: 'It\'s your public page at jk2ctf.com/player/[your-name] - stats, badges, titles you\'ve earned, and cosmetics you can equip once unlocked. Sign in above and it\'s editable; anyone can view it without an account.',
  },
];

const playerSlug = (name) => encodeURIComponent(name.trim().toLowerCase().replace(/\s+/g, "-"));

async function loadSession() {
  const { readTextFile, exists, BaseDirectory } = window.__TAURI__.fs;
  try {
    if (!(await exists(SESSION_FILE, { baseDir: BaseDirectory.AppData }))) return null;
    return JSON.parse(await readTextFile(SESSION_FILE, { baseDir: BaseDirectory.AppData }));
  } catch (err) {
    // A bare silent catch here is exactly how the missing
    // fs:allow-appdata-read-recursive capability (session file writes fine,
    // reads were denied) went unnoticed - login "worked" but silently
    // never survived a restart, with nothing to explain why.
    console.error("Failed to load session:", err);
    return null;
  }
}

async function saveSession(name) {
  const { writeTextFile, mkdir, BaseDirectory } = window.__TAURI__.fs;
  await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
  await writeTextFile(SESSION_FILE, JSON.stringify({ name }), { baseDir: BaseDirectory.AppData });
}

async function clearSession() {
  const { remove, exists, BaseDirectory } = window.__TAURI__.fs;
  if (await exists(SESSION_FILE, { baseDir: BaseDirectory.AppData })) {
    await remove(SESSION_FILE, { baseDir: BaseDirectory.AppData });
  }
}

// A themed stand-in for window.confirm() - a plain native browser dialog
// would look completely out of place against the rest of this UI. Resolves
// true/false; clicking the backdrop counts as Cancel.
function showConfirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h3 class="confirm-title">${title}</h3>
        <p class="confirm-message">${message}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel-btn">Cancel</button>
          <button class="confirm-ok-btn ${danger ? "danger" : ""}">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function finish(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    overlay.querySelector(".confirm-cancel-btn").addEventListener("click", () => finish(false));
    overlay.querySelector(".confirm-ok-btn").addEventListener("click", () => finish(true));
  });
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Downloads and writes the file regardless of whether it matches
// expectedSha256 - a mismatch is a signal to show the user, not a reason to
// block them (see the README's "Verifying a new client release" section for
// why: an upstream release changing this file is indistinguishable, by hash
// alone, from a compromised one, and treating every routine release as a
// hard failure would just make people click through it out of habit anyway).
async function downloadFile(url, filename, expectedSha256) {
  const { fetch } = window.__TAURI__.http;
  const { writeFile, mkdir, BaseDirectory } = window.__TAURI__.fs;
  await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
  const res = await fetch(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(filename, bytes, { baseDir: BaseDirectory.AppData });
  if (!expectedSha256) return { verified: null };
  const actual = await sha256Hex(bytes);
  return { verified: actual.toLowerCase() === expectedSha256.toLowerCase(), actual };
}

// The Clients group in the sidebar starts folded and remembers whether it
// was left open. Opening a client from anywhere else (a Home banner's
// Install, say) unfolds it, so the active client is never hidden inside a
// closed group.
const CLIENTS_GROUP_OPEN_KEY = "jk2launcher.clientsGroupOpen";
let clientsGroupOpen = (() => {
  try {
    return localStorage.getItem(CLIENTS_GROUP_OPEN_KEY) === "1";
  } catch {
    return false;
  }
})();

function setClientsGroupOpen(open) {
  clientsGroupOpen = open;
  try {
    localStorage.setItem(CLIENTS_GROUP_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private-browsing-style storage block - it just won't be remembered.
  }
  renderSidebar();
}

// What a client's dot and tag say in the sidebar. The dot carries installed
// or not; text only appears when it adds something.
function clientRowStatus(mod) {
  const state = modState[mod.name] || {};
  if (!modSupportedOnCurrentPlatform(mod.name)) {
    const only = MOD_HANDLERS[mod.name]?.platforms;
    const names = { linux: "Linux", macos: "macOS", windows: "Windows" };
    return { installed: false, title: "Not available on this platform", tag: only ? `${only.map((p) => names[p] ?? p).join("/")} only` : "unsupported" };
  }
  // Not checked yet (see refreshModStates) - don't claim either way.
  if (modState[mod.name] === undefined) return { installed: false, checking: true, title: "Checking...", tag: "" };
  if (!state.installed) return { installed: false, title: "Not installed", tag: "" };
  const upToDate = state.installedVersion && state.installedVersion === mod.version;
  return { installed: true, title: upToDate ? "Installed" : "Update available", tag: upToDate ? "" : "update" };
}

function renderSidebar() {
  document.getElementById("home-nav-row").classList.toggle("active", selected === "__home__");
  document.getElementById("ctf-nav-row").classList.toggle("active", selected === "__ctf__");
  document.getElementById("mods-nav-row").classList.toggle("active", selected === "__mods__");
  document.getElementById("media-nav-row").classList.toggle("active", selected === "__media__");
  document.getElementById("config-nav-row").classList.toggle("active", selected === "__config__");
  document.getElementById("servers-nav-row").classList.toggle("active", selected === "__servers__");
  document.getElementById("faq-nav-row").classList.toggle("active", selected === "__faq__");
  document.getElementById("sign-out-section").hidden = !session;

  const clientSelected = mods.some((m) => m.name === selected);
  const groupRow = document.getElementById("clients-group-row");
  groupRow.classList.toggle("open", clientsGroupOpen);
  groupRow.setAttribute("aria-expanded", String(clientsGroupOpen));
  // Folded shut while viewing a client: the group row stands in as active.
  groupRow.classList.toggle("active", clientSelected && !clientsGroupOpen);
  document.getElementById("clients-group").hidden = !clientsGroupOpen;

  // Leave a manifest error (and its Retry button) in place until it's retried.
  if (!mods.length) return;
  document.getElementById("client-list").innerHTML = mods
    .map((mod) => {
      const status = clientRowStatus(mod);
      const classes = ["client-row", mod.name === selected ? "active" : "", status.installed ? "installed" : "", status.checking ? "checking" : ""]
        .filter(Boolean)
        .join(" ");
      return `<div class="${classes}" data-name="${escapeHtml(mod.name)}" title="${status.title}">
        <span class="client-row-name">${escapeHtml(mod.displayName ?? mod.name)}</span>
        ${status.tag ? `<span class="client-row-status ${status.tag === "update" ? "client-row-status--update" : ""}">${status.tag}</span>` : ""}
        <span class="client-dot" aria-hidden="true"></span>
      </div>`;
    })
    .join("");
}

const RARITY_COLORS = {
  common: "var(--rarity-common)",
  rare: "var(--rarity-rare)",
  epic: "var(--rarity-epic)",
  legendary: "var(--rarity-legendary)",
  mythic: "var(--rarity-mythic)",
  oneofone: "var(--rarity-oneofone)",
};

// Jedi Order / Phoenix Squadron / Galactic Empire, from the SW SVGs set -
// cleaned copies live in src/assets/icons/ for reference, inlined here
// (rather than <img>-referenced) so currentColor tinting still works with
// the per-type/rarity accent colors below.
const FEED_ICONS = {
  match: `<svg viewBox="0 0 850.4 850.4" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
<g>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M415.4,526.9c-6.2-9-39.1-57.1-39.1-57.1l25.1,69.1l-77.9,11.3l77.9,11.3l-30.1,59c0,0,37.6-39.5,42.9-45.1
		c-2.2,85.6-2.7,106.7-2.7,106.7S219.2,592.9,326,395.7c0,0-133.2-147-12.6-237.4c0,0-206,124.4-75.4,337.9
		c0,0-108-105.5-51.5-212.3c0,0-98,138.2,21.4,290.2c0,0-32.7-20.1-61.6-96.7c0,0,21.1,228.1,276.3,231.1c0,0,0,0,0,0
		c0.9,0,1.7,0,2.5,0c0.8,0,1.7,0,2.5,0c0,0,0,0,0,0c255.2-3,276.3-231.1,276.3-231.1c-28.9,76.6-61.6,96.7-61.6,96.7
		c119.3-152,21.4-290.2,21.4-290.2c56.5,106.8-51.5,212.3-51.5,212.3C743,282.6,537,158.2,537,158.2
		c120.6,90.5-12.6,237.4-12.6,237.4C631.2,592.9,439,682.1,439,682.1s-0.5-21.1-2.7-106.7c5.3,5.6,42.9,45.1,42.9,45.1l-30.1-59
		l77.9-11.3L449,538.9l25.1-69.1c0,0-33,48.1-39.1,57.1c-2.8-109.4-9.7-380.7-9.8-382c0-3,0-3,0-3s0,0,0,1.3c0-1.2,0-1.3,0-1.3
		s0,0,0,3C425.1,147.1,418.2,417.8,415.4,526.9L415.4,526.9z"/>
	<g>
		<g>
			<path fill-rule="evenodd" clip-rule="evenodd" d="M425.2,65.2c-198.8,0-360,161.2-360,360c0,198.8,161.2,360,360,360c198.8,0,360-161.2,360-360
				C785.2,226.4,624,65.2,425.2,65.2z M425.2,742.1c-175,0-316.9-141.9-316.9-316.9c0-175,141.9-316.9,316.9-316.9
				c175,0,316.9,141.9,316.9,316.9C742.1,600.2,600.2,742.1,425.2,742.1z"/>
		</g>
	</g>
</g>
</svg>`,
  crest: `<svg viewBox="0 0 850.4 850.4" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
<g>
	<g>
		<path d="M766.9,273.4c-2.3-3.8-5.3-7-5.3-7c-1.6-1.6-3-2.9-3.9-3.6c20.3,78.6,21.4,153.9-31.1,221.3c-1.9,1.3-4.4,2.7-6,1.8
			c-3-1.8-0.1-10.9,2.1-22.9c0,0,2.6-13.9,3-35c0.2-7.4-0.1-18.1-2.1-31.2c0,0,0,0,0,0c0,0,0,0,0,0c-4.6-25.8-9.5-51.5-22-75.1
			c-1,11.3-1,22.5-1,33.7c-0.1,92.2-55.4,172.3-142.1,202.8c-71.7,25.2-122.1-11.6-110.3-90.7c9.3-61.7,43.8-106.5,93.4-141.1
			c10.7-7.4,20.3-15.4,27.9-25.8c26.8-36.5,60.5-66.2,94.7-95.3c6.2-5.2,12.1-10.9,18.1-16.3c-7.7-1.8-14.2-1.3-20.5-0.2
			c-29.7,5.3-57.9,15.1-85.2,27.7c-62.5,28.6-118.6,67.2-171.2,111.1c-17,14.2-35.4,26.1-56.5,33.6c-10.8,3.8-22.1,3.3-34.7,5.6
			c18.4,7.3,42.1,7.4,67.5,1.2c21.5-5.3,41.8-13.7,61.5-23.8c3.1-1.6,6.7-3.7,9.9-1.1c3.7,3,2.6,7.4,1.2,11c-1.2,3.2-3,6.6-5.5,8.8
			c-33.4,30.3-71.2,52-116.9,56.4c-37.4,3.6-66-20.5-71.2-57.5c-3.1-22.1,1-43,8.4-63.5c25.7-71.2,78.2-114.1,147.3-139.5
			c18.2-6.7,37.5-9.3,56.2-14.6c-38-6.5-75.6-6.1-112.9,2.4c-16.8,3.8-32.9,9.7-48.9,16.1c-2.1,0.8-4.6,1.8-6.4,0.8
			c-0.2-0.1-1.3-0.7-1.7-1.9c-1-2.6,1.8-5.9,3-7.3c20.1-23.2,44.3-35.8,44.3-35.8c10.6-5.5,23-11.9,41.3-18.2
			c20.6-7.2,37.6-10.6,46.4-12.1c30.9-5.3,57.9-4.7,89.1-4c2.3,0.1,4.2,0.1,5.4,0.1c2.2,0.1,4.2,0.1,6,0.2c-0.8-1.1-2.1-2.6-4-3.9
			c-2.4-1.8-4.7-2.5-7.2-3.3c-8-2.4-11.3-3-11.3-3c-14.7-3.5-27.2-5.4-36.5-6.5c-23.3-2.8-44.5-2.8-57.2-2.8h0
			c-14.3,0.4-28.6,1.5-42.9,3.5C239.6,88.2,137.8,161.9,81.4,290.8C36.2,394,43,498.7,97.7,597.4c34.8,62.8,84.9,113.1,150.5,143.9
			c147.5,69.4,288.3,57.6,417.9-43.6c32.1-25.1,59.3-54.7,80.6-88.9c4.2-6.8,15.1-25,25.5-50.3c5.7-13.9,24.2-61.7,26.6-130.8
			C798.7,427.6,802.1,331.2,766.9,273.4z M551.2,241.4c-4,11.2-8.3,13.8-29.9,17.8C532.4,250.7,541,245.2,551.2,241.4z"/>
	</g>
</g>
</svg>`,
  demo: `<svg viewBox="0 0 850.4 850.4" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
<g>
	<path d="M784.7,424.3c0,96-35.8,180.2-107.4,252.5C605.7,749.1,522,785.2,426.1,785.2c-97.7,0-182.2-35.7-253.5-107.1
		c-71.3-71.4-107-156-107-253.8c0-96,35.6-179.8,107-251.5c71.3-71.7,154.9-107.6,250.8-107.6c97.7,0,182.3,35.6,253.9,106.7
		C748.9,242.9,784.7,327.1,784.7,424.3z M171.7,366.4l-32.4-8.1c4.2-17.4,9.9-34.4,17.1-51.2l-18.9-10.8
		c-18.6,41.3-27.8,84.5-27.8,129.4c0,43.7,9,86.3,27,127.6l19.8-11.7c-8.4-19.2-14.7-38.6-18.9-58.4l33.3-6.3
		c-3.6-16.8-5.4-34.1-5.4-52.1C165.4,408,167.5,388.5,171.7,366.4z M391.9,738.5v-23.4c-20.4-2.4-40.2-6.3-59.3-11.7l10.8-32.4
		c-36-12-67.7-30.9-95.3-56.6h-0.9l-22.5,25.2c-13.2-12.6-24.9-26-35-40.4L170,610.9C225.1,686.3,299.1,728.9,391.9,738.5z
		 M391.9,133.5v-23.4c-91.7,10.2-165.4,53-221.1,128.5l18.9,10.8c12-15.6,25.5-30.3,40.5-44l22.5,24.3
		c24.6-19.2,56.9-37.1,97.1-53.9l-9.9-32.4C356.6,138.6,374,135.3,391.9,133.5z M630.1,355.5c-8.4-24.6-21.9-47.6-40.5-69.2
		l-76.4,63.8c-16.8-20.5-38.4-33.8-64.7-39.8l19.8-97.7c-14.4-3-28.8-4.5-43.1-4.5c-13.2,0-25.8,0.9-37.8,2.7l18,98.6
		c-26.4,5.4-48.8,18.4-67.4,38.9l-74.6-66.5c-18,20.4-31.5,43.1-40.4,68.3l92.6,34.2c-4.2,13.2-6.3,26.7-6.3,40.4
		c0,13.2,1.8,25.8,5.4,37.8l-94.4,30.6c9,25.8,22.5,49.1,40.4,70.1l74.6-63.8c18,21,40.1,34.2,66.5,39.5L382.1,636
		c14.4,3,28.8,4.5,43.1,4.5c12.6,0,25.2-1.2,37.8-3.6l-18-98c26.4-4.8,48.8-17.4,67.4-37.8l74.6,66.5c17.4-19.8,30.9-42.8,40.5-69.2
		l-92.6-34.2c4.2-12.6,6.3-25.5,6.3-38.7c0-13.2-2.1-25.8-6.3-37.8L630.1,355.5z M679.6,238.7C623.8,163.8,550.1,121.2,458.5,111
		v22.5c20.4,2.4,40.1,6.9,59.3,13.5L507,177.6c9,4.2,41,23.1,96.2,56.6l22.5-23.4c12.6,12.6,24.3,26.1,35.1,40.4L679.6,238.7z
		 M679.8,610.5l-19.1-11.3c-12,16.2-25.5,30.8-40.4,44l-22.5-24.3c-32.4,30-64.7,48.2-97.1,54.8l9.9,30.6
		c-17.4,5.4-34.8,9-52.1,10.8v22.5C550.8,727.9,624.6,685.6,679.8,610.5z M740.7,425.6c0-43.7-9.3-86.9-27.9-129.4L694,307
		c7.8,19.2,13.8,39,18,59.3l-32.4,6.3c3,12.6,4.5,25.2,4.5,37.8c0,3.6-1.8,27.9-5.4,72.8l32.4,8.1c-3.6,17.4-9.3,34.2-17.1,50.3
		l19.8,11.7C731.7,511.9,740.7,469.4,740.7,425.6z"/>
</g>
</svg>`,
};

function feedRowHtml(item) {
  const date = new Date(item.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  let text;
  let sub = "";
  let accent = "var(--primary)";
  if (item.type === "match") {
    text = `<b>Match #${escapeHtml(item.ordinal)}</b> logged &mdash; <span style="color: var(--team-red)">Red ${escapeHtml(item.redScore)}</span> : <span style="color: var(--team-blue)">${escapeHtml(item.blueScore)} Blue</span>`;
    sub = `${escapeHtml(item.playerCount)} players`;
  } else if (item.type === "crest") {
    accent = RARITY_COLORS[item.entry.rarity] ?? "var(--primary)";
    text = `<b>${escapeHtml(item.entry.playerName)}</b> earned <span style="color: ${accent}">${escapeHtml(item.entry.title)}</span>`;
    sub = escapeHtml(item.entry.rarity ?? "");
  } else {
    text = `New demo: <b>${escapeHtml(item.title)}</b>${item.uploaderName ? ` by ${escapeHtml(item.uploaderName)}` : ""}`;
    sub = escapeHtml(item.gametype ?? "");
  }
  return `<div class="feed-row" style="--feed-accent: ${accent}">
    <span class="feed-row-icon">${FEED_ICONS[item.type] ?? ""}</span>
    <span class="feed-row-main">
      <span class="feed-row-text">${text}</span>
      ${sub ? `<span class="feed-row-sub">${sub}</span>` : ""}
    </span>
    <span class="feed-row-date">${date}</span>
  </div>`;
}

// Both feeds are kicked off from render, which can run several times before
// the first answer is back - one request each is plenty.
let activityFeedLoading = false;
let recentVideosLoading = false;

async function loadActivityFeed() {
  if (activityFeedLoading) return;
  activityFeedLoading = true;
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(`${SORACLE_BASE}/api/activity-feed`);
    const data = await res.json();
    activityFeed = data.activityFeed;
  } catch (err) {
    activityFeedError = String(err);
  }
  activityFeedLoading = false;
  if (selected === "__ctf__") scheduleMainRender();
}

async function loadRecentVideos() {
  if (recentVideosLoading) return;
  recentVideosLoading = true;
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(`${SORACLE_BASE}/api/recent-videos`);
    const data = await res.json();
    recentVideos = data.videos ?? [];
  } catch {
    recentVideos = [];
  }
  recentVideosLoading = false;
  if (selected === "__ctf__") scheduleMainRender();
}

function recentVideoCardHtml(video) {
  const id = encodeURIComponent(video.videoId ?? "");
  const thumb = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  const url = `https://www.youtube.com/watch?v=${id}`;
  return `
    <a class="highlight-card" href="${url}" target="_blank" rel="noopener">
      <img src="${thumb}" alt="">
      <span class="highlight-card-play">&#9654;</span>
      <span class="highlight-card-label">${escapeHtml(video.title || "Watch")}</span>
    </a>
  `;
}

function renderRecentHighlightsBlock() {
  if (recentVideos === undefined) {
    loadRecentVideos();
    return "";
  }
  if (recentVideos.length === 0) return "";
  return `
    <p class="home-feed-label">Recent Highlights</p>
    <div class="highlight-strip-wrap">
      <button class="highlight-scroll-btn highlight-scroll-left" id="highlight-scroll-left" aria-label="Scroll left">&#8249;</button>
      <div class="highlight-strip" id="highlight-strip">${recentVideos.map(recentVideoCardHtml).join("")}</div>
      <button class="highlight-scroll-btn highlight-scroll-right" id="highlight-scroll-right" aria-label="Scroll right">&#8250;</button>
    </div>
  `;
}

const modeMessages = {}; // mode id -> "Launching..." or an error, shown on its banner

// Install state arrives a moment after launch (see refreshModStates) -
// until then, say so rather than flash "isn't installed" and an Install
// button at someone who has it installed.
function modeChecking(mode) {
  return modSupportedOnCurrentPlatform(mode.client) && modState[mode.client] === undefined;
}

function clientDisplayName(name) {
  return mods.find((m) => m.name === name)?.displayName ?? name;
}

function modeMetaText(mode, client) {
  if (modeMessages[mode.id]) return modeMessages[mode.id];
  if (modeChecking(mode)) return "Checking...";
  if (!client) return `Not available on ${currentPlatform === "macos" ? "macOS" : currentPlatform}`;
  if (!modState[client]?.installed) return `${escapeHtml(clientDisplayName(client))} isn't installed yet`;
  let text;
  if (mode.singlePlayer) {
    text = "Single-player";
  } else {
    const server = modeServers[mode.id];
    if (!server) {
      text = "No server picked &middot; opens the main menu";
    } else {
      const status = serverStatusCache[server];
      if (status === undefined) loadServerStatus(server);
      text = !status
        ? `${server} &middot; checking...`
        : status.error
          ? `${server} &middot; unreachable right now`
          : `${escapeHtml(stripQuakeColors(status.hostname))} &middot; ${escapeHtml(status.map)} &middot; ${status.players.length}/${status.max_clients} players`;
    }
  }
  return text;
}

// Shared by the Home banners and the CTF page's own Play CTF button.
function modePlayButtonHtml(mode, label = "Play") {
  const client = modeClient(mode);
  if (!client || modeChecking(mode)) {
    return `<button class="mode-play-btn" disabled>${label}</button>`;
  }
  if (!modState[client]?.installed) {
    // Not installed: take them to the client's page, where Install lives.
    return `<button class="mode-play-btn mode-play-btn--install" data-mode-install="${client}">Install</button>`;
  }
  return `<button class="mode-play-btn" data-mode-play="${mode.id}">${label}</button>`;
}

function modeBannerHtml(mode) {
  const client = modeClient(mode);
  const button = modePlayButtonHtml(mode);
  const gear = mode.singlePlayer
    ? ""
    : `<button class="mode-gear-btn" data-mode-server="${mode.id}" title="Choose a server" aria-label="Choose a server for ${mode.title}">⚙</button>`;
  return `
    <div class="mode-banner">
      <img class="mode-banner-img" src="assets/banners/${mode.client.toLowerCase()}.jpg" alt="" data-on-error="remove">
      <div class="mode-banner-text">
        <h3 class="mode-banner-title">${mode.title}</h3>
        <p class="mode-banner-meta">${modeMetaText(mode, client)}</p>
      </div>
      <div class="mode-banner-actions">${button}${gear}</div>
    </div>`;
}

// Resolves the picked address, "" for no server (open the main menu), or
// null if cancelled.
function pickModeServer(mode) {
  const current = modeServers[mode.id] ?? "";
  // Every known/favorited address, plus the current pick even if it's since
  // fallen off both lists (or was typed in) - never silently drop it.
  const listed = Array.from(new Set([...getFavoriteServers(), ...allServers(), ...(current ? [current] : [])]));
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-dialog--wide">
        <h3 class="confirm-title">${mode.title.replace(/ \(.*\)$/, "")} server</h3>
        <label class="pinned-edit-field">
          <span>Play joins</span>
          <select class="mode-server-select">
            <option value="" ${current ? "" : "selected"}>No server - open the main menu</option>
            ${listed.map((addr) => `<option value="${addr}" ${addr === current ? "selected" : ""}>${escapeHtml(serverDisplayName(addr))}</option>`).join("")}
          </select>
        </label>
        <label class="pinned-edit-field">
          <span>Or enter an address</span>
          <input type="text" class="mode-server-input" placeholder="123.45.67.89:28070" spellcheck="false" autocomplete="off">
        </label>
        <p class="dialog-error"></p>
        <div class="confirm-actions">
          <button class="confirm-cancel-btn">Cancel</button>
          <button class="confirm-ok-btn">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".mode-server-input");
    const errorEl = overlay.querySelector(".dialog-error");

    // Servers nobody has looked at yet show as bare addresses - look them up
    // and swap their names in as answers arrive.
    for (const option of overlay.querySelectorAll(".mode-server-select option[value]:not([value=''])")) {
      if (serverStatusCache[option.value] !== undefined) continue;
      loadServerStatus(option.value).then(() => {
        option.textContent = serverDisplayName(option.value);
      });
    }

    function finish(result) {
      overlay.remove();
      resolve(result);
    }
    function save() {
      const typed = input.value.trim();
      if (typed && !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(typed)) {
        errorEl.textContent = "Enter it as host:port, like 123.45.67.89:28070";
        return;
      }
      finish(typed || overlay.querySelector(".mode-server-select").value);
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
    overlay.querySelector(".confirm-cancel-btn").addEventListener("click", () => finish(null));
    overlay.querySelector(".confirm-ok-btn").addEventListener("click", save);
  });
}

async function chooseModeServer(modeId) {
  const mode = GAME_MODES.find((m) => m.id === modeId);
  const picked = await pickModeServer(mode);
  if (picked === null) return;
  modeServers[modeId] = picked || null;
  saveModeServers();
  renderMain();
}

async function playMode(modeId) {
  const mode = GAME_MODES.find((m) => m.id === modeId);
  const client = modeClient(mode);
  if (!client || !modState[client]?.installed) return;
  const { invoke } = window.__TAURI__.core;
  const handler = MOD_HANDLERS[client];
  modeMessages[modeId] = "Launching...";
  renderMain();
  try {
    // play_openjo takes no address; the others treat a missing one as
    // "just open the game".
    await invoke(handler.playCommand, mode.singlePlayer ? {} : { connectAddress: modeServers[modeId] ?? null });
    modeMessages[modeId] = "";
  } catch (err) {
    modeMessages[modeId] = `Error: ${escapeHtml(String(err))}`;
  }
  renderMain();
}

// One thin row per favorite, all sharing a single card - was one big
// bordered/glowing "hero" bar per favorite, which multiplied into real
// clutter once more than one favorite existed.
function favoriteServerRowHtml(address) {
  const data = serverStatusCache[address];
  if (data === undefined) {
    loadServerStatus(address);
    return `<div class="favorite-row"><p class="detail-status">Checking...</p></div>`;
  }
  if (data.error) {
    return `
      <div class="favorite-row">
        <span class="favorite-play-btn favorite-play-btn--disabled">Offline</span>
        <span class="favorite-row-name">${escapeHtml(address)}</span>
        <span class="favorite-row-meta">Unreachable right now</span>
        <button class="server-favorite-btn active" data-address="${escapeHtml(address)}" title="Remove favorite">★</button>
      </div>`;
  }
  const installedJoinable = JOINABLE_CLIENTS.filter((name) => modState[name]?.installed);
  const nameHtml = `<span class="favorite-row-name">${serverText(data.hostname)}</span>`;
  let playHtml;
  let selectHtml = "";
  if (installedJoinable.length === 0) {
    playHtml = `<span class="favorite-play-btn favorite-play-btn--disabled">Install a client</span>`;
  } else if (installedJoinable.length === 1) {
    playHtml = `<button class="favorite-play-btn server-join-btn" data-address="${escapeHtml(address)}" data-client="${installedJoinable[0]}">Play</button>`;
  } else {
    // More than one option installed - let them pick, same control as the
    // Servers page, instead of silently guessing which one they meant. The
    // select sits after the server name (not next to the button) so the
    // server you're looking at reads first; .closest(".favorite-row") in
    // the click handler still finds it regardless of where it sits in the row.
    playHtml = `<button class="favorite-play-btn server-join-btn" data-address="${escapeHtml(address)}">Play</button>`;
    selectHtml = `
      <select class="server-client-select">
        ${installedJoinable.map((name) => `<option value="${name}">${escapeHtml(clientDisplayName(name))}</option>`).join("")}
      </select>`;
  }
  return `
    <div class="favorite-row">
      ${playHtml}
      ${nameHtml}
      ${selectHtml}
      <span class="favorite-row-meta">${escapeHtml(data.map)} &middot; ${escapeHtml(data.players.length)}/${escapeHtml(data.max_clients)} players</span>
      <button class="server-favorite-btn active" data-address="${escapeHtml(address)}" title="Remove favorite">★</button>
      ${serverJoinMessage[address] ? `<p class="detail-status">${escapeHtml(serverJoinMessage[address])}</p>` : ""}
    </div>`;
}

function favoriteServerBlocksHtml() {
  const addresses = getFavoriteServers();
  if (addresses.length === 0) return "";
  return `<div class="favorites-card">${addresses.map(favoriteServerRowHtml).join("")}</div>`;
}

function renderHomeView(mainEl) {
  const welcome = session
    ? `<div class="home-welcome"><h2>Welcome back, ${escapeHtml(session.name)}</h2></div>`
    : `<div class="home-welcome"><h2>Welcome to JK2 Launcher</h2></div>`;
  mainEl.innerHTML = `
    ${welcome}
    <p class="home-strap">Play and install community-verified clients for Jedi Knight II: Jedi Outcast.</p>
    <div class="mode-banners">${GAME_MODES.map(modeBannerHtml).join("")}</div>
  `;
}

// Everything JK2CTF: your stats once signed in, the highlight reel and what
// the playerbase has been up to.
function renderCtfView(mainEl) {
  const ctfMod = mods.find((m) => m.name === "NWH");
  const ctfMode = GAME_MODES.find((m) => m.id === "ctf");
  const accountHtml = session
    ? `<p class="home-feed-label">Your Stats</p>${ctfMod ? renderStatsBlock(ctfMod) : ""}`
    : `<div class="home-login-prompt">
         <p>Sign in with your JK2CTF player account to see your stats.</p>
         <form id="soracle-login-form" class="login-form">
           <input name="name" placeholder="Player name" autocomplete="username" required>
           <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
           <button type="submit">Sign in</button>
           <p class="login-error" id="login-error"></p>
         </form>
       </div>`;

  let feedHtml;
  if (activityFeedError) {
    feedHtml = `<p class="detail-status">Couldn't load activity: ${escapeHtml(activityFeedError)}</p>`;
  } else if (!activityFeed) {
    feedHtml = `<p class="detail-status">Loading...</p>`;
    loadActivityFeed();
  } else if (activityFeed.length === 0) {
    feedHtml = `<p class="detail-status">No recent activity.</p>`;
  } else {
    feedHtml = `<div class="feed-list">${activityFeed.map(feedRowHtml).join("")}</div>`;
  }

  mainEl.innerHTML = `
    <div class="detail-header"><h2>Capture The Flag</h2></div>
    <p class="detail-description">Organised Capture the Flag on JK2CTF - your stats, the latest highlights, and what the playerbase has been up to.</p>
    <div class="ctf-play-row">
      ${modePlayButtonHtml(ctfMode, "Play CTF")}
      <span class="ctf-play-meta">${modeMetaText(ctfMode, modeClient(ctfMode))}</span>
      <a class="ctf-site-btn" href="${SORACLE_BASE}" target="_blank" rel="noopener">Visit JK2CTF.com <span aria-hidden="true">&#8599;</span></a>
    </div>
    ${accountHtml}
    ${renderRecentHighlightsBlock()}
    <p class="home-feed-label">Recent Activity</p>
    ${feedHtml}
  `;
}

// Strips idTech3 caret color codes and raw control bytes some
// servers throw into their hostname/player names (seen in the wild as
// literal \x01 bytes, presumably an old anti-spoof or client-specific trick)
// - both render as garbled box glyphs otherwise.
function stripQuakeColors(s) {
  // JK2 reads ^ plus any character but another ^ as a color code - not just
  // ^0-^9 (NWH New Jersey's hostname uses ^_).
  return (s ?? "").replace(/\^[^^]/g, "").replace(/[\x00-\x1f]/g, "");
}

const serverStatusLoading = new Set(); // addresses with a query already in flight

// Shared by the Home mode banners and the Servers page - a single
// address, queried directly and cached until the app restarts or Refresh
// clears it.
async function loadServerStatus(address) {
  if (serverStatusLoading.has(address)) return;
  serverStatusLoading.add(address);
  try {
    const { invoke } = window.__TAURI__.core;
    serverStatusCache[address] = await invoke("query_server_status", { address });
  } catch (err) {
    serverStatusCache[address] = { error: String(err) };
  } finally {
    serverStatusLoading.delete(address);
  }
  // Re-render wherever this result is actually shown, regardless of which
  // view triggered the load in the first place.
  if (selected === "__home__" || selected === "__ctf__" || selected === "__servers__") scheduleMainRender();
}

async function joinServer(clientName, address) {
  const handler = MOD_HANDLERS[clientName];
  const { invoke } = window.__TAURI__.core;
  serverJoinMessage[address] = "Launching...";
  renderMain();
  try {
    await invoke(handler.playCommand, { connectAddress: address });
    serverJoinMessage[address] = "";
  } catch (err) {
    serverJoinMessage[address] = `Error: ${err}`;
  }
  renderMain();
}

const expandedServers = new Set(); // addresses currently expanded in the Servers list

function serverRowHtml(data) {
  const isFavorite = isFavoriteServer(data.address);
  const atFavoriteLimit = !isFavorite && getFavoriteServers().length >= MAX_FAVORITE_SERVERS;
  const isExpanded = expandedServers.has(data.address);
  const favoriteTitle = isFavorite
    ? "Remove favorite"
    : atFavoriteLimit
      ? `Up to ${MAX_FAVORITE_SERVERS} favorites - remove one first`
      : "Set as favorite";
  const summaryHtml = `
    <div class="server-row-summary" data-address="${escapeHtml(data.address)}">
      <button class="server-favorite-btn ${isFavorite ? "active" : ""}" data-address="${escapeHtml(data.address)}" title="${favoriteTitle}" ${atFavoriteLimit ? "disabled" : ""}>${isFavorite ? "★" : "☆"}</button>
      <span class="server-row-name">${serverText(data.hostname)}</span>
      <span class="server-row-map">${escapeHtml(data.map)}</span>
      <span class="server-row-players">${escapeHtml(data.players.length)}/${escapeHtml(data.max_clients)}</span>
      <span class="server-row-ping">${escapeHtml(data.ping_ms)}ms</span>
      <span class="server-row-caret">${isExpanded ? "▾" : "▸"}</span>
    </div>`;
  const removeHtml = isCustomServer(data.address)
    ? `<button class="server-remove-btn" data-address="${escapeHtml(data.address)}">Remove from list</button>`
    : "";
  if (!isExpanded) {
    return `<div class="server-row">${summaryHtml}</div>`;
  }
  const installedJoinable = JOINABLE_CLIENTS.filter((name) => modState[name]?.installed);
  const joinHtml =
    installedJoinable.length === 0
      ? `<p class="detail-status">Install NWH, Tommyternal or JK2MV to join this server.</p>`
      : `<div class="server-join">
          <select class="server-client-select">
            ${installedJoinable.map((name) => `<option value="${name}">${escapeHtml(clientDisplayName(name))}</option>`).join("")}
          </select>
          <button class="server-join-btn" data-address="${escapeHtml(data.address)}">Join</button>
        </div>`;
  const playerRows = data.players.length
    ? data.players
        .map((p) => `<li><span>${serverText(p.name)}</span><span class="server-player-score">${escapeHtml(p.score)}</span></li>`)
        .join("")
    : `<li class="server-empty">No players connected</li>`;
  return `
    <div class="server-row expanded">
      ${summaryHtml}
      <div class="server-row-details">
        <p class="server-meta">${escapeHtml(data.address)}</p>
        <ul class="server-player-list">${playerRows}</ul>
        ${joinHtml}
        <p class="detail-status">${escapeHtml(serverJoinMessage[data.address] ?? "")}</p>
        ${removeHtml}
      </div>
    </div>`;
}

// A server someone added that isn't answering. Unlike a maintained one,
// it's listed anyway: hiding it would look like the add didn't work, and
// leave no way to remove a typo.
function unreachableCustomServerRowHtml(address) {
  return `
    <div class="server-row server-row--unreachable">
      <div class="server-row-static">
        <span></span>
        <span class="server-row-name">${escapeHtml(address)}</span>
        <span class="server-row-map">Not responding</span>
        <span class="server-row-players"></span>
        <span class="server-row-ping"></span>
        <button class="server-remove-btn server-remove-btn--inline" data-address="${escapeHtml(address)}" title="Remove from list">×</button>
      </div>
    </div>`;
}

function renderServersView(mainEl) {
  const resolved = [];
  const unreachableCustom = [];
  let pending = 0;
  for (const address of allServers()) {
    const data = serverStatusCache[address];
    if (data === undefined) {
      pending++;
      loadServerStatus(address);
    } else if (!data.error) {
      resolved.push({ ...data, address });
    } else if (isCustomServer(address)) {
      unreachableCustom.push(address);
    }
  }
  resolved.sort((a, b) => b.players.length - a.players.length);

  let listHtml;
  if (resolved.length === 0 && unreachableCustom.length === 0) {
    listHtml = `<p class="detail-status">${pending > 0 ? "Querying known servers..." : "None of the known servers are online right now."}</p>`;
  } else {
    listHtml = `
      <div class="server-list-header">
        <span class="server-favorite-btn"></span>
        <span class="server-row-name">Server</span>
        <span class="server-row-map">Map</span>
        <span class="server-row-players">Players</span>
        <span class="server-row-ping">Ping</span>
        <span class="server-row-caret"></span>
      </div>
      <div class="server-list">${resolved.map(serverRowHtml).join("")}${unreachableCustom.map(unreachableCustomServerRowHtml).join("")}</div>
      ${pending > 0 ? `<p class="detail-status">Querying ${pending} more...</p>` : ""}`;
  }
  const addInputFocused = document.activeElement?.id === "server-add-input";
  mainEl.innerHTML = `
    <div class="detail-header">
      <h2>Servers</h2>
      <button class="server-refresh-btn" id="server-refresh-btn">Refresh</button>
    </div>
    <p class="detail-description">Known JK2 1.02 community servers, queried directly - star a favorite to keep it pinned up top for a one-click join, click a row for details.</p>
    ${favoriteServerBlocksHtml()}
    <div class="server-add">
      <input class="server-add-input" id="server-add-input" type="text" placeholder="Add a server - e.g. 1.2.3.4:28070" spellcheck="false" autocomplete="off" value="${escapeHtml(addServerDraft)}" />
      <button class="server-refresh-btn" id="server-add-btn">Add server</button>
    </div>
    ${addServerMessage ? `<p class="detail-status">${escapeHtml(addServerMessage)}</p>` : ""}
    ${listHtml}
  `;
  if (addInputFocused) {
    const input = document.getElementById("server-add-input");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function faqEntryHtml(e) {
  return `<div class="faq-entry"><p class="faq-q">${e.q}</p><p class="faq-a">${e.a}</p></div>`;
}

// Grouped under the two headings from jk2ctf.com/faq (Launcher, Account)
// rather than one flat list, in FAQ_ENTRIES' own order within each group -
// mirrors the real site's structure instead of a run-on list with no
// signal for "this next question is about something completely different."
function renderFaqView(mainEl) {
  const sections = ["Launcher", "Account"];
  const sectionsHtml = sections
    .map((section) => {
      const entries = FAQ_ENTRIES.filter((e) => e.section === section);
      if (!entries.length) return "";
      return `
        <p class="home-feed-label">${section}</p>
        <div class="faq-list">${entries.map(faqEntryHtml).join("")}</div>`;
    })
    .join("");
  mainEl.innerHTML = `
    <span class="footer-nav-link" id="back-to-home-link">&larr; Back to Home</span>
    <div class="detail-header"><h2>Support / FAQ</h2></div>
    ${sectionsHtml}
    <div class="faq-update-row">
      <span class="faq-update-info">JK2 Launcher v0.1 preview</span>
      <button class="faq-update-btn" id="faq-update-btn">${updateLabelText}</button>
    </div>
  `;
}

async function loadPk3Mods() {
  try {
    const { invoke } = window.__TAURI__.core;
    pk3Mods = await invoke("list_pk3_mods");
  } catch (err) {
    pk3ModsError = String(err);
  }
  if (selected === "__mods__") renderMain();
}

function setPk3Status(message) {
  const el = document.getElementById("pk3-status");
  if (el) el.textContent = message;
}

// Re-rendering swaps #main's whole innerHTML, which resets scroll to the top
// - fine when navigating somewhere new, jarring when the user just toggled a
// checkbox deep in a long list. Used anywhere the Mods view refreshes itself
// in place rather than the user switching to a different screen.
function renderMainPreservingScroll() {
  const mainEl = document.getElementById("main");
  const scrollTop = mainEl.scrollTop;
  renderMain();
  mainEl.scrollTop = scrollTop;
}

// For results that arrive on their own schedule - server replies, feeds,
// stats. Fourteen server replies landing over a few hundred ms used to mean
// fourteen full rebuilds of the page. Now the first shows straight away and
// the rest share one rebuild every 250ms, scroll position kept.
const MAIN_RENDER_INTERVAL_MS = 250;
let mainRenderTimer = null;
let lastMainRender = 0;
function scheduleMainRender() {
  if (mainRenderTimer) return;
  const wait = Math.max(0, MAIN_RENDER_INTERVAL_MS - (performance.now() - lastMainRender));
  mainRenderTimer = setTimeout(() => {
    mainRenderTimer = null;
    lastMainRender = performance.now();
    renderMainPreservingScroll();
  }, wait);
}

async function addPk3Mods() {
  const { invoke } = window.__TAURI__.core;
  try {
    const paths = await invoke("pick_pk3_files");
    if (!paths.length) return;
    for (const path of paths) {
      await invoke("add_pk3_mod", { sourcePath: path });
    }
    pk3Mods = null;
    renderMainPreservingScroll();
  } catch (err) {
    setPk3Status(`Error: ${err}`);
  }
}

async function togglePk3Target(filename, target, checked) {
  const mod = pk3Mods.find((m) => m.filename === filename);
  if (!mod) return;
  let targets;
  if (target === "all") {
    targets = checked ? ["all"] : [];
  } else {
    targets = mod.targets.filter((t) => t !== "all");
    targets = checked ? [...new Set([...targets, target])] : targets.filter((t) => t !== target);
  }
  const newlyBroken = mod.replaces_menus
    ? ownMenuClientsIn(targets).filter((id) => !ownMenuClientsIn(mod.targets).includes(id))
    : [];
  if (newlyBroken.length) {
    const names = newlyBroken.map((id) => escapeHtml(clientLabel(id))).join(" and ");
    const confirmed = await showConfirmDialog({
      title: "Replace the menus?",
      message: `${escapeHtml(mod.filename)} replaces the multiplayer menus. ${names} ${newlyBroken.length === 1 ? "has" : "have"} ${newlyBroken.length === 1 ? "its" : "their"} own and usually won't start with it ("Error during initialization").`,
      confirmLabel: "Add anyway",
      danger: true,
    });
    if (!confirmed) {
      renderMainPreservingScroll();
      return;
    }
  }
  try {
    const { invoke } = window.__TAURI__.core;
    await invoke("set_pk3_mod_targets", { filename, targets });
    mod.targets = targets;
    renderMainPreservingScroll();
  } catch (err) {
    setPk3Status(`Error: ${err}`);
  }
}

async function removePk3Mod(filename) {
  try {
    const { invoke } = window.__TAURI__.core;
    await invoke("remove_pk3_mod", { filename });
    pk3Mods = pk3Mods.filter((m) => m.filename !== filename);
    renderMainPreservingScroll();
  } catch (err) {
    setPk3Status(`Error: ${err}`);
  }
}

function pk3RowHtml(mod) {
  const isAll = mod.targets.includes("all");
  const filename = escapeHtml(mod.filename);
  const allCheckbox = `<label class="pk3-target"><input type="checkbox" data-filename="${filename}" data-target="all" ${isAll ? "checked" : ""}> All Clients</label>`;
  const clientCheckboxes = pk3TargetClients().map((c) => {
    const checked = !isAll && mod.targets.includes(c.id);
    return `<label class="pk3-target"><input type="checkbox" data-filename="${filename}" data-target="${c.id}" ${isAll ? "disabled" : ""} ${checked ? "checked" : ""}> ${escapeHtml(clientLabel(c.id))}</label>`;
  }).join("");
  const broken = mod.replaces_menus ? ownMenuClientsIn(mod.targets) : [];
  const menuFlag = mod.replaces_menus
    ? `<span class="pk3-flag${broken.length ? " pk3-flag--warn" : ""}" title="${broken.length
        ? `${broken.map((id) => clientLabel(id)).join(" and ")} won't start with this - untick ${broken.length === 1 ? "it" : "them"}.`
        : "Swaps out the stock multiplayer menus, so it's kept off clients that have their own."}">${broken.length ? `Breaks ${escapeHtml(broken.map((id) => clientLabel(id)).join(", "))}` : "Replaces menus"}</span>`
    : "";
  return `
    <div class="pk3-row">
      <span class="pk3-name-col"><span class="pk3-name">${filename}</span>${menuFlag}</span>
      <div class="pk3-targets">${allCheckbox}${clientCheckboxes}</div>
      <button class="pk3-remove-btn" data-filename="${filename}">Remove</button>
    </div>
  `;
}

const MONOLITH_API = "https://jk2t.ddns.net/modmanager/api.php";
const MONOLITH_USER_AGENT = "Monolith-App-Client/1.0.7";
const MONOLITH_RESULTS_LIMIT = 60;

let monolithCatalog = undefined; // undefined = not loaded, array once loaded, or { error }
let monolithSearch = "";
let monolithPage = 0;

async function loadMonolithCatalog() {
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(MONOLITH_API, { headers: { "User-Agent": MONOLITH_USER_AGENT } });
    const data = await res.json();
    monolithCatalog = Array.isArray(data) ? data : { error: data.message || "Unexpected response" };
  } catch (err) {
    monolithCatalog = { error: String(err) };
  }
  const resultsEl = document.getElementById("monolith-results");
  if (resultsEl) resultsEl.innerHTML = renderMonolithResults();
}

async function downloadMonolithMod(url, filename, btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Downloading...";
  try {
    const { fetch } = window.__TAURI__.http;
    const { writeFile, mkdir, BaseDirectory } = window.__TAURI__.fs;
    const { invoke } = window.__TAURI__.core;
    await mkdir("pk3_downloads", { baseDir: BaseDirectory.AppData, recursive: true });
    const res = await fetch(url, { headers: { "User-Agent": MONOLITH_USER_AGENT } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const relativePath = `pk3_downloads/${filename}`;
    await writeFile(relativePath, bytes, { baseDir: BaseDirectory.AppData });
    await invoke("add_pk3_mod_from_download", { relativePath });
    pk3Mods = null;
    renderMainPreservingScroll();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalText;
    setPk3Status(`Error downloading ${filename}: ${err}`);
  }
}

function monolithCardHtml(mod) {
  const filename = mod.download_url.split("/").pop();
  const thumb = mod.preview_image
    ? `<img class="monolith-thumb" src="${safeHttpUrl(mod.preview_image)}" alt="" data-on-error="hide">`
    : `<div class="monolith-thumb monolith-thumb-empty"></div>`;
  return `
    <div class="monolith-card">
      ${thumb}
      <div class="monolith-info">
        <p class="monolith-name">${escapeHtml(mod.name)}</p>
        <p class="monolith-meta">${escapeHtml(mod.author || "Unknown")} &middot; ${mod.category ? escapeHtml(mod.category) : "&mdash;"} &middot; ${escapeHtml(mod.size || "")}</p>
      </div>
      <button class="monolith-download-btn" data-url="${escapeHtml(mod.download_url)}" data-filename="${escapeHtml(filename)}">Download</button>
    </div>
  `;
}

function renderMonolithResults() {
  if (monolithCatalog === undefined) {
    loadMonolithCatalog();
    return `<p class="detail-status">Loading catalog...</p>`;
  }
  if (monolithCatalog.error) {
    return `<p class="detail-status">Couldn't load the community catalog: ${monolithCatalog.error}</p>`;
  }
  const term = monolithSearch.trim().toLowerCase();
  const matches = term
    ? monolithCatalog.filter(
        (m) =>
          m.name?.toLowerCase().includes(term) ||
          m.author?.toLowerCase().includes(term) ||
          m.category?.toLowerCase().includes(term)
      )
    : monolithCatalog;
  if (!matches.length) return `<p class="detail-status">No mods match "${escapeHtml(monolithSearch)}".</p>`;

  const totalPages = Math.ceil(matches.length / MONOLITH_RESULTS_LIMIT);
  monolithPage = Math.min(monolithPage, totalPages - 1);
  const start = monolithPage * MONOLITH_RESULTS_LIMIT;
  const shown = matches.slice(start, start + MONOLITH_RESULTS_LIMIT);

  const pagerHtml =
    totalPages > 1
      ? `<div class="monolith-pager">
           <button id="monolith-prev-page" ${monolithPage === 0 ? "disabled" : ""}>&larr; Prev</button>
           <span class="monolith-pager-label">Page ${monolithPage + 1} of ${totalPages} &middot; ${matches.length} mods</span>
           <button id="monolith-next-page" ${monolithPage >= totalPages - 1 ? "disabled" : ""}>Next &rarr;</button>
         </div>`
      : `<p class="detail-status">${matches.length} mod${matches.length === 1 ? "" : "s"}</p>`;

  return `<div class="monolith-list">${shown.map(monolithCardHtml).join("")}</div>${pagerHtml}`;
}

function renderMonolithBrowser() {
  return `
    <p class="home-feed-label" style="margin-top: 2rem;">Browse Community Mods</p>
    <p class="monolith-credit">Thanks to Flate for hosting these mods at Monolith.</p>
    <input type="text" id="monolith-search" class="monolith-search-input" placeholder="Search by name, author, or category..." value="${escapeHtml(monolithSearch)}">
    <div id="monolith-results">${renderMonolithResults()}</div>
  `;
}

let installedModsSearch = "";
let installedModsClient = "all"; // or a PK3_CLIENTS id - a mod for All Clients shows under every one
let installedModsPage = 0;
const INSTALLED_MODS_PAGE_SIZE = 60;

function modForClient(mod, clientId) {
  return clientId === "all" || mod.targets.includes("all") || mod.targets.includes(clientId);
}

function renderInstalledModsResults() {
  const term = installedModsSearch.trim().toLowerCase();
  const matches = pk3Mods.filter(
    (m) => modForClient(m, installedModsClient) && (!term || m.filename.toLowerCase().includes(term))
  );
  if (!matches.length) {
    if (term) return `<p class="detail-status">No installed mods match "${escapeHtml(installedModsSearch)}".</p>`;
    return `<p class="detail-status">No mods are assigned to ${escapeHtml(clientLabel(installedModsClient))}.</p>`;
  }

  const totalPages = Math.ceil(matches.length / INSTALLED_MODS_PAGE_SIZE);
  installedModsPage = Math.min(installedModsPage, totalPages - 1);
  const start = installedModsPage * INSTALLED_MODS_PAGE_SIZE;
  const shown = matches.slice(start, start + INSTALLED_MODS_PAGE_SIZE);

  // Same pager markup/styling as the Monolith browser below it - no need
  // for a second set of pager styles for what's visually the same control.
  const pagerHtml =
    totalPages > 1
      ? `<div class="monolith-pager">
           <button id="installed-mods-prev-page" ${installedModsPage === 0 ? "disabled" : ""}>&larr; Prev</button>
           <span class="monolith-pager-label">Page ${installedModsPage + 1} of ${totalPages} &middot; ${matches.length} mods</span>
           <button id="installed-mods-next-page" ${installedModsPage >= totalPages - 1 ? "disabled" : ""}>Next &rarr;</button>
         </div>`
      : "";

  return `<div class="pk3-list">${shown.map(pk3RowHtml).join("")}</div>${pagerHtml}`;
}

function renderModsView(mainEl) {
  if (pk3ModsError) {
    mainEl.innerHTML = `<div class="detail-header"><h2>Mods</h2></div><p class="detail-status">Couldn't load mods: ${escapeHtml(pk3ModsError)}</p>`;
    return;
  }
  if (pk3Mods === null) {
    mainEl.innerHTML = `<div class="detail-header"><h2>Mods</h2></div><p class="detail-status">Loading...</p>`;
    loadPk3Mods();
    return;
  }
  // Same chips as Media: a client's chip shows the mods that client loads,
  // which includes everything assigned to All Clients.
  const clientChips = ["all", ...pk3TargetClients().map((c) => c.id)]
    .map((id) => {
      const count = pk3Mods.filter((m) => modForClient(m, id)).length;
      return `<button class="media-chip ${id === installedModsClient ? "active" : ""}" data-mods-client="${id}">${id === "all" ? "All clients" : escapeHtml(clientLabel(id))} <span class="media-chip-count">${count}</span></button>`;
    })
    .join("");
  const installedHtml = pk3Mods.length
    ? `<div class="media-chips">${clientChips}</div>
       <input type="text" id="installed-mods-search" class="monolith-search-input" placeholder="Search your installed mods..." value="${escapeHtml(installedModsSearch)}">
       <div id="installed-mods-results">${renderInstalledModsResults()}</div>`
    : `<p class="detail-status">No mods added yet.</p>`;
  mainEl.innerHTML = `
    <div class="detail-header"><h2>Mods</h2></div>
    <p class="detail-description">Drop in custom PK3s and choose which client(s) load them. Assign to a specific client to keep it isolated from the others, or to All Clients to apply it everywhere. Mods a client auto-downloads from a gameserver show up here too.</p>
    <button id="add-pk3-btn" class="change-folder">Add PK3...</button>
    <p class="detail-status" id="pk3-status"></p>
    ${installedHtml}
    ${renderMonolithBrowser()}
  `;
}

// --- Config: named presets of binds and settings, applied per client -------
// The Rust side owns the data (config_presets.json) and does the reading
// and writing; this is the list over it. Every command hands back the whole
// view, so each action is: call, store the result, re-render.

let configView = null; // from list_config_presets, or null while loading
let configError = null;
let configStatus = "";

async function loadConfigPresets() {
  try {
    const { invoke } = window.__TAURI__.core;
    configView = await invoke("list_config_presets");
    configError = null;
  } catch (err) {
    configError = String(err);
  }
  if (selected === "__config__") renderMainPreservingScroll();
}

function setConfigStatus(message) {
  configStatus = message;
  const el = document.getElementById("config-status");
  if (el) el.textContent = message;
}

async function configAction(command, args, busyMessage = "") {
  if (busyMessage) setConfigStatus(busyMessage);
  try {
    const { invoke } = window.__TAURI__.core;
    const result = await invoke(command, args);
    if (result === null) {
      // A cancelled file dialog.
      setConfigStatus("");
      return;
    }
    configView = result;
    configStatus = "";
    renderMainPreservingScroll();
  } catch (err) {
    setConfigStatus(`Error: ${err}`);
  }
}

// A small one-field dialog, same shell as the others. `submit` runs on
// Save and throws to keep the dialog open with its message shown.
function showTextDialog({ title, label, value, confirmLabel = "Save", multiline = false, submit }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog ${multiline ? "confirm-dialog--editor" : "confirm-dialog--wide"}">
        <h3 class="confirm-title">${escapeHtml(title)}</h3>
        <label class="pinned-edit-field">
          <span>${escapeHtml(label)}</span>
          ${multiline
            ? `<textarea class="dialog-textarea" spellcheck="false">${escapeHtml(value)}</textarea>`
            : `<input type="text" class="dialog-input" value="${escapeHtml(value)}" spellcheck="false" autocomplete="off">`}
        </label>
        <p class="dialog-error"></p>
        <div class="confirm-actions">
          <button class="confirm-cancel-btn">Cancel</button>
          <button class="confirm-ok-btn">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const field = overlay.querySelector(".dialog-input, .dialog-textarea");
    const errorEl = overlay.querySelector(".dialog-error");
    field.focus();
    if (!multiline) field.select();

    function finish(result) {
      overlay.remove();
      resolve(result);
    }
    async function save() {
      try {
        finish(await submit(field.value));
      } catch (err) {
        errorEl.textContent = String(err);
      }
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !multiline) save();
      if (e.key === "Escape") finish(null);
    });
    overlay.querySelector(".confirm-cancel-btn").addEventListener("click", () => finish(null));
    overlay.querySelector(".confirm-ok-btn").addEventListener("click", save);
  });
}

// "Preset 1", "Preset 2", ... - the lowest number not already taken.
function nextPresetName() {
  const taken = new Set(configView.presets.map((p) => p.name.toLowerCase()));
  for (let n = 1; ; n++) {
    if (!taken.has(`preset ${n}`)) return `Preset ${n}`;
  }
}

async function savePresetFromClient(clientId) {
  const { invoke } = window.__TAURI__.core;
  const view = await showTextDialog({
    title: `Save from ${clientLabel(clientId)}`,
    label: "Preset name",
    value: nextPresetName(),
    submit: (name) => invoke("save_preset_from_client", { clientId, name }),
  });
  if (!view) return;
  configView = view;
  renderMainPreservingScroll();
}

async function renameConfigPreset(id) {
  const preset = configView.presets.find((p) => p.id === id);
  if (!preset) return;
  const { invoke } = window.__TAURI__.core;
  const view = await showTextDialog({
    title: "Rename preset",
    label: "Name",
    value: preset.name,
    submit: (name) => invoke("rename_config_preset", { id, name }),
  });
  if (!view) return;
  configView = view;
  renderMainPreservingScroll();
}

async function editConfigPreset(id) {
  const preset = configView.presets.find((p) => p.id === id);
  if (!preset) return;
  const { invoke } = window.__TAURI__.core;
  let text;
  try {
    text = await invoke("get_preset_text", { id });
  } catch (err) {
    setConfigStatus(`Error: ${err}`);
    return;
  }
  const view = await showTextDialog({
    title: `Edit ${preset.name}`,
    label: "One bind or setting per line. Anything else is dropped on save.",
    value: text,
    multiline: true,
    submit: (edited) => invoke("set_preset_text", { id, text: edited }),
  });
  if (!view) return;
  configView = view;
  renderMainPreservingScroll();
}

async function deleteConfigPreset(id) {
  const preset = configView.presets.find((p) => p.id === id);
  if (!preset) return;
  const used = preset.applied_to.length;
  const confirmed = await showConfirmDialog({
    title: "Delete preset?",
    message: `${escapeHtml(preset.name)} will be deleted.${used ? ` The ${used === 1 ? "client" : `${used} clients`} using it will go back to ${used === 1 ? "its" : "their"} own settings.` : ""}`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;
  configAction("delete_config_preset", { id });
}

// A chip toggled on a preset's row: "all" means every client; a client
// chip adds or removes just that one.
function togglePresetClient(id, target, checked) {
  const preset = configView.presets.find((p) => p.id === id);
  if (!preset) return;
  let clients;
  if (target === "all") {
    clients = checked ? pk3TargetClients().map((c) => c.id) : [];
  } else {
    clients = preset.applied_to.filter((c) => c !== target);
    if (checked) clients.push(target);
  }
  configAction("assign_config_preset", { id, clients });
}

function presetCardHtml(preset) {
  const clients = pk3TargetClients();
  const all = clients.every((c) => preset.applied_to.includes(c.id));
  const chips = [
    `<label class="pk3-target"><input type="checkbox" data-preset-client="${preset.id}" data-target="all" ${all ? "checked" : ""}> All Clients</label>`,
    ...clients.map((c) => {
      const on = preset.applied_to.includes(c.id);
      return `<label class="pk3-target"><input type="checkbox" data-preset-client="${preset.id}" data-target="${c.id}" ${all ? "disabled" : ""} ${on ? "checked" : ""}> ${escapeHtml(clientLabel(c.id))}</label>`;
    }),
  ].join("");
  const counts = preset.controls_only
    ? `${preset.binds} binds`
    : `${preset.binds} binds, ${preset.settings} settings`;
  const origin = preset.source_client ? `Saved from ${escapeHtml(clientLabel(preset.source_client))}` : escapeHtml(preset.origin);
  return `
    <div class="preset-card">
      <div class="preset-head">
        <div class="preset-info">
          <p class="preset-name">${escapeHtml(preset.name)}</p>
          <p class="preset-meta">${origin} &middot; ${formatMediaDate(preset.updated)} &middot; ${counts}</p>
        </div>
        <div class="preset-actions">
          <label class="pk3-target preset-scope" title="Only the binds, for a client whose other settings shouldn't change"><input type="checkbox" data-preset-controls-only="${preset.id}" ${preset.controls_only ? "checked" : ""}> Controls only</label>
          ${preset.source_client ? `<button class="change-folder" data-preset-update="${preset.id}">Update</button>` : ""}
          <button class="change-folder" data-preset-rename="${preset.id}">Rename</button>
          <button class="change-folder" data-preset-edit="${preset.id}">Edit</button>
          <button class="pk3-remove-btn" data-preset-delete="${preset.id}">Delete</button>
        </div>
      </div>
      <div class="preset-chips"><span class="preset-chips-label">Applied to</span>${chips}</div>
    </div>`;
}

function renderConfigView(mainEl) {
  const header = `<div class="detail-header"><h2>Config</h2></div>
    <p class="detail-description">Save a client's binds and settings as a preset, or import a .cfg, then apply it to any client. Presets apply when a client is launched from here. Your clients' own config files are never edited.</p>`;
  if (configError) {
    mainEl.innerHTML = `${header}<p class="detail-status">Couldn't load presets: ${escapeHtml(configError)}</p>`;
    return;
  }
  if (configView === null) {
    mainEl.innerHTML = `${header}<p class="detail-status">Loading...</p>`;
    loadConfigPresets();
    return;
  }

  const sources = configView.clients.filter((c) => c.has_cfg && modSupportedOnCurrentPlatform(PK3_CLIENTS.find((p) => p.id === c.id)?.name));
  const saveFromHtml = sources.length
    ? sources.map((c) => `<button class="change-folder" data-preset-save-from="${c.id}">${escapeHtml(clientLabel(c.id))}</button>`).join("")
    : `<span class="detail-status">No client has saved a config yet - run one first.</span>`;
  const listHtml = configView.presets.length
    ? configView.presets.map(presetCardHtml).join("")
    : `<p class="detail-status">No presets yet.</p>`;

  mainEl.innerHTML = `
    ${header}
    <div class="preset-toolbar">
      <span class="preset-toolbar-label">Save from</span>
      ${saveFromHtml}
      <span class="preset-toolbar-sep"></span>
      <button class="change-folder" id="preset-import-btn">Import .cfg...</button>
    </div>
    <p class="detail-status" id="config-status">${escapeHtml(configStatus)}</p>
    <div class="preset-list">${listHtml}</div>
    <p class="detail-status preset-note">A client uses one preset at a time; applying one takes it off whichever preset had it. Launching from here always writes the preset first. For a client you start some other way, run <code>exec launcher_shared.cfg</code> in its console.</p>
  `;
}

// Returns true when the click belonged to the Config page.
function handleConfigClick(e) {
  const saveBtn = e.target.closest("[data-preset-save-from]");
  if (saveBtn) {
    savePresetFromClient(saveBtn.dataset.presetSaveFrom);
    return true;
  }
  if (e.target.closest("#preset-import-btn")) {
    configAction("import_config_preset", {}, "Choose a file...");
    return true;
  }
  const updateBtn = e.target.closest("[data-preset-update]");
  if (updateBtn) {
    configAction("update_preset_from_client", { id: updateBtn.dataset.presetUpdate }, "Reading...");
    return true;
  }
  const renameBtn = e.target.closest("[data-preset-rename]");
  if (renameBtn) {
    renameConfigPreset(renameBtn.dataset.presetRename);
    return true;
  }
  const editBtn = e.target.closest("[data-preset-edit]");
  if (editBtn) {
    editConfigPreset(editBtn.dataset.presetEdit);
    return true;
  }
  const deleteBtn = e.target.closest("[data-preset-delete]");
  if (deleteBtn) {
    deleteConfigPreset(deleteBtn.dataset.presetDelete);
    return true;
  }
  return false;
}

// --- Media: screenshots and demos from every client ---------------------------
// Where each client actually saves these is worked out on the Rust side
// (see list_media) - a single client can have them spread over base/, its
// launchermods_ folder and its own home folder, depending on when they were
// taken. Here it's one list, filtered by kind and client.

let mediaItems = null; // list from list_media, or null while loading
let mediaError = null;
let mediaKind = "screenshot"; // or "demo"
let mediaClient = "all";
let mediaSearch = "";
let mediaPage = 0;
let mediaSelectedPath = null;
const MEDIA_PAGE_SIZE = 48;

// path -> blob: URL, or "" when that screenshot couldn't be previewed.
// Thumbnails are generated and cached on disk by the Rust side; this only
// stops one session from asking for the same one twice.
const mediaThumbUrls = new Map();
const mediaThumbsLoading = new Set();

async function loadMedia() {
  try {
    const { invoke } = window.__TAURI__.core;
    mediaItems = await invoke("list_media");
    mediaError = null;
  } catch (err) {
    mediaError = String(err);
  }
  if (selected === "__media__") renderMainPreservingScroll();
}

// Fresh scan every time - a new screenshot or demo since the last visit is
// exactly what someone opening this tab is looking for.
function refreshMedia() {
  for (const url of mediaThumbUrls.values()) if (url) URL.revokeObjectURL(url);
  mediaThumbUrls.clear();
  mediaItems = null;
  mediaError = null;
}

function setMediaStatus(message) {
  const el = document.getElementById("media-status");
  if (el) el.textContent = message;
}

function clientLabel(id) {
  const client = PK3_CLIENTS.find((c) => c.id === id);
  if (!client) return id;
  return mods.find((m) => m.name === client.name)?.displayName ?? client.label;
}

// A screenshot in a base/ folder several clients share could have come from
// any of them - there's no telling which, so it's labelled as shared rather
// than pinned on one.
function mediaClientsLabel(item) {
  return item.clients.length > 1 ? "Shared" : clientLabel(item.clients[0]);
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

function formatMediaDate(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (daysAgo === 0) return `Today ${time}`;
  if (daysAgo === 1) return `Yesterday ${time}`;
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function revealLabel() {
  return currentPlatform === "macos" ? "Show in Finder" : "Show in folder";
}

function trashName() {
  return currentPlatform === "windows" ? "Recycle Bin" : "Trash";
}

function filteredMedia() {
  const term = mediaSearch.trim().toLowerCase();
  return mediaItems.filter(
    (m) =>
      m.kind === mediaKind &&
      (mediaClient === "all" || m.clients.includes(mediaClient)) &&
      (!term || m.name.toLowerCase().includes(term))
  );
}

// Clients that could play this demo right now: one that wrote into its
// folder, is installed, and isn't OpenJO (single-player, no demo playback).
function demoPlayers(item) {
  return PK3_CLIENTS.filter(
    (c) => c.id !== "openjo" && item.clients.includes(c.id) && modState[c.name]?.installed
  );
}

function screenshotCardHtml(item) {
  const url = mediaThumbUrls.get(item.path);
  const preview = url ? `<img src="${url}" alt="">` : url === "" ? `<span class="media-thumb-fallback">No preview</span>` : "";
  return `
    <button class="media-thumb ${item.path === mediaSelectedPath ? "selected" : ""}" data-media-select="${escapeHtml(item.path)}">
      <span class="media-thumb-img">${preview}</span>
      <span class="media-thumb-name">${escapeHtml(item.name)}</span>
      <span class="media-thumb-meta">${mediaClient === "all" ? `${escapeHtml(mediaClientsLabel(item))} &middot; ` : ""}${formatMediaDate(item.modified)}</span>
    </button>`;
}

function screenshotBarHtml(item) {
  const path = escapeHtml(item.path);
  const dims = item.width ? ` &middot; ${item.width}&times;${item.height}` : "";
  return `
    <div class="media-selection-bar">
      <span class="media-selection-info">
        <span class="media-selection-name">${escapeHtml(item.name)}</span>
        &middot; ${escapeHtml(item.clients.length > 1 ? `Shared by ${item.clients.map(clientLabel).join(", ")}` : mediaClientsLabel(item))}${dims} &middot; ${formatBytes(item.size)}
      </span>
      <button class="change-folder" data-media-view="${path}">View</button>
      <button class="change-folder" data-media-copy="${path}">Copy</button>
      <button class="change-folder" data-media-reveal="${path}">${revealLabel()}</button>
      <button class="media-trash-btn" data-media-trash="${path}">Move to ${trashName()}</button>
    </div>`;
}

function demoRowHtml(item) {
  const path = escapeHtml(item.path);
  const protocol = item.name.toLowerCase().endsWith(".dm_16") ? "1.04" : "1.02";
  const stem = item.name.replace(/\.dm_1[56]$/i, "");
  const players = demoPlayers(item);
  let watch;
  if (!players.length) {
    watch = `<span class="media-demo-note">No installed client can play this</span>`;
  } else if (players.length === 1) {
    watch = `<button class="media-watch-btn" data-media-watch="${path}" data-client="${players[0].id}">Watch</button>`;
  } else {
    watch = `
      <select class="server-client-select media-watch-client">
        ${players.map((c) => `<option value="${c.id}">${escapeHtml(clientLabel(c.id))}</option>`).join("")}
      </select>
      <button class="media-watch-btn" data-media-watch="${path}">Watch</button>`;
  }
  return `
    <div class="media-demo-row">
      <div class="media-demo-info">
        <p class="media-demo-name">${escapeHtml(stem)} <span class="media-demo-tag">${protocol}</span></p>
        <p class="media-demo-meta">${mediaClient === "all" ? `${escapeHtml(mediaClientsLabel(item))} &middot; ` : ""}${formatMediaDate(item.modified)} &middot; ${formatBytes(item.size)}</p>
      </div>
      <div class="media-demo-actions">
        ${watch}
        <button class="change-folder" data-media-rename="${path}">Rename</button>
        <button class="change-folder" data-media-reveal="${path}">${revealLabel()}</button>
        <button class="media-trash-btn" data-media-trash="${path}">Move to ${trashName()}</button>
      </div>
    </div>`;
}

// On the Demos tab, under Refresh - whether or not there are any demos yet.
const DEMO_CUT_REQUESTS_URL = "https://archive.org/details/democuts";
const demoCutRequestsHtml = `<a class="profile-link media-democuts-link" href="${DEMO_CUT_REQUESTS_URL}" target="_blank" rel="noopener">Demo Cut Requests &#8599;</a>`;

function renderMediaResults() {
  const items = filteredMedia();
  if (!items.length) {
    if (mediaSearch.trim()) return `<p class="detail-status">Nothing matches "${escapeHtml(mediaSearch)}".</p>`;
    return mediaKind === "screenshot"
      ? `<p class="detail-status">No screenshots yet. Take one in game with <code>/screenshotJPEG</code>, or bind it to a key.</p>`
      : `<p class="detail-status">No demos yet. Start recording in game with <code>/record</code> and stop with <code>/stoprecord</code>.</p>`;
  }

  const totalPages = Math.ceil(items.length / MEDIA_PAGE_SIZE);
  mediaPage = Math.min(mediaPage, totalPages - 1);
  const shown = items.slice(mediaPage * MEDIA_PAGE_SIZE, (mediaPage + 1) * MEDIA_PAGE_SIZE);
  const pagerHtml =
    totalPages > 1
      ? `<div class="monolith-pager">
           <button id="media-prev-page" ${mediaPage === 0 ? "disabled" : ""}>&larr; Prev</button>
           <span class="monolith-pager-label">Page ${mediaPage + 1} of ${totalPages} &middot; ${items.length} files</span>
           <button id="media-next-page" ${mediaPage >= totalPages - 1 ? "disabled" : ""}>Next &rarr;</button>
         </div>`
      : "";

  if (mediaKind === "demo") {
    return `<div class="media-demo-list">${shown.map(demoRowHtml).join("")}</div>${pagerHtml}`;
  }
  const selectedItem = items.find((m) => m.path === mediaSelectedPath);
  return `
    <div class="media-grid">${shown.map(screenshotCardHtml).join("")}</div>
    ${pagerHtml}
    ${selectedItem ? screenshotBarHtml(selectedItem) : ""}`;
}

function refreshMediaResults() {
  const resultsEl = document.getElementById("media-results");
  if (!resultsEl) return;
  resultsEl.innerHTML = renderMediaResults();
  loadVisibleThumbs();
}

function renderMediaView(mainEl) {
  if (mediaError) {
    mainEl.innerHTML = `<div class="detail-header"><h2>Media</h2></div><p class="detail-status">Couldn't load media: ${escapeHtml(mediaError)}</p>`;
    return;
  }
  if (mediaItems === null) {
    mainEl.innerHTML = `<div class="detail-header"><h2>Media</h2></div><p class="detail-status">Looking for screenshots and demos...</p>`;
    loadMedia();
    return;
  }

  // Only clients that actually have something of this kind are worth a
  // filter - OpenJO, for one, never has demos.
  const clientIds = PK3_CLIENTS.map((c) => c.id).filter((id) =>
    mediaItems.some((m) => m.kind === mediaKind && m.clients.includes(id))
  );
  if (!clientIds.includes(mediaClient)) mediaClient = "all";
  const inClient = (m) => mediaClient === "all" || m.clients.includes(mediaClient);
  const count = (kind) => mediaItems.filter((m) => m.kind === kind && inClient(m)).length;
  const totalBytes = mediaItems.reduce((sum, m) => sum + m.size, 0);

  const chipsHtml =
    clientIds.length > 1
      ? `<div class="media-chips">
           ${["all", ...clientIds]
             .map((id) => `<button class="media-chip ${id === mediaClient ? "active" : ""}" data-media-client="${id}">${id === "all" ? "All clients" : escapeHtml(clientLabel(id))}</button>`)
             .join("")}
         </div>`
      : "";

  mainEl.innerHTML = `
    <div class="detail-header">
      <h2>Media</h2>
      ${mediaItems.length ? `<span class="detail-version">${formatBytes(totalBytes)} on disk</span>` : ""}
    </div>
    <p class="detail-description">Screenshots and demos from every client, wherever each one saved them.</p>
    <div class="media-toolbar">
      <div class="media-tabs">
        <button class="media-tab ${mediaKind === "screenshot" ? "active" : ""}" data-media-kind="screenshot">Screenshots <span class="media-tab-count">${count("screenshot")}</span></button>
        <button class="media-tab ${mediaKind === "demo" ? "active" : ""}" data-media-kind="demo">Demos <span class="media-tab-count">${count("demo")}</span></button>
      </div>
      <input type="text" id="media-search" class="monolith-search-input media-search" placeholder="Search by name..." value="${escapeHtml(mediaSearch)}">
      <button class="change-folder" id="media-refresh-btn">Refresh</button>
      ${chipsHtml}
      ${mediaKind === "demo" ? demoCutRequestsHtml : ""}
    </div>
    <p class="detail-status" id="media-status"></p>
    <div id="media-results">${renderMediaResults()}</div>
  `;
  loadVisibleThumbs();
}

// A few at a time - the first time a screenshot is seen, its thumbnail means
// decoding the full-size image.
async function loadVisibleThumbs() {
  const { invoke } = window.__TAURI__.core;
  const pending = [...document.querySelectorAll(".media-thumb[data-media-select]")]
    .map((el) => el.dataset.mediaSelect)
    .filter((path) => !mediaThumbUrls.has(path) && !mediaThumbsLoading.has(path));
  const worker = async () => {
    while (pending.length) {
      const path = pending.shift();
      mediaThumbsLoading.add(path);
      try {
        const bytes = await invoke("media_thumbnail", { path });
        mediaThumbUrls.set(path, URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
      } catch {
        mediaThumbUrls.set(path, "");
      }
      mediaThumbsLoading.delete(path);
      const url = mediaThumbUrls.get(path);
      for (const el of document.querySelectorAll(".media-thumb[data-media-select]")) {
        if (el.dataset.mediaSelect !== path) continue;
        el.querySelector(".media-thumb-img").innerHTML = url
          ? `<img src="${url}" alt="">`
          : `<span class="media-thumb-fallback">No preview</span>`;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function openMediaViewer(path) {
  const { invoke } = window.__TAURI__.core;
  const items = filteredMedia();
  let index = items.findIndex((m) => m.path === path);
  if (index < 0) return;

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay media-viewer";
  overlay.innerHTML = `
    ${items.length > 1 ? `<button class="media-viewer-nav" data-step="-1" aria-label="Previous">&larr;</button>` : ""}
    <figure class="media-viewer-figure">
      <img class="media-viewer-img" alt="">
      <figcaption class="media-viewer-caption"></figcaption>
    </figure>
    ${items.length > 1 ? `<button class="media-viewer-nav" data-step="1" aria-label="Next">&rarr;</button>` : ""}`;
  document.body.appendChild(overlay);
  const img = overlay.querySelector(".media-viewer-img");
  const caption = overlay.querySelector(".media-viewer-caption");
  let currentUrl = null;

  async function show(i) {
    index = (i + items.length) % items.length;
    const item = items[index];
    mediaSelectedPath = item.path;
    caption.textContent = `${item.name} · ${mediaClientsLabel(item)} · ${formatMediaDate(item.modified)}`;
    try {
      const bytes = await invoke("media_image", { path: item.path });
      if (items[index] !== item) return; // moved on while this was loading
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(new Blob([bytes]));
      img.src = currentUrl;
    } catch (err) {
      caption.textContent += ` · Couldn't open: ${err}`;
    }
  }

  function close() {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    refreshMediaResults();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && items.length > 1) show(index - 1);
    else if (e.key === "ArrowRight" && items.length > 1) show(index + 1);
  }

  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    const nav = e.target.closest(".media-viewer-nav");
    if (nav) show(index + Number(nav.dataset.step));
    else if (e.target === overlay) close();
  });
  show(index);
}

async function bytesToPngBlob(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("couldn't encode image"))), "image/png")
  );
}

// Clipboards take PNG, not JPEG, and WebKit only allows the write while the
// click is still being handled - so the ClipboardItem is handed a promise
// straight away rather than waiting for the image to load first.
async function copyScreenshot(path) {
  const { invoke } = window.__TAURI__.core;
  const png = invoke("media_image", { path }).then(bytesToPngBlob);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    setMediaStatus("Copied to clipboard");
  } catch (err) {
    setMediaStatus(`Couldn't copy: ${err}`);
  }
}

async function revealMedia(path) {
  try {
    const { invoke } = window.__TAURI__.core;
    await invoke("reveal_media", { path });
  } catch (err) {
    setMediaStatus(`Error: ${err}`);
  }
}

async function trashMedia(path) {
  const item = mediaItems.find((m) => m.path === path);
  if (!item) return;
  const confirmed = await showConfirmDialog({
    title: `Move to ${trashName()}?`,
    message: `${escapeHtml(item.name)} will be moved to the ${trashName()}. You can restore it from there.`,
    confirmLabel: `Move to ${trashName()}`,
    danger: true,
  });
  if (!confirmed) return;
  try {
    const { invoke } = window.__TAURI__.core;
    await invoke("trash_media", { path });
    mediaItems = mediaItems.filter((m) => m.path !== path);
    const url = mediaThumbUrls.get(path);
    if (url) URL.revokeObjectURL(url);
    mediaThumbUrls.delete(path);
    if (mediaSelectedPath === path) mediaSelectedPath = null;
    renderMainPreservingScroll();
  } catch (err) {
    setMediaStatus(`Error: ${err}`);
  }
}

async function renameDemo(path) {
  const item = mediaItems.find((m) => m.path === path);
  if (!item) return;
  const { invoke } = window.__TAURI__.core;
  const stem = item.name.replace(/\.dm_1[56]$/i, "");
  // A name that's taken or has a space in it is worth fixing in place - the
  // dialog stays open with the error when `submit` throws.
  const newPath = await showTextDialog({
    title: "Rename demo",
    label: "Name",
    value: stem,
    confirmLabel: "Rename",
    submit: (newName) => invoke("rename_demo", { path, newName }),
  });
  if (!newPath) return;
  item.path = newPath;
  item.name = newPath.split(/[\\/]/).pop();
  renderMainPreservingScroll();
}

async function watchDemo(path, clientId) {
  const item = mediaItems.find((m) => m.path === path);
  try {
    const { invoke } = window.__TAURI__.core;
    await invoke("play_demo", { clientId, path });
    setMediaStatus(`Opening ${item?.name ?? "demo"} in ${clientLabel(clientId)}...`);
  } catch (err) {
    setMediaStatus(`Error: ${err}`);
  }
}

// Returns true when the click belonged to the Media view.
function handleMediaClick(e) {
  const kindBtn = e.target.closest("[data-media-kind]");
  if (kindBtn) {
    mediaKind = kindBtn.dataset.mediaKind;
    mediaPage = 0;
    mediaSelectedPath = null;
    renderMainPreservingScroll();
    return true;
  }
  const clientBtn = e.target.closest("[data-media-client]");
  if (clientBtn) {
    mediaClient = clientBtn.dataset.mediaClient;
    mediaPage = 0;
    renderMainPreservingScroll();
    return true;
  }
  const thumb = e.target.closest("[data-media-select]");
  if (thumb) {
    const path = thumb.dataset.mediaSelect;
    mediaSelectedPath = mediaSelectedPath === path ? null : path;
    refreshMediaResults();
    return true;
  }
  const viewBtn = e.target.closest("[data-media-view]");
  if (viewBtn) {
    openMediaViewer(viewBtn.dataset.mediaView);
    return true;
  }
  const copyBtn = e.target.closest("[data-media-copy]");
  if (copyBtn) {
    copyScreenshot(copyBtn.dataset.mediaCopy);
    return true;
  }
  const revealBtn = e.target.closest("[data-media-reveal]");
  if (revealBtn) {
    revealMedia(revealBtn.dataset.mediaReveal);
    return true;
  }
  const trashBtn = e.target.closest("[data-media-trash]");
  if (trashBtn) {
    trashMedia(trashBtn.dataset.mediaTrash);
    return true;
  }
  const renameBtn = e.target.closest("[data-media-rename]");
  if (renameBtn) {
    renameDemo(renameBtn.dataset.mediaRename);
    return true;
  }
  const watchBtn = e.target.closest("[data-media-watch]");
  if (watchBtn) {
    const clientId = watchBtn.dataset.client ?? watchBtn.closest(".media-demo-actions").querySelector(".media-watch-client").value;
    watchDemo(watchBtn.dataset.mediaWatch, clientId);
    return true;
  }
  if (e.target.closest("#media-refresh-btn")) {
    refreshMedia();
    renderMainPreservingScroll();
    return true;
  }
  if (e.target.closest("#media-prev-page")) {
    mediaPage = Math.max(0, mediaPage - 1);
    refreshMediaResults();
    return true;
  }
  if (e.target.closest("#media-next-page")) {
    mediaPage += 1;
    refreshMediaResults();
    return true;
  }
  return false;
}

function kdRatio(kills, deaths) {
  return deaths > 0 ? (kills / deaths).toFixed(2) : (kills > 0 ? kills.toFixed(2) : "0.00");
}

function formatFlagHold(ms) {
  const totalSec = Math.round((ms || 0) / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

function statTile(value, label) {
  return `<div class="stat-tile"><span class="stat-tile-value">${escapeHtml(value)}</span><span class="stat-tile-label">${label}</span></div>`;
}

function renderStatsBlock(mod) {
  const cached = statsCache[session.name];
  if (cached === undefined) {
    loadStats(mod, session.name);
    return `<p class="stats-month-label">Loading your stats...</p>`;
  }
  if (cached === null) {
    return `<p class="detail-status">No JK2CTF profile found for "${escapeHtml(session.name)}". <a class="detail-source-link" href="${safeHttpUrl(mod.profileUrl)}" target="_blank" rel="noopener">Check on the site ↗</a></p>`;
  }
  if (cached.error) {
    return `<p class="detail-status">Couldn't load stats: ${escapeHtml(cached.error)}</p>`;
  }

  const { currentMonth } = cached;
  const m = currentMonth.stats;
  const monthTiles = m
    ? `<div class="stats-grid">
        ${statTile(m.captures, "Caps")}
        ${statTile(m.returns, "Returns")}
        ${statTile(m.assists, "Assists")}
        ${statTile(m.baseCleaner, "BC")}
        ${statTile(m.flagGrabs, "Grabs")}
        ${statTile(m.kills, "Kills")}
        ${statTile(m.deaths, "Deaths")}
        ${statTile(kdRatio(m.kills, m.deaths), "K/D")}
        ${statTile(formatFlagHold(m.flagHoldMs), "Flag Hold")}
      </div>`
    : `<p class="detail-status">No scoreboard stats recorded this month.</p>`;

  return `
    <p class="stats-month-label">${escapeHtml(currentMonth.label)}</p>
    <p class="stats-record">
      <span class="win">${escapeHtml(currentMonth.wins)}W</span> &ndash; <span class="loss">${escapeHtml(currentMonth.losses)}L</span>
      ${currentMonth.winRate != null ? ` &middot; ${escapeHtml(currentMonth.winRate)}% win rate` : ""}
    </p>
    ${monthTiles}
  `;
}

async function loadStats(mod, name) {
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(`${SORACLE_BASE}/api/player-stats?slug=${playerSlug(name)}`);
    if (res.status === 404) {
      statsCache[name] = null;
    } else {
      const data = await res.json();
      statsCache[name] = res.ok ? data : { error: data.error || "Unknown error" };
    }
  } catch (err) {
    statsCache[name] = { error: String(err) };
  }
  if (selected === mod.name || selected === "__ctf__") scheduleMainRender();
}

const releaseCache = {}; // "owner/repo" -> release data, null (no releases), or { error }

function githubRepoFromUrl(url) {
  try {
    const u = new URL(url ?? "");
    if (u.hostname !== "github.com") return null;
    const [, owner, repo] = u.pathname.split("/");
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

// Anything that didn't originate in this file - server replies, the
// manifest, catalogs, feeds, filenames, error text - goes through here
// before it's put into HTML. Takes anything, since numbers and missing
// fields turn up too.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// For href/src that come from outside: anything but a plain http(s) URL
// (a javascript: link, say) becomes an empty string.
function safeHttpUrl(url) {
  return /^https?:\/\/\S+$/i.test(url ?? "") ? escapeHtml(url) : "";
}

// Server text: JK2 colour codes stripped, then escaped like everything else.
function serverText(s) {
  return escapeHtml(stripQuakeColors(s));
}

// A few common markdown bits (bold, bullets, line breaks) - GitHub release
// bodies are markdown, and pulling in a real parser isn't worth it for this.
function renderReleaseBody(body) {
  return escapeHtml(body || "")
    .trim()
    .replace(/^#{1,6} (.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^[-*] (.+)$/gm, "&bull; $1")
    .replace(/\n/g, "<br>");
}

async function loadRelease(mod, repo) {
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
    if (res.status === 404) {
      releaseCache[repo] = null;
    } else {
      const data = await res.json();
      releaseCache[repo] = res.ok ? data : { error: data.message || "Unknown error" };
    }
  } catch (err) {
    releaseCache[repo] = { error: String(err) };
  }
  if (selected === mod.name) renderMain();
}

function renderReleaseNotesBlock(mod, repo) {
  const cached = releaseCache[repo];
  if (cached === undefined) {
    loadRelease(mod, repo);
    return `<p class="stats-month-label">Latest Release</p><p class="detail-status">Loading...</p>`;
  }
  if (cached === null) return "";
  if (cached.error) {
    return `<p class="stats-month-label">Latest Release</p><p class="detail-status">Couldn't load release notes: ${escapeHtml(cached.error)}</p>`;
  }
  const body = renderReleaseBody(cached.body);
  return `
    <p class="stats-month-label">Latest Release &mdash; ${escapeHtml(cached.tag_name ?? "")}</p>
    <div class="release-notes">${body || "<em>No release notes provided.</em>"}</div>
    <a class="detail-source-link" href="${safeHttpUrl(cached.html_url)}" target="_blank" rel="noopener">View on GitHub ↗</a>
  `;
}

function renderMain() {
  const mainEl = document.getElementById("main");
  if (selected === "__home__") {
    renderHomeView(mainEl);
    return;
  }
  if (selected === "__faq__") {
    renderFaqView(mainEl);
    return;
  }
  if (selected === "__ctf__") {
    renderCtfView(mainEl);
    return;
  }
  if (selected === "__mods__") {
    renderModsView(mainEl);
    return;
  }
  if (selected === "__media__") {
    renderMediaView(mainEl);
    return;
  }
  if (selected === "__config__") {
    renderConfigView(mainEl);
    return;
  }
  if (selected === "__servers__") {
    renderServersView(mainEl);
    return;
  }
  const mod = mods.find((m) => m.name === selected);
  if (!mod) {
    mainEl.innerHTML = `<div class="main-empty">Select a client</div>`;
    return;
  }
  const handler = MOD_HANDLERS[mod.name];
  const state = modState[mod.name] || {};
  let actions = `<span class="detail-badge">Not available on this platform</span>`;
  if (handler && modSupportedOnCurrentPlatform(mod.name)) {
    if (state.installed) {
      const upToDate = state.installedVersion && state.installedVersion === mod.version;
      actions = upToDate
        ? `<span class="detail-badge">Up to date</span>
           <button data-action="play" ${state.busy ? "disabled" : ""}>Play</button>`
        : `<button data-action="update" ${state.busy ? "disabled" : ""}>Update</button>
           <button data-action="play" ${state.busy ? "disabled" : ""}>Play</button>`;
      actions += `<button class="uninstall-btn" data-action="uninstall" ${state.busy ? "disabled" : ""}>Uninstall</button>`;
    } else {
      actions = `<button data-action="install" ${state.busy ? "disabled" : ""}>Install</button>`;
      // Before offering to install a fresh copy, check whether this client
      // is simply sitting in a folder next door - installing over the top of
      // the wrong folder is the confusing outcome otherwise.
      const suggestion = clientFolderSuggestions[mod.name];
      if (suggestion === undefined) {
        loadFolderSuggestion(mod.name);
      } else if (suggestion) {
        actions += `<span class="folder-suggestion">
          Already installed in <span class="folder-suggestion-path" title="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</span>
          <button class="change-folder" data-use-suggested-folder="${escapeHtml(mod.name)}" data-suggested-path="${escapeHtml(suggestion)}">Use that folder</button>
        </span>`;
      }
    }
  }
  if (mod.profileUrl) {
    actions += `<a class="profile-link" href="${SORACLE_BASE}" target="_blank" rel="noopener">JK2 CTF</a>`;
  }
  // Which copy of the game this client will actually touch. Only shown for
  // clients this platform can install at all - there's nothing to point at
  // otherwise.
  let folderHtml = "";
  if (handler && modSupportedOnCurrentPlatform(mod.name)) {
    const folder = clientFolders[mod.name];
    if (folder === undefined) {
      loadClientFolder(mod.name);
      folderHtml = `<p class="client-folder-row"><span class="client-folder-label">Game folder</span> <span class="detail-status">Checking...</span></p>`;
    } else {
      const shown = folder.path ?? "Not found";
      folderHtml = `
        <p class="client-folder-row">
          <span class="client-folder-label">Game folder</span>
          <span class="client-folder-path" title="${escapeHtml(shown)}">${escapeHtml(shown)}</span>
          <span class="client-folder-tag">${folder.is_own ? "this client only" : "shared default"}</span>
          <button class="change-folder" data-pick-client-folder="${escapeHtml(mod.name)}">Change...</button>
          ${folder.is_own ? `<button class="change-folder" data-clear-client-folder="${escapeHtml(mod.name)}">Use default</button>` : ""}
        </p>`;
    }
  }
  const banner = `<img class="detail-banner" src="assets/banners/${encodeURIComponent(mod.name.toLowerCase())}.jpg" alt="" data-on-error="remove">`;
  const repo = githubRepoFromUrl(mod.sourceUrl);
  const releaseHtml = repo ? renderReleaseNotesBlock(mod, repo) : "";
  // "View on GitHub ↗" (in releaseHtml) already covers the source link for
  // any client hosted on GitHub. Only show a fallback Source link when it
  // isn't (e.g. NWH's sourceUrl is Flate's own server, not a repo) - and
  // bottom-left, not up top competing with the masthead emblem for space.
  const sourceHtml = !repo && mod.sourceUrl
    ? `<p class="detail-source-standalone"><a class="detail-source-link" href="${safeHttpUrl(mod.sourceUrl)}" target="_blank" rel="noopener">Source ↗</a></p>`
    : "";
  mainEl.innerHTML = `
    ${banner}
    <div class="detail-header"><h2>${escapeHtml(mod.displayName ?? mod.name)}</h2><span class="detail-version">${escapeHtml(mod.version)}</span></div>
    <p class="detail-description">${escapeHtml(mod.description ?? "")}</p>
    <div class="detail-actions">${actions}</div>
    <p class="detail-status">${escapeHtml(state.message ?? "")}</p>
    ${folderHtml}
    ${releaseHtml}
    ${sourceHtml}
  `;
}

async function handleAction(name, action) {
  const handler = MOD_HANDLERS[name];
  const mod = mods.find((m) => m.name === name);
  const { invoke } = window.__TAURI__.core;
  if (action === "uninstall") {
    const confirmed = await showConfirmDialog({
      title: "Uninstall?",
      message: `Remove ${escapeHtml(mod.displayName ?? mod.name)} from your game folder? Your PK3 mods and player data aren't touched.`,
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (!confirmed) return;
  }
  modState[name] = { ...modState[name], busy: true, message: "Working..." };
  renderSidebar();
  renderMain();
  try {
    if (action === "install" || action === "update") {
      modState[name].message = "Downloading...";
      renderMain();
      const platformInfo = modPlatformInfo(mod);
      const filename = handler.filenames[currentPlatform] ?? handler.filenames.macos;
      const { verified, actual } = await downloadFile(platformInfo.url, filename, platformInfo.sha256);
      let warning = "";
      if (verified === false) {
        warning =
          " ⚠️ Checksum didn't match the pinned release - could just mean there's a newer upstream build we haven't verified yet, but treat it with some caution.";
        console.warn(`Checksum mismatch for ${name}: expected ${platformInfo.sha256}, got ${actual}`);
      }
      modState[name].message = "Extracting...";
      renderMain();
      await invoke(handler.extractCommand);
      modState[name].message = "Installing...";
      renderMain();
      await invoke(handler.installCommand, { version: mod.version });
      modState[name].installed = true;
      modState[name].installedVersion = mod.version;
      modState[name].message = `Done.${warning}`;
    } else if (action === "play") {
      modState[name].message = "Launching...";
      renderMain();
      modState[name].message = await invoke(handler.playCommand);
    } else if (action === "uninstall") {
      modState[name].message = "Uninstalling...";
      renderMain();
      const result = await invoke(handler.uninstallCommand);
      modState[name].installed = false;
      modState[name].installedVersion = undefined;
      modState[name].message = result;
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
  if (mods.some((m) => m.name === name) && !clientsGroupOpen) setClientsGroupOpen(true);
  renderSidebar();
  renderMain();
}

async function checkGameFolder() {
  const dot = document.getElementById("game-folder-status");
  const desc = document.getElementById("game-folder-desc");
  const { invoke } = window.__TAURI__.core;
  try {
    await invoke("locate_jk2");
    dot.classList.remove("missing");
    dot.parentElement.classList.remove("missing");
    const override = await invoke("get_game_folder_override");
    desc.textContent = override ? "Custom folder" : "Steam install";
  } catch (err) {
    dot.classList.add("missing");
    dot.parentElement.classList.add("missing");
    desc.innerHTML = `Not found — <a href="${STEAM_STORE_URL}" target="_blank" rel="noopener">buy on Steam</a>`;
    console.error("Game folder not found:", err);
  }
}

async function refreshModStates() {
  const { invoke } = window.__TAURI__.core;
  for (const mod of mods) {
    const handler = MOD_HANDLERS[mod.name];
    if (handler && modSupportedOnCurrentPlatform(mod.name)) {
      try {
        const status = await invoke(handler.checkInstalledCommand);
        modState[mod.name] = { installed: status.installed, installedVersion: status.version };
      } catch (err) {
        modState[mod.name] = { installed: false };
      }
    }
  }
  renderSidebar();
  renderMain();
}

let pendingUpdate = null;
let updateBusy = false;
let updateLabelText = "Check for Updates";

function setUpdateLabel(text) {
  updateLabelText = text;
  const el = document.getElementById("faq-update-btn");
  if (el) el.textContent = text;
}

async function checkForUpdates(silent) {
  if (updateBusy) return;
  updateBusy = true;
  if (!silent) setUpdateLabel("Checking...");
  try {
    const { check } = window.__TAURI__.updater;
    const update = await check();
    if (update) {
      pendingUpdate = update;
      setUpdateLabel(`Update available: v${update.version} — click to install`);
    } else {
      pendingUpdate = null;
      setUpdateLabel(silent ? "Check for Updates" : "Up to date");
      if (!silent) setTimeout(() => { if (!pendingUpdate) setUpdateLabel("Check for Updates"); }, 3000);
    }
  } catch (err) {
    console.error("Update check failed:", err);
    pendingUpdate = null;
    setUpdateLabel(silent ? "Check for Updates" : "Error checking for updates");
    if (!silent) setTimeout(() => { if (!pendingUpdate) setUpdateLabel("Check for Updates"); }, 3000);
  } finally {
    updateBusy = false;
  }
}

async function installPendingUpdate() {
  if (!pendingUpdate || updateBusy) return;
  updateBusy = true;
  try {
    setUpdateLabel("Downloading update...");
    await pendingUpdate.downloadAndInstall();
    setUpdateLabel("Restarting...");
    const { relaunch } = window.__TAURI__.process;
    await relaunch();
  } catch (err) {
    console.error("Update install failed:", err);
    setUpdateLabel("Error installing update");
    updateBusy = false;
  }
}

async function init() {
  ensureDefaultFavoriteServers();
  checkGameFolder();
  try {
    currentPlatform = await window.__TAURI__.core.invoke("current_platform");
  } catch (err) {
    console.error("Failed to detect platform, defaulting to macos:", err);
  }
  session = await loadSession();
  renderSidebar();
  renderMain();

  if (!(await loadManifest())) return;
  renderSidebar(); // names up straight away; install checks fill in the dots
  await refreshModStates();
  checkForUpdates(true);
}

// A failed fetch here (a network hiccup, a VPN/DNS blip, no connection yet
// at launch) used to strand the app permanently with no client list and no
// way to recover short of fully restarting it - added a Retry button rather
// than assuming the first attempt is the only one that'll ever matter.
async function loadManifest() {
  const clientListEl = document.getElementById("client-list");
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(MANIFEST_URL);
    mods = (await res.json()).mods;
    return true;
  } catch (err) {
    clientListEl.innerHTML = `
      <p class="sidebar-loading">Couldn't reach the manifest - check your connection.</p>
      <p class="sidebar-loading">${escapeHtml(err)}</p>
      <button id="retry-manifest-btn" class="change-folder">Retry</button>`;
    console.error("Manifest fetch failed:", err);
    return false;
  }
}

async function retryManifestLoad() {
  if (await loadManifest()) {
    renderSidebar();
    await refreshModStates();
    checkForUpdates(true);
  }
}

document.getElementById("home-nav-row").addEventListener("click", () => selectClient("__home__"));
document.getElementById("ctf-nav-row").addEventListener("click", () => selectClient("__ctf__"));
document.getElementById("mods-nav-row").addEventListener("click", () => {
  // Fresh scan each visit, so a PK3 dropped into a game folder while the
  // app was open shows up without a restart.
  pk3Mods = null;
  pk3ModsError = null;
  selectClient("__mods__");
});
document.getElementById("config-nav-row").addEventListener("click", () => {
  configView = null; // fresh look at the configs each visit
  configError = null;
  selectClient("__config__");
});
document.getElementById("media-nav-row").addEventListener("click", () => {
  refreshMedia();
  selectClient("__media__");
});
document.getElementById("servers-nav-row").addEventListener("click", () => selectClient("__servers__"));
document.getElementById("faq-nav-row").addEventListener("click", () => selectClient("__faq__"));
document.getElementById("sign-out-nav-row").addEventListener("click", () => {
  session = null;
  clearSession();
  renderSidebar();
  renderMain();
});

document.getElementById("clients-group-row").addEventListener("click", () => setClientsGroupOpen(!clientsGroupOpen));

document.getElementById("client-list").addEventListener("click", (e) => {
  if (e.target.closest("#retry-manifest-btn")) {
    retryManifestLoad();
    return;
  }
  const row = e.target.closest(".client-row");
  if (row) selectClient(row.dataset.name);
});

document.getElementById("main").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) {
    handleAction(selected, btn.dataset.action);
    return;
  }
  if (handleMediaClick(e)) return;
  if (handleConfigClick(e)) return;
  const useSuggestedBtn = e.target.closest("button[data-use-suggested-folder]");
  if (useSuggestedBtn) {
    useSuggestedFolder(useSuggestedBtn.dataset.useSuggestedFolder, useSuggestedBtn.dataset.suggestedPath);
    return;
  }
  const pickFolderBtn = e.target.closest("button[data-pick-client-folder]");
  if (pickFolderBtn) {
    setClientFolder(pickFolderBtn.dataset.pickClientFolder);
    return;
  }
  const clearFolderBtn = e.target.closest("button[data-clear-client-folder]");
  if (clearFolderBtn) {
    resetClientFolder(clearFolderBtn.dataset.clearClientFolder);
    return;
  }
  const modePlayBtn = e.target.closest("[data-mode-play]");
  if (modePlayBtn) {
    playMode(modePlayBtn.dataset.modePlay);
    return;
  }
  const modeServerBtn = e.target.closest("[data-mode-server]");
  if (modeServerBtn) {
    chooseModeServer(modeServerBtn.dataset.modeServer);
    return;
  }
  const modeInstallBtn = e.target.closest("[data-mode-install]");
  if (modeInstallBtn) {
    selectClient(modeInstallBtn.dataset.modeInstall);
    return;
  }
  if (e.target.closest("#back-to-home-link")) {
    selectClient("__home__");
    return;
  }
  if (e.target.closest("#faq-update-btn")) {
    if (pendingUpdate) installPendingUpdate();
    else checkForUpdates(false);
    return;
  }
  if (e.target.closest("#highlight-scroll-left")) {
    document.getElementById("highlight-strip")?.scrollBy({ left: -460, behavior: "smooth" });
    return;
  }
  if (e.target.closest("#highlight-scroll-right")) {
    document.getElementById("highlight-strip")?.scrollBy({ left: 460, behavior: "smooth" });
    return;
  }
  if (e.target.closest("#add-pk3-btn")) {
    addPk3Mods();
    return;
  }
  const removeBtn = e.target.closest(".pk3-remove-btn");
  if (removeBtn) {
    removePk3Mod(removeBtn.dataset.filename);
    return;
  }
  const downloadBtn = e.target.closest(".monolith-download-btn");
  if (downloadBtn) {
    downloadMonolithMod(downloadBtn.dataset.url, downloadBtn.dataset.filename, downloadBtn);
    return;
  }
  if (e.target.closest("#monolith-prev-page")) {
    monolithPage = Math.max(0, monolithPage - 1);
    document.getElementById("monolith-results").innerHTML = renderMonolithResults();
    return;
  }
  if (e.target.closest("#monolith-next-page")) {
    monolithPage += 1;
    document.getElementById("monolith-results").innerHTML = renderMonolithResults();
    return;
  }
  const modsClientBtn = e.target.closest("[data-mods-client]");
  if (modsClientBtn) {
    installedModsClient = modsClientBtn.dataset.modsClient;
    installedModsPage = 0;
    renderMainPreservingScroll();
    return;
  }
  if (e.target.closest("#installed-mods-prev-page")) {
    installedModsPage = Math.max(0, installedModsPage - 1);
    document.getElementById("installed-mods-results").innerHTML = renderInstalledModsResults();
    return;
  }
  if (e.target.closest("#installed-mods-next-page")) {
    installedModsPage += 1;
    document.getElementById("installed-mods-results").innerHTML = renderInstalledModsResults();
    return;
  }
  const joinBtn = e.target.closest(".server-join-btn");
  if (joinBtn) {
    // One-click join (data-client) when only one client is installed;
    // otherwise pick the value from the row's <select>. The select lives in
    // a ".server-join" wrapper on the Servers page, and directly inside
    // ".favorite-row" on the Home favorite bar - match either ancestor.
    const clientName = joinBtn.dataset.client ?? joinBtn.closest(".server-join, .favorite-row").querySelector(".server-client-select").value;
    joinServer(clientName, joinBtn.dataset.address);
    return;
  }
  const favBtn = e.target.closest(".server-favorite-btn");
  if (favBtn && !favBtn.disabled) {
    toggleFavoriteServer(favBtn.dataset.address);
    renderMain();
    return;
  }
  if (e.target.closest("#server-refresh-btn")) {
    for (const address of allServers()) delete serverStatusCache[address];
    renderMain();
    return;
  }
  if (e.target.closest("#server-add-btn")) {
    addCustomServer(addServerDraft);
    renderMain();
    document.getElementById("server-add-input")?.focus();
    return;
  }
  const serverRemoveBtn = e.target.closest(".server-remove-btn");
  if (serverRemoveBtn) {
    removeCustomServer(serverRemoveBtn.dataset.address);
    renderMain();
    return;
  }
  const serverRow = e.target.closest(".server-row-summary");
  if (serverRow) {
    const address = serverRow.dataset.address;
    if (expandedServers.has(address)) expandedServers.delete(address);
    else expandedServers.add(address);
    renderMain();
  }
});

// Images that should vanish when their file is missing (a client without a
// banner, a catalog preview that 404s). Error events don't bubble, so this
// listens in the capture phase instead of an inline onerror attribute.
document.addEventListener(
  "error",
  (e) => {
    const action = e.target?.dataset?.onError;
    if (action === "remove") e.target.remove();
    else if (action === "hide") e.target.style.visibility = "hidden";
  },
  true
);

document.getElementById("main").addEventListener("dblclick", (e) => {
  const thumb = e.target.closest("[data-media-select]");
  if (thumb) openMediaViewer(thumb.dataset.mediaSelect);
});

document.getElementById("main").addEventListener("change", (e) => {
  const chip = e.target.closest("input[data-preset-client]");
  if (chip) {
    togglePresetClient(chip.dataset.presetClient, chip.dataset.target, chip.checked);
    return;
  }
  const scope = e.target.closest("input[data-preset-controls-only]");
  if (scope) {
    configAction("set_preset_controls_only", { id: scope.dataset.presetControlsOnly, controlsOnly: scope.checked });
    return;
  }
  const cb = e.target.closest('input[type="checkbox"][data-target]');
  if (cb) togglePk3Target(cb.dataset.filename, cb.dataset.target, cb.checked);
});

document.getElementById("main").addEventListener("input", (e) => {
  if (e.target.id === "server-add-input") {
    addServerDraft = e.target.value;
    return;
  }
  const monolithSearchEl = e.target.closest("#monolith-search");
  if (monolithSearchEl) {
    monolithSearch = monolithSearchEl.value;
    monolithPage = 0;
    const resultsEl = document.getElementById("monolith-results");
    if (resultsEl) resultsEl.innerHTML = renderMonolithResults();
    return;
  }
  const mediaSearchEl = e.target.closest("#media-search");
  if (mediaSearchEl) {
    mediaSearch = mediaSearchEl.value;
    mediaPage = 0;
    refreshMediaResults();
    return;
  }
  const installedSearchEl = e.target.closest("#installed-mods-search");
  if (installedSearchEl) {
    installedModsSearch = installedSearchEl.value;
    installedModsPage = 0;
    const resultsEl = document.getElementById("installed-mods-results");
    if (resultsEl) resultsEl.innerHTML = renderInstalledModsResults();
  }
});

document.getElementById("main").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "server-add-input") {
    document.getElementById("server-add-btn")?.click();
  }
});

document.getElementById("main").addEventListener("submit", async (e) => {
  const form = e.target.closest("#soracle-login-form");
  if (!form) return;
  e.preventDefault();
  const name = form.elements.name.value.trim();
  const password = form.elements.password.value;
  const errorEl = document.getElementById("login-error");
  const submitBtn = form.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  errorEl.textContent = "";
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(`${SORACLE_BASE}/api/player-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || "Login failed";
      submitBtn.disabled = false;
      return;
    }
    session = { name: data.name };
    await saveSession(data.name);
    renderSidebar();
    renderMain();
  } catch (err) {
    errorEl.textContent = "Something went wrong. Try again.";
    submitBtn.disabled = false;
  }
});

document.getElementById("change-folder-btn").addEventListener("click", async () => {
  const { invoke } = window.__TAURI__.core;
  let message = null;
  try {
    const picked = await invoke("pick_game_folder");
    if (!picked) return; // user cancelled the dialog
    message = `Game folder set to ${picked}`;
    await checkGameFolder();
    await refreshModStates();
  } catch (err) {
    message = `Error: ${err}`;
  }
  document.getElementById("main").insertAdjacentHTML(
    "afterbegin",
    `<p class="detail-status" style="margin-bottom: 1rem;">${escapeHtml(message)}</p>`
  );
});

init();
