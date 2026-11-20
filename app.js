"use strict";

const LABEL = {
  open: "Open",
  approved: "Approved",
  changes: "Changes",
  ads: "Ads",
  omnisend: "OmniSend",
  image: "Image",
  video: "Video",
};

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 17 19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v16M6 5h11l-2.2 4L17 13H6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const DB_NAME = "andy-approval";
const STORE = "items";

const state = {
  items: [],
  urls: new Map(),
  drafts: {},
  selectedId: null,
  statusFilter: "open",
  channelFilter: "all",
  composer: false,
  noteError: false,
  focusNote: false,
  confirmDelete: false,
  pendingChannel: "ads",
  ensureVisible: false,
  ready: false,
  busy: false,
  undo: null,
};

let memoryMode = false;
let dbPromise = null;
let saving = false;
let toastToken = 0;
let toastTimer = 0;
let dragDepth = 0;

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function idbAll() {
  return db().then((database) => new Promise((resolve, reject) => {
    const req = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbPut(item) {
  if (memoryMode) return Promise.resolve();
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(id) {
  if (memoryMode) return Promise.resolve();
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function kindOf(file) {
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogg)$/.test(name)) return "video";
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)$/.test(name)) return "image";
  return null;
}

function prettyName(filename) {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return base || filename;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}

function urlFor(item) {
  if (!state.urls.has(item.id)) state.urls.set(item.id, URL.createObjectURL(item.blob));
  return state.urls.get(item.id);
}

function current() {
  return state.items.find((item) => item.id === state.selectedId) || null;
}

function channelOk(item) {
  return item.channel !== "omnisend";
}

function visibleItems() {
  return state.items
    .filter((item) => state.statusFilter === "all" || item.status === state.statusFilter)
    .filter(channelOk)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function toast(message, canUndo) {
  if (!canUndo) state.undo = null;
  const token = ++toastToken;
  const el = document.getElementById("toast");
  document.getElementById("toast-text").textContent = message;
  document.getElementById("toast-undo").hidden = !canUndo;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (token !== toastToken) return;
    el.hidden = true;
    state.undo = null;
  }, 7000);
}

function setBusy(label) {
  state.busy = Boolean(label);
  const el = document.getElementById("busy");
  el.hidden = !label;
  el.textContent = label || "";
}

function renderStats() {
  const counts = { all: state.items.length, open: 0, approved: 0, changes: 0 };
  state.items.forEach((item) => { counts[item.status] += 1; });
  const filters = [["all", "All"], ["open", "Open"], ["approved", "Approved"], ["changes", "Changes"]]
    .filter(([status]) => status === "all" || status === state.statusFilter || counts[status] > 0);
  document.getElementById("stats").innerHTML = filters.map(([status, label]) => {
    const on = state.statusFilter === status;
    return `<button type="button" class="stat${on ? " is-on" : ""}" aria-pressed="${on}" data-action="filter" data-value="${status}"><strong>${counts[status]}</strong><span>${label}</span></button>`;
  }).join("");
  document.title = counts.open ? `MVP Approval · ${counts.open} open` : "MVP Approval";
}

function renderChannelFilter() {
  const el = document.getElementById("channel-filter");
  el.hidden = true;
  el.innerHTML = "";
}

function queueItemHtml(item) {
  const url = urlFor(item);
  const media = item.kind === "video"
    ? `<video src="${esc(url)}#t=0.1" muted preload="metadata" tabindex="-1" aria-hidden="true"></video>`
    : `<img src="${esc(url)}" alt="">`;
  return `<button type="button" class="q-item" data-action="select" data-id="${esc(item.id)}" title="${esc(item.name)}">
    <span class="thumb">${media}</span>
    <span class="q-copy">
      <span class="q-name">${esc(item.name)}</span>
      <span class="q-meta"><span class="dot ${item.status}"></span>${LABEL[item.kind]} · ${LABEL[item.status]}</span>
    </span>
  </button>`;
}

function renderQueue() {
  const sc = document.getElementById("queue-scroll");
  const items = visibleItems();
  const signature = items.map((item) => `${item.id}:${item.status}:${item.name}:${item.channel}`).join("|");
  if (sc.dataset.signature !== signature) {
    const prevTop = sc.scrollTop;
    sc.dataset.signature = signature;
    sc.innerHTML = items.length
      ? items.map(queueItemHtml).join("")
      : `<p class="queue-empty">No creatives in this view.</p>`;
    sc.scrollTop = prevTop;
  }
  sc.querySelectorAll(".q-item").forEach((el) => {
    const on = el.dataset.id === state.selectedId;
    el.classList.toggle("is-on", on);
    if (on) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
  });
  if (state.ensureVisible) {
    sc.querySelector(".q-item.is-on")?.scrollIntoView({ block: "nearest" });
    state.ensureVisible = false;
  }
}

function landingHtml() {
  return `<div class="landing">
    <div>
      <p class="eyebrow">Ad Creatives</p>
      <h2>Add images &amp; videos</h2>
      <p>Drop ad images and videos here. Then one click: approve, or mark what needs to change. Everything stays in this browser.</p>
    </div>
    <div class="landing-zones">
      <button type="button" class="landing-zone" data-action="add" data-channel="ads"><span class="plus" aria-hidden="true">+</span><strong>Add</strong><span>Images &amp; videos</span></button>
    </div>
  </div>`;
}

function doneHtml() {
  const openItems = state.items.filter((item) => item.status === "open");
  let title = "No creatives in this view.";
  let text = "Switch the view to see everything.";
  if (state.statusFilter === "open" && openItems.length === 0) {
    title = "Nothing left open.";
    text = "Everything is approved or needs changes.";
  } else if (state.statusFilter === "open") {
    title = "Nothing open in this channel.";
    text = "There are still open creatives in the other view.";
  } else if (state.statusFilter === "changes") {
    title = "Nothing needs changes.";
    text = "Nothing is flagged in this view.";
  } else if (state.statusFilter === "approved") {
    title = "Nothing approved yet.";
    text = "Nothing is approved in this view.";
  }
  return `<div class="done"><p class="eyebrow">View</p><h2>${title}</h2><p>${text}</p><button type="button" class="btn ink" data-action="show-all">Show all</button></div>`;
}

function mediaHtml(item) {
  const url = esc(urlFor(item));
  if (item.kind === "video") {
    return `<div class="media-frame"><video src="${url}" controls playsinline preload="metadata" aria-label="${esc(item.name)}"></video></div>`;
  }
  return `<div class="media-frame"><button type="button" class="zoom" data-action="zoom" aria-label="Large view of ${esc(item.name)}"><img src="${url}" alt="${esc(item.name)}"></button></div>`;
}

function noteDirty(item) {
  return (state.drafts[item.id] || "").trim() !== (item.note || "").trim();
}

function dockHtml(item, list) {
  const idx = list.findIndex((entry) => entry.id === item.id);
  const draft = state.drafts[item.id] != null ? state.drafts[item.id] : (item.note || "");
  const showComposer = state.composer || item.status === "changes";
  const saveDisabled = !draft.trim() || (item.status === "changes" && !noteDirty(item));
  const when = item.decidedAt && item.status !== "open"
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(item.decidedAt)
    : "";
  const composer = showComposer ? `<div class="composer">
      <label for="note">What needs to change?</label>
      <textarea id="note" maxlength="500" class="${state.noteError ? "is-error" : ""}" aria-invalid="${state.noteError ? "true" : "false"}" placeholder="A short note on what to change.">${esc(draft)}</textarea>
      <div class="composer-foot">
        <p class="error" id="note-error" ${state.noteError ? "" : "hidden"}>Add a short note on what to change.</p>
        <p class="note-count" id="note-count">${draft.length} / 500</p>
      </div>
      <button type="button" class="btn save" id="save-changes" data-action="save-changes" ${saveDisabled ? "disabled" : ""}>${item.status === "changes" ? "Save changes" : "Save note"}</button>
      <p class="hint">Ctrl+Enter saves</p>
    </div>` : "";
  const tools = state.confirmDelete
    ? `<div class="confirm"><span>Remove this creative?</span><button type="button" class="btn ink" data-action="delete-yes">Yes, remove</button><button type="button" class="text-btn" data-action="delete-no">Cancel</button></div>`
    : `<div class="tools">
        ${item.status !== "open" ? '<button type="button" class="text-btn" data-action="reopen">Reopen</button>' : ""}
        <button type="button" class="text-btn" data-action="delete-ask">Remove</button>
      </div>`;
  return `<div>
      <input id="item-name" class="name-input" maxlength="120" value="${esc(item.name)}" aria-label="Name" spellcheck="false" autocomplete="off">
      <p class="sub"><span>${LABEL[item.kind]} · ${formatBytes(item.blob.size)}${when ? ` · ${esc(when)}` : ""}</span></p>
    </div>
    <div class="pager">
      <button type="button" data-action="prev" ${idx > 0 ? "" : "disabled"}>Previous</button>
      <span>${idx + 1} of ${list.length}</span>
      <button type="button" data-action="next" ${idx >= 0 && idx < list.length - 1 ? "" : "disabled"}>Next</button>
    </div>
    <div class="actions">
      <button type="button" class="decide approve${item.status === "approved" ? " is-on" : ""}" data-action="approve" aria-pressed="${item.status === "approved"}" aria-keyshortcuts="F">${ICON.check} ${item.status === "approved" ? "Approved" : "Approve"}</button>
      <button type="button" class="decide changes${item.status === "changes" ? " is-on" : ""}" data-action="compose" aria-pressed="${item.status === "changes"}" aria-keyshortcuts="B">${ICON.flag} Needs changes</button>
    </div>
    ${composer}
    ${tools}`;
}

function reviewHtml(item, list) {
  return `<div class="review" data-id="${esc(item.id)}">
    <div class="mat">
      <span class="pill ${item.status}">${LABEL[item.status]}</span>
      ${mediaHtml(item)}
    </div>
    <div class="dock">${dockHtml(item, list)}</div>
  </div>`;
}

function renderStage() {
  const stage = document.getElementById("stage");
  if (!state.ready) {
    stage.innerHTML = `<div class="done"><p>Loading creatives…</p></div>`;
    return;
  }
  if (!state.items.length) {
    stage.innerHTML = landingHtml();
    return;
  }
  const list = visibleItems();
  const item = current();
  const showItem = item && list.some((entry) => entry.id === item.id);
  if (!showItem) {
    stage.innerHTML = doneHtml();
    return;
  }
  const review = stage.querySelector(".review");
  if (!review || review.dataset.id !== item.id) {
    stage.innerHTML = reviewHtml(item, list);
  } else {
    const pill = review.querySelector(".pill");
    pill.className = `pill ${item.status}`;
    pill.textContent = LABEL[item.status];
    review.querySelector(".dock").innerHTML = dockHtml(item, list);
  }
  if (state.focusNote) {
    state.focusNote = false;
    const note = document.getElementById("note");
    if (note) {
      note.focus();
      const end = note.value.length;
      note.setSelectionRange(end, end);
    }
  }
}

function creativeView() {
  return document.body.dataset.view === "creatives";
}

function renderCreativeFoot() {
  const foot = document.querySelector(".queue-foot");
  if (!foot || foot.dataset.mode === "creatives") return;
  foot.dataset.mode = "creatives";
  foot.innerHTML = "";
}

function render() {
  if (!creativeView()) return;
  renderStats();
  renderChannelFilter();
  renderQueue();
  renderStage();
  renderCreativeFoot();
}

function select(id) {
  if (id === state.selectedId && document.querySelector(".review")?.dataset.id === id) return;
  state.selectedId = id;
  state.confirmDelete = false;
  state.noteError = false;
  const item = current();
  if (item && state.drafts[item.id] == null) state.drafts[item.id] = item.note || "";
  state.composer = item?.status === "changes";
  state.ensureVisible = true;
  render();
}

function move(step) {
  const list = visibleItems();
  const idx = list.findIndex((item) => item.id === state.selectedId);
  if (idx < 0) return;
  const next = list[idx + step];
  if (next) select(next.id);
}

function setStatusFilter(value) {
  state.statusFilter = value;
  const list = visibleItems();
  if (list.length && !list.some((item) => item.id === state.selectedId)) {
    select(list[0].id);
    return;
  }
  render();
}

function setChannelFilter(value) {
  state.channelFilter = value;
  const list = visibleItems();
  if (list.length && !list.some((item) => item.id === state.selectedId)) {
    select(list[0].id);
    return;
  }
  render();
}

function showAll() {
  state.statusFilter = "all";
  state.channelFilter = "all";
  const first = visibleItems()[0];
  if (first) select(first.id);
  else render();
}

function openComposer() {
  const item = current();
  if (!item) return;
  if (state.drafts[item.id] == null) state.drafts[item.id] = item.note || "";
  if (state.composer && document.getElementById("note")) {
    document.getElementById("note").focus();
    return;
  }
  state.composer = true;
  state.focusNote = true;
  state.noteError = false;
  render();
}

async function commit(item, status, note) {
  if (saving) return;
  const undo = {
    id: item.id,
    prev: { status: item.status, note: item.note, decidedAt: item.decidedAt },
    statusFilter: state.statusFilter,
    channelFilter: state.channelFilter,
    selectedId: state.selectedId,
  };
  const previousCreatedAt = item.createdAt;
  item.status = status;
  item.note = note;
  item.decidedAt = status === "open" ? null : Date.now();
  state.drafts[item.id] = note;
  state.composer = status === "changes";
  state.noteError = false;
  state.confirmDelete = false;
  saving = true;
  try {
    await idbPut(item);
  } catch (err) {
    item.status = undo.prev.status;
    item.note = undo.prev.note;
    item.decidedAt = undo.prev.decidedAt;
    toast("Could not save.", false);
    render();
    return;
  } finally {
    saving = false;
  }
  state.undo = undo;
  if (!visibleItems().some((entry) => entry.id === item.id)) {
    const list = visibleItems();
    const next = list.find((entry) => entry.createdAt > previousCreatedAt) || list[0] || null;
    if (next) {
      state.selectedId = next.id;
      if (state.drafts[next.id] == null) state.drafts[next.id] = next.note || "";
      state.composer = next.status === "changes";
      state.ensureVisible = true;
    }
  }
  const verb = status === "approved" ? "approved" : status === "changes" ? "needs changes" : "reopened";
  const nothingOpen = status !== "open" && !state.items.some((entry) => entry.status === "open");
  toast(`${item.name} ${verb}.${nothingOpen ? " Nothing left open." : ""}`, true);
  render();
}

async function approve() {
  const item = current();
  if (!item || item.status === "approved") return;
  await commit(item, "approved", "");
}

async function saveChanges() {
  const item = current();
  if (!item) return;
  const note = (state.drafts[item.id] || "").trim();
  if (!note) {
    state.noteError = true;
    state.composer = true;
    state.focusNote = true;
    render();
    return;
  }
  if (item.status === "changes" && note === (item.note || "").trim()) return;
  await commit(item, "changes", note);
}

async function reopen() {
  const item = current();
  if (!item || item.status === "open") return;
  await commit(item, "open", "");
}

async function undo() {
  const entry = state.undo;
  if (!entry) return;
  const item = state.items.find((candidate) => candidate.id === entry.id);
  clearTimeout(toastTimer);
  document.getElementById("toast").hidden = true;
  state.undo = null;
  if (!item) return;
  item.status = entry.prev.status;
  item.note = entry.prev.note;
  item.decidedAt = entry.prev.decidedAt;
  state.drafts[item.id] = item.note || "";
  state.statusFilter = entry.statusFilter;
  state.channelFilter = entry.channelFilter;
  state.selectedId = entry.selectedId;
  state.composer = item.status === "changes";
  state.confirmDelete = false;
  try {
    await idbPut(item);
  } catch (err) {
    toast("Could not undo.", false);
    render();
    return;
  }
  toast("Undone.", false);
  render();
}

async function rename(value) {
  const item = current();
  if (!item) return;
  const name = value.trim();
  if (!name || name === item.name) {
    const input = document.getElementById("item-name");
    if (input) input.value = item.name;
    return;
  }
  item.name = name;
  try {
    await idbPut(item);
  } catch (err) {
    toast("Could not save the name.", false);
  }
  render();
}

async function moveChannel(channel) {
  const item = current();
  if (!item || (channel !== "ads" && channel !== "omnisend") || item.channel === channel) return;
  item.channel = channel;
  try {
    await idbPut(item);
  } catch (err) {
    toast("Could not save.", false);
    render();
    return;
  }
  toast(`Moved to ${LABEL[channel]}.`, false);
  const list = visibleItems();
  if (list.length && !list.some((entry) => entry.id === item.id)) {
    state.selectedId = list[0].id;
    const next = current();
    if (next && state.drafts[next.id] == null) state.drafts[next.id] = next.note || "";
    state.composer = Boolean(next && next.status === "changes");
    state.confirmDelete = false;
  }
  render();
}

async function removeItem() {
  const item = current();
  if (!item) return;
  const id = item.id;
  try {
    await idbDelete(id);
  } catch (err) {
    state.confirmDelete = false;
    toast("Could not remove.", false);
    render();
    return;
  }
  state.items = state.items.filter((entry) => entry.id !== id);
  const url = state.urls.get(id);
  if (url) URL.revokeObjectURL(url);
  state.urls.delete(id);
  delete state.drafts[id];
  state.confirmDelete = false;
  state.undo = null;
  const list = visibleItems();
  state.selectedId = list[0] ? list[0].id : (state.items[0] ? state.items[0].id : null);
  const next = current();
  if (next) {
    if (state.drafts[next.id] == null) state.drafts[next.id] = next.note || "";
    state.composer = next.status === "changes";
  }
  toast("Creative removed.", false);
  render();
}

function pickFiles(channel) {
  if (state.busy) return;
  state.pendingChannel = channel;
  const input = document.getElementById("file-input");
  input.value = "";
  input.click();
}

async function ingest(fileList, channel) {
  if (!creativeView()) return;
  if (state.busy) {
    toast("Please wait, files are being saved.", false);
    return;
  }
  const incoming = [...fileList];
  const valid = incoming.filter((file) => file.size > 0 && kindOf(file));
  const skipped = incoming.length - valid.length;
  if (!valid.length) {
    toast("Images and videos only.", false);
    return;
  }
  const added = [];
  const failed = [];
  const base = Date.now();
  for (let i = 0; i < valid.length; i += 1) {
    const file = valid[i];
    setBusy(`Saving ${i + 1} of ${valid.length}…`);
    const item = {
      id: uid(),
      name: prettyName(file.name),
      channel,
      kind: kindOf(file),
      blob: file,
      status: "open",
      note: "",
      createdAt: base + i,
      decidedAt: null,
    };
    try {
      await idbPut(item);
      state.items.push(item);
      added.push(item);
    } catch (err) {
      failed.push(file.name);
    }
  }
  setBusy("");
  if (added.length) {
    state.statusFilter = "open";
    state.channelFilter = channel;
    state.selectedId = added[0].id;
    state.drafts[added[0].id] = "";
    state.composer = false;
    state.confirmDelete = false;
    state.ensureVisible = true;
  }
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed.length) parts.push(`${failed.length} not saved`);
  toast(parts.join(", ") + ".", false);
  render();
}

function zoom() {
  const item = current();
  if (!item || item.kind !== "image") return;
  const img = document.getElementById("light-img");
  img.src = urlFor(item);
  img.alt = item.name;
  document.getElementById("lightbox").showModal();
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function hideOverlay() {
  dragDepth = 0;
  const overlay = document.getElementById("drop-overlay");
  overlay.hidden = true;
  overlay.querySelectorAll("[data-drop]").forEach((zone) => zone.classList.remove("is-hot"));
}

function bind() {
  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "set-view") {
      document.body.dataset.view = button.dataset.view;
      if (button.dataset.view === "mails") document.body.dataset.sourceOpen = "true";
      else delete document.body.dataset.sourceOpen;
      if (button.dataset.view === "creatives") render();
      return;
    }
    if (!creativeView()) return;
    if (action === "add") pickFiles(button.dataset.channel);
    if (action === "select") select(button.dataset.id);
    if (action === "filter") setStatusFilter(button.dataset.value);
    if (action === "channel") setChannelFilter(button.dataset.value);
    if (action === "show-all") showAll();
    if (action === "approve") approve();
    if (action === "compose") openComposer();
    if (action === "save-changes") saveChanges();
    if (action === "reopen") reopen();
    if (action === "prev") move(-1);
    if (action === "next") move(1);
    if (action === "delete-ask") {
      state.confirmDelete = true;
      render();
    }
    if (action === "delete-no") {
      state.confirmDelete = false;
      render();
    }
    if (action === "delete-yes") removeItem();
    if (action === "undo") undo();
    if (action === "zoom") zoom();
    if (action === "close-light") document.getElementById("lightbox").close();
  });

  document.body.addEventListener("input", (event) => {
    if (!creativeView()) return;
    if (event.target.id !== "note") return;
    const item = current();
    if (!item) return;
    state.drafts[item.id] = event.target.value;
    state.noteError = false;
    const save = document.getElementById("save-changes");
    if (save) save.disabled = !event.target.value.trim() || (item.status === "changes" && event.target.value.trim() === (item.note || "").trim());
    const counter = document.getElementById("note-count");
    if (counter) counter.textContent = `${event.target.value.length} / 500`;
    const error = document.getElementById("note-error");
    if (error) error.hidden = true;
    event.target.classList.remove("is-error");
  });

  document.body.addEventListener("change", (event) => {
    if (!creativeView()) return;
    if (event.target.id === "item-name") rename(event.target.value);
    if (event.target.matches("[data-action='move-channel']")) moveChannel(event.target.value);
  });

  document.getElementById("file-input").addEventListener("change", (event) => {
    if (event.target.files?.length) ingest(event.target.files, state.pendingChannel);
  });

  window.addEventListener("keydown", (event) => {
    if (!creativeView()) return;
    const lightbox = document.getElementById("lightbox");
    if (lightbox.open && event.key !== "Escape") return;
    if (event.key === "Escape") {
      if (lightbox.open) return;
      state.confirmDelete = false;
      state.noteError = false;
      const item = current();
      state.composer = item?.status === "changes";
      render();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if (state.composer || current()?.status === "changes") {
        event.preventDefault();
        saveChanges();
      }
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (typing && event.key === "Enter" && event.target.id === "item-name") {
      event.preventDefault();
      event.target.blur();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || typing) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      approve();
    } else if (key === "b") {
      event.preventDefault();
      openComposer();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    }
  });

  document.body.addEventListener("error", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLMediaElement) || !target.closest(".mat")) return;
    const fallback = document.createElement("p");
    fallback.className = "broken";
    fallback.textContent = target instanceof HTMLVideoElement
      ? "This browser can't play this video."
      : "This browser can't show this image.";
    if (target.closest(".zoom")) target.closest(".zoom").replaceWith(fallback);
    else target.replaceWith(fallback);
  }, true);

  const lightbox = document.getElementById("lightbox");
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) lightbox.close();
  });

  window.addEventListener("dragenter", (event) => {
    if (!creativeView() || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    document.getElementById("drop-overlay").hidden = false;
  });

  window.addEventListener("dragover", (event) => {
    if (!creativeView() || !hasFiles(event)) return;
    event.preventDefault();
    const el = event.target instanceof Element ? event.target : event.target.parentElement;
    const zone = el?.closest?.("[data-drop]") || null;
    document.querySelectorAll("#drop-overlay [data-drop]").forEach((entry) => {
      entry.classList.toggle("is-hot", entry === zone);
    });
  });

  window.addEventListener("dragleave", (event) => {
    if (!creativeView() || !hasFiles(event)) return;
    dragDepth -= 1;
    if (dragDepth <= 0) hideOverlay();
  });

  window.addEventListener("drop", (event) => {
    if (!creativeView() || !hasFiles(event)) return;
    event.preventDefault();
    const el = event.target instanceof Element ? event.target : event.target.parentElement;
    const zone = el?.closest?.("[data-drop]");
    hideOverlay();
    if (!zone) return;
    ingest(event.dataTransfer.files, zone.dataset.drop);
  });
}

async function init() {
  bind();
  render();
  try {
    state.items = (await idbAll()).sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    memoryMode = true;
    state.items = [];
    document.getElementById("memory-banner").hidden = false;
  }
  state.ready = true;
  state.statusFilter = state.items.some((item) => item.status === "open") ? "open" : "all";
  const list = visibleItems();
  state.selectedId = list[0] ? list[0].id : null;
  const item = current();
  if (item) {
    state.drafts[item.id] = item.note || "";
    state.composer = item.status === "changes";
  }
  render();
}

init();
