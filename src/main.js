const MANIFEST_URL = "https://gist.githubusercontent.com/soradozere/a5ac8df67ac85687d20b4901ae1f1af0/raw/manifest.json";
const SORACLE_BASE = "https://jk2ctf.com";
const SESSION_FILE = "soracle_session.json";
const STEAM_STORE_URL = "https://store.steampowered.com/app/6030/STAR_WARS_Jedi_Knight_II__Jedi_Outcast/";

const MOD_HANDLERS = {
  TommyternalJK2MV: {
    filename: "tommyternal_macos_arm64.zip",
    extractCommand: "extract_tommyternal",
    installCommand: "install_tommyternal",
    checkInstalledCommand: "is_tommyternal_installed",
    playCommand: "play_tommyternal",
    uninstallCommand: "uninstall_tommyternal",
  },
  OpenJO: {
    filename: "openjo_macos_arm64.tar.gz",
    extractCommand: "extract_openjo",
    installCommand: "install_openjo",
    checkInstalledCommand: "is_openjo_installed",
    playCommand: "play_openjo",
    uninstallCommand: "uninstall_openjo",
  },
  JK2MV: {
    filename: "jk2mv_macos_x86_64.dmg",
    extractCommand: "extract_jk2mv",
    installCommand: "install_jk2mv",
    checkInstalledCommand: "is_jk2mv_installed",
    playCommand: "play_jk2mv",
    uninstallCommand: "uninstall_jk2mv",
  },
};

// Only clients that actually speak the multiplayer protocol can join -
// OpenJO is single-player only.
const JOINABLE_CLIENTS = ["TommyternalJK2MV", "JK2MV"];

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
];
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

const PK3_CLIENTS = [
  { id: "jk2mv", label: "JK2MV" },
  { id: "tommyternal", label: "TommyternalJK2MV" },
  { id: "openjo", label: "OpenJO" },
];

// Kept in sync by hand with jk2ctf.com/faq's ACCOUNT + LAUNCHER sections -
// embedded here so opening it doesn't leave the app. /ctf-101 (gameplay) has
// no launcher equivalent since none of it is launcher-specific.
const FAQ_ENTRIES = [
  {
    q: "How do I install custom maps or mods (PK3s)?",
    a: "Use the Mods section in the sidebar. Add PK3s from your own computer, or search and download straight from the Monolith community database - either way, you then choose whether a mod applies to All Clients or just specific ones, and the launcher handles putting it in the right place.",
  },
  {
    q: "How do I get a player account?",
    a: "There's no sign-up form - an admin sets your name and an initial password. Ask in the community Discord and someone will get you set up.",
  },
  {
    q: "I forgot my password.",
    a: "Same answer - ask an admin to reset it. There's no email tied to the account, so there's no self-serve reset flow.",
  },
  {
    q: "What's a player profile actually for?",
    a: 'It\'s your public page at jk2ctf.com/player/[your-name] - stats, badges, titles you\'ve earned, and cosmetics you can equip once unlocked. Sign in above and it\'s editable; anyone can view it without an account.',
  },
  {
    q: "What is the JK2 Launcher?",
    a: "This app - it installs and updates JK2 client mods for you, no manually copying files into your Jedi Outcast folder. It finds your Steam install automatically.",
  },
  {
    q: "Which clients can I install?",
    a: "JK2MV (the modernised engine most other clients build on), TomArrow's Tommyternal fork (defrag/FFA-focused), and OpenJO (a stability-focused rebuild of the single-player campaign). All three run natively on macOS and Windows.",
  },
  {
    q: "What about NWH?",
    a: 'NWH (Capture the Flag - NWH) is the anti-cheat client organised CTF matches actually run on, but its current build is Linux-only - this launcher can\'t install or run it on macOS or Windows yet.',
  },
  {
    q: "A client won't launch, or crashes immediately.",
    a: "Try Update first - a fresh install often clears it. If that doesn't help, ask in Discord with what you tried.",
  },
  {
    q: "It says it can't find Jedi Outcast.",
    a: 'Use Change... next to Game Folder in the sidebar to point the launcher at your install directly, if it\'s somewhere non-standard.',
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

function renderSidebar() {
  document.getElementById("home-nav-row").classList.toggle("active", selected === "__home__");
  document.getElementById("mods-nav-row").classList.toggle("active", selected === "__mods__");
  document.getElementById("servers-nav-row").classList.toggle("active", selected === "__servers__");
  document.getElementById("faq-nav-row").classList.toggle("active", selected === "__faq__");
  document.getElementById("sign-out-section").hidden = !session;
  document.getElementById("client-list").innerHTML = mods
    .map((mod) => {
      const state = modState[mod.name] || {};
      const status = state.installed ? "installed" : MOD_HANDLERS[mod.name] ? "" : "unsupported";
      const classes = ["client-row", mod.name === selected ? "active" : "", state.installed ? "installed" : ""]
        .filter(Boolean)
        .join(" ");
      return `<div class="${classes}" data-name="${mod.name}">
        <span class="client-row-name">${mod.displayName ?? mod.name}</span>
        <span class="client-row-status">${status}</span>
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
    text = `<b>Match #${item.ordinal}</b> logged &mdash; <span style="color: var(--team-red)">Red ${item.redScore}</span> : <span style="color: var(--team-blue)">${item.blueScore} Blue</span>`;
    sub = `${item.playerCount} players`;
  } else if (item.type === "crest") {
    accent = RARITY_COLORS[item.entry.rarity] ?? "var(--primary)";
    text = `<b>${item.entry.playerName}</b> earned <span style="color: ${accent}">${item.entry.title}</span>`;
    sub = item.entry.rarity ?? "";
  } else {
    text = `New demo: <b>${item.title}</b>${item.uploaderName ? ` by ${item.uploaderName}` : ""}`;
    sub = item.gametype ?? "";
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

async function loadActivityFeed() {
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(`${SORACLE_BASE}/api/activity-feed`);
    const data = await res.json();
    activityFeed = data.activityFeed;
  } catch (err) {
    activityFeedError = String(err);
  }
  if (selected === "__home__") renderMain();
}

async function loadRecentVideos() {
  try {
    const { fetch } = window.__TAURI__.http;
    const res = await fetch(`${SORACLE_BASE}/api/recent-videos`);
    const data = await res.json();
    recentVideos = data.videos ?? [];
  } catch {
    recentVideos = [];
  }
  if (selected === "__home__") renderMain();
}

function recentVideoCardHtml(video) {
  const thumb = `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`;
  const url = `https://www.youtube.com/watch?v=${video.videoId}`;
  return `
    <a class="highlight-card" href="${url}" target="_blank" rel="noopener">
      <img src="${thumb}" alt="">
      <span class="highlight-card-play">&#9654;</span>
      <span class="highlight-card-label">${video.title || "Watch"}</span>
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
        <span class="favorite-row-name">${address}</span>
        <span class="favorite-row-meta">Unreachable right now</span>
        <button class="server-favorite-btn active" data-address="${address}" title="Remove favorite">★</button>
      </div>`;
  }
  const installedJoinable = JOINABLE_CLIENTS.filter((name) => modState[name]?.installed);
  let playHtml;
  if (installedJoinable.length === 0) {
    playHtml = `<span class="favorite-play-btn favorite-play-btn--disabled">Install a client</span>`;
  } else if (installedJoinable.length === 1) {
    playHtml = `<button class="favorite-play-btn server-join-btn" data-address="${address}" data-client="${installedJoinable[0]}">Play</button>`;
  } else {
    // More than one option installed - let them pick, same control as the
    // Servers page, instead of silently guessing which one they meant.
    playHtml = `
      <div class="server-join">
        <button class="favorite-play-btn server-join-btn" data-address="${address}">Play</button>
        <select class="server-client-select">
          ${installedJoinable.map((name) => `<option value="${name}">${mods.find((m) => m.name === name)?.displayName ?? name}</option>`).join("")}
        </select>
      </div>`;
  }
  return `
    <div class="favorite-row">
      ${playHtml}
      <span class="favorite-row-name">${stripQuakeColors(data.hostname)}</span>
      <span class="favorite-row-meta">${data.map} &middot; ${data.players.length}/${data.max_clients} players</span>
      <button class="server-favorite-btn active" data-address="${address}" title="Remove favorite">★</button>
      ${serverJoinMessage[address] ? `<p class="detail-status">${serverJoinMessage[address]}</p>` : ""}
    </div>`;
}

function favoriteServerBlocksHtml() {
  const addresses = getFavoriteServers();
  if (addresses.length === 0) return "";
  return `<div class="favorites-card">${addresses.map(favoriteServerRowHtml).join("")}</div>`;
}

function renderHomeView(mainEl) {
  const welcome = session
    ? `<div class="home-welcome"><h2>Welcome back, ${session.name}</h2></div>`
    : `<div class="home-welcome"><h2>Welcome to JK2 Launcher</h2></div>`;

  // Kept out of the initial welcome block and rendered further down (after
  // the strap and favorite-server bar) so a first-time visitor's first
  // impression isn't a login form - the strap line is what should read
  // first.
  const loginPromptHtml = session
    ? ""
    : `<div class="home-login-prompt">
         <p>Sign in with your JK2CTF player account to see your stats here and on Capture the Flag - NWH.</p>
         <form id="soracle-login-form" class="login-form">
           <input name="name" placeholder="Player name" autocomplete="username" required>
           <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
           <button type="submit">Sign in</button>
           <p class="login-error" id="login-error"></p>
         </form>
       </div>`;

  let feedHtml;
  if (activityFeedError) {
    feedHtml = `<p class="detail-status">Couldn't load activity: ${activityFeedError}</p>`;
  } else if (!activityFeed) {
    feedHtml = `<p class="detail-status">Loading...</p>`;
    loadActivityFeed();
  } else if (activityFeed.length === 0) {
    feedHtml = `<p class="detail-status">No recent activity.</p>`;
  } else {
    feedHtml = `<div class="feed-list">${activityFeed.map(feedRowHtml).join("")}</div>`;
  }

  mainEl.innerHTML = `
    ${welcome}
    <p class="home-strap">Download, update and launch a client from the sidebar, and see what the playerbase has been up to below.</p>
    ${favoriteServerBlocksHtml()}
    ${loginPromptHtml}
    ${renderRecentHighlightsBlock()}
    <p class="home-feed-label">Recent Activity</p>
    ${feedHtml}
  `;
}

// Strips idTech3 caret color codes (^1, ^7, etc.) and raw control bytes some
// servers throw into their hostname/player names (seen in the wild as
// literal \x01 bytes, presumably an old anti-spoof or client-specific trick)
// - both render as garbled box glyphs otherwise.
function stripQuakeColors(s) {
  return (s ?? "").replace(/\^[0-9]/g, "").replace(/[\x00-\x1f]/g, "");
}

const serverStatusLoading = new Set(); // addresses with a query already in flight

// Shared by the Home favorite-server bar and the Servers page - a single
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
  if (selected === "__home__" || selected === "__servers__") renderMain();
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
    <div class="server-row-summary" data-address="${data.address}">
      <button class="server-favorite-btn ${isFavorite ? "active" : ""}" data-address="${data.address}" title="${favoriteTitle}" ${atFavoriteLimit ? "disabled" : ""}>${isFavorite ? "★" : "☆"}</button>
      <span class="server-row-name">${stripQuakeColors(data.hostname)}</span>
      <span class="server-row-map">${data.map}</span>
      <span class="server-row-players">${data.players.length}/${data.max_clients}</span>
      <span class="server-row-ping">${data.ping_ms}ms</span>
      <span class="server-row-caret">${isExpanded ? "▾" : "▸"}</span>
    </div>`;
  if (!isExpanded) {
    return `<div class="server-row">${summaryHtml}</div>`;
  }
  const installedJoinable = JOINABLE_CLIENTS.filter((name) => modState[name]?.installed);
  const joinHtml =
    installedJoinable.length === 0
      ? `<p class="detail-status">Install Tommyternal or JK2MV to join this server.</p>`
      : `<div class="server-join">
          <select class="server-client-select">
            ${installedJoinable.map((name) => `<option value="${name}">${mods.find((m) => m.name === name)?.displayName ?? name}</option>`).join("")}
          </select>
          <button class="server-join-btn" data-address="${data.address}">Join</button>
        </div>`;
  const playerRows = data.players.length
    ? data.players
        .map((p) => `<li><span>${stripQuakeColors(p.name)}</span><span class="server-player-score">${p.score}</span></li>`)
        .join("")
    : `<li class="server-empty">No players connected</li>`;
  return `
    <div class="server-row expanded">
      ${summaryHtml}
      <div class="server-row-details">
        <p class="server-meta">${data.address}</p>
        <ul class="server-player-list">${playerRows}</ul>
        ${joinHtml}
        <p class="detail-status">${serverJoinMessage[data.address] ?? ""}</p>
      </div>
    </div>`;
}

function renderServersView(mainEl) {
  const resolved = [];
  let pending = 0;
  for (const address of KNOWN_SERVERS) {
    const data = serverStatusCache[address];
    if (data === undefined) {
      pending++;
      loadServerStatus(address);
    } else if (!data.error) {
      resolved.push(data);
    }
  }
  resolved.sort((a, b) => b.players.length - a.players.length);

  let listHtml;
  if (resolved.length === 0) {
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
      <div class="server-list">${resolved.map(serverRowHtml).join("")}</div>
      ${pending > 0 ? `<p class="detail-status">Querying ${pending} more...</p>` : ""}`;
  }
  mainEl.innerHTML = `
    <div class="detail-header">
      <h2>Servers</h2>
      <button class="server-refresh-btn" id="server-refresh-btn">Refresh</button>
    </div>
    <p class="detail-description">Known JK2 1.02 community servers, queried directly - star a favorite for a one-click join from Home, click a row for details.</p>
    ${listHtml}
  `;
}

function renderFaqView(mainEl) {
  mainEl.innerHTML = `
    <span class="footer-nav-link" id="back-to-home-link">&larr; Back to Home</span>
    <div class="detail-header"><h2>Support / FAQ</h2></div>
    <div class="faq-list">
      ${FAQ_ENTRIES.map((e) => `<div class="faq-entry"><p class="faq-q">${e.q}</p><p class="faq-a">${e.a}</p></div>`).join("")}
    </div>
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
  const allCheckbox = `<label class="pk3-target"><input type="checkbox" data-filename="${mod.filename}" data-target="all" ${isAll ? "checked" : ""}> All Clients</label>`;
  const clientCheckboxes = PK3_CLIENTS.map((c) => {
    const checked = !isAll && mod.targets.includes(c.id);
    return `<label class="pk3-target"><input type="checkbox" data-filename="${mod.filename}" data-target="${c.id}" ${isAll ? "disabled" : ""} ${checked ? "checked" : ""}> ${c.label}</label>`;
  }).join("");
  return `
    <div class="pk3-row">
      <span class="pk3-name">${mod.filename}</span>
      <div class="pk3-targets">${allCheckbox}${clientCheckboxes}</div>
      <button class="pk3-remove-btn" data-filename="${mod.filename}">Remove</button>
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
    ? `<img class="monolith-thumb" src="${mod.preview_image}" alt="" onerror="this.style.visibility='hidden'">`
    : `<div class="monolith-thumb monolith-thumb-empty"></div>`;
  return `
    <div class="monolith-card">
      ${thumb}
      <div class="monolith-info">
        <p class="monolith-name">${mod.name}</p>
        <p class="monolith-meta">${mod.author || "Unknown"} &middot; ${mod.category || "&mdash;"} &middot; ${mod.size || ""}</p>
      </div>
      <button class="monolith-download-btn" data-url="${mod.download_url}" data-filename="${filename}">Download</button>
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
  if (!matches.length) return `<p class="detail-status">No mods match "${monolithSearch}".</p>`;

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
    <input type="text" id="monolith-search" class="monolith-search-input" placeholder="Search by name, author, or category..." value="${monolithSearch}">
    <div id="monolith-results">${renderMonolithResults()}</div>
  `;
}

let installedModsSearch = "";

function renderInstalledModsResults() {
  const term = installedModsSearch.trim().toLowerCase();
  const matches = term ? pk3Mods.filter((m) => m.filename.toLowerCase().includes(term)) : pk3Mods;
  if (!matches.length) return `<p class="detail-status">No installed mods match "${installedModsSearch}".</p>`;
  return `<div class="pk3-list">${matches.map(pk3RowHtml).join("")}</div>`;
}

function renderModsView(mainEl) {
  if (pk3ModsError) {
    mainEl.innerHTML = `<div class="detail-header"><h2>Mods</h2></div><p class="detail-status">Couldn't load mods: ${pk3ModsError}</p>`;
    return;
  }
  if (pk3Mods === null) {
    mainEl.innerHTML = `<div class="detail-header"><h2>Mods</h2></div><p class="detail-status">Loading...</p>`;
    loadPk3Mods();
    return;
  }
  const installedHtml = pk3Mods.length
    ? `<input type="text" id="installed-mods-search" class="monolith-search-input" placeholder="Search your installed mods..." value="${installedModsSearch}">
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

function kdRatio(kills, deaths) {
  return deaths > 0 ? (kills / deaths).toFixed(2) : (kills > 0 ? kills.toFixed(2) : "0.00");
}

function formatFlagHold(ms) {
  const totalSec = Math.round((ms || 0) / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

function statTile(value, label) {
  return `<div class="stat-tile"><span class="stat-tile-value">${value}</span><span class="stat-tile-label">${label}</span></div>`;
}

function renderStatsBlock(mod) {
  const cached = statsCache[session.name];
  if (cached === undefined) {
    loadStats(mod, session.name);
    return `<p class="stats-month-label">Loading your stats...</p>`;
  }
  if (cached === null) {
    return `<p class="detail-status">No JK2CTF profile found for "${session.name}". <a class="detail-source-link" href="${mod.profileUrl}" target="_blank" rel="noopener">Check on the site ↗</a></p>`;
  }
  if (cached.error) {
    return `<p class="detail-status">Couldn't load stats: ${cached.error}</p>`;
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
    <p class="stats-month-label">${currentMonth.label}</p>
    <p class="stats-record">
      <span class="win">${currentMonth.wins}W</span> &ndash; <span class="loss">${currentMonth.losses}L</span>
      ${currentMonth.winRate != null ? ` &middot; ${currentMonth.winRate}% win rate` : ""}
    </p>
    ${monthTiles}
    <a class="detail-source-link" href="${SORACLE_BASE}/player/${playerSlug(session.name)}" target="_blank" rel="noopener">View full profile ↗</a>
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
  if (selected === mod.name) renderMain();
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
    return `<p class="stats-month-label">Latest Release</p><p class="detail-status">Couldn't load release notes: ${cached.error}</p>`;
  }
  const body = renderReleaseBody(cached.body);
  return `
    <p class="stats-month-label">Latest Release &mdash; ${cached.tag_name ?? ""}</p>
    <div class="release-notes">${body || "<em>No release notes provided.</em>"}</div>
    <a class="detail-source-link" href="${cached.html_url}" target="_blank" rel="noopener">View on GitHub ↗</a>
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
  if (selected === "__mods__") {
    renderModsView(mainEl);
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
  let actions = `<span class="detail-badge">Not yet supported for macOS</span>`;
  if (handler) {
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
    }
  }
  let statsHtml = "";
  if (mod.profileUrl) {
    if (session) {
      statsHtml = renderStatsBlock(mod);
    } else {
      actions += `<a class="profile-link" href="${SORACLE_BASE}" target="_blank" rel="noopener">JK2 CTF</a>`;
    }
  }
  const banner = `<img class="detail-banner" src="assets/banners/${mod.name.toLowerCase()}.jpg" alt="" onerror="this.remove()">`;
  const repo = githubRepoFromUrl(mod.sourceUrl);
  const releaseHtml = repo ? renderReleaseNotesBlock(mod, repo) : "";
  // "View on GitHub ↗" (in releaseHtml) already covers the source link for
  // any client hosted on GitHub. Only show a fallback Source link when it
  // isn't (e.g. NWH's sourceUrl is Flate's own server, not a repo) - and
  // bottom-left, not up top competing with the masthead emblem for space.
  const sourceHtml = !repo && mod.sourceUrl
    ? `<p class="detail-source-standalone"><a class="detail-source-link" href="${mod.sourceUrl}" target="_blank" rel="noopener">Source ↗</a></p>`
    : "";
  mainEl.innerHTML = `
    ${banner}
    <div class="detail-header"><h2>${mod.displayName ?? mod.name}</h2><span class="detail-version">${mod.version}</span></div>
    <p class="detail-description">${mod.description ?? ""}</p>
    <div class="detail-actions">${actions}</div>
    <p class="detail-status">${state.message ?? ""}</p>
    ${statsHtml}
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
      message: `Remove ${mod.displayName ?? mod.name} from your game folder? Your PK3 mods and player data aren't touched.`,
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
      const { verified, actual } = await downloadFile(mod.url, handler.filename, mod.sha256);
      let warning = "";
      if (verified === false) {
        warning =
          " ⚠️ Checksum didn't match the pinned release - could just mean there's a newer upstream build we haven't verified yet, but treat it with some caution.";
        console.warn(`Checksum mismatch for ${name}: expected ${mod.sha256}, got ${actual}`);
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
    const override = await invoke("get_game_folder_override");
    desc.textContent = override ? "Custom folder" : "Steam install";
  } catch (err) {
    dot.classList.add("missing");
    desc.innerHTML = `Not found — <a href="${STEAM_STORE_URL}" target="_blank" rel="noopener">buy on Steam</a>`;
    console.error("Game folder not found:", err);
  }
}

async function refreshModStates() {
  const { invoke } = window.__TAURI__.core;
  for (const mod of mods) {
    const handler = MOD_HANDLERS[mod.name];
    if (handler) {
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
  session = await loadSession();
  renderSidebar();
  renderMain();

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

  await refreshModStates();
  checkForUpdates(true);
}

document.getElementById("home-nav-row").addEventListener("click", () => selectClient("__home__"));
document.getElementById("mods-nav-row").addEventListener("click", () => selectClient("__mods__"));
document.getElementById("servers-nav-row").addEventListener("click", () => selectClient("__servers__"));
document.getElementById("faq-nav-row").addEventListener("click", () => selectClient("__faq__"));
document.getElementById("sign-out-nav-row").addEventListener("click", () => {
  session = null;
  clearSession();
  renderSidebar();
  renderMain();
});

document.getElementById("client-list").addEventListener("click", (e) => {
  const row = e.target.closest(".client-row");
  if (row) selectClient(row.dataset.name);
});

document.getElementById("main").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) {
    handleAction(selected, btn.dataset.action);
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
  const joinBtn = e.target.closest(".server-join-btn");
  if (joinBtn) {
    // The Home favorite bar has no dropdown - it picks a client directly
    // (data-client) for a true one-click join; the Servers page offers a
    // choice via a sibling <select> when more than one client is installed.
    const clientName = joinBtn.dataset.client ?? joinBtn.closest(".server-join").querySelector(".server-client-select").value;
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
    for (const address of KNOWN_SERVERS) delete serverStatusCache[address];
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

document.getElementById("main").addEventListener("change", (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-target]');
  if (cb) togglePk3Target(cb.dataset.filename, cb.dataset.target, cb.checked);
});

document.getElementById("main").addEventListener("input", (e) => {
  const monolithSearchEl = e.target.closest("#monolith-search");
  if (monolithSearchEl) {
    monolithSearch = monolithSearchEl.value;
    monolithPage = 0;
    const resultsEl = document.getElementById("monolith-results");
    if (resultsEl) resultsEl.innerHTML = renderMonolithResults();
    return;
  }
  const installedSearchEl = e.target.closest("#installed-mods-search");
  if (installedSearchEl) {
    installedModsSearch = installedSearchEl.value;
    const resultsEl = document.getElementById("installed-mods-results");
    if (resultsEl) resultsEl.innerHTML = renderInstalledModsResults();
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
    `<p class="detail-status" style="margin-bottom: 1rem;">${message}</p>`
  );
});

init();
