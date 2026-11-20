"use strict";

const mailState = {
  status: null,
  mails: [],
  selectedId: null,
  statusFilter: "open",
  channelFilter: "shopify",
  pickedSource: false,
  composer: false,
  drafts: {},
  noteError: false,
  focusNote: false,
  device: sessionStorage.getItem("andy-mail-device") || "desktop",
  undo: null,
  ready: false,
};

const MAIL_LABEL = {
  open: "Open",
  approved: "Approved",
  changes: "Changes",
  omnisend: "OmniSend",
  shopify: "Shopify",
  unknown: "Mail",
  all: "All",
};

function mailView() {
  return document.body.dataset.view === "mails";
}

function cleanSubject(subject) {
  return String(subject || "").replace(/^\[(?:test|preview)\]\s*/i, "");
}

function shortFrom(mail) {
  const name = String(mail.from || "").replace(/<[^>]+>/g, "").replace(/"/g, "").trim();
  return name || mail.fromAddress || mail.from || "";
}

function mailEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function mailToast(message, canUndo) {
  if (!canUndo) mailState.undo = null;
  const toast = document.getElementById("toast");
  document.getElementById("toast-text").textContent = message;
  document.getElementById("toast-undo").hidden = !canUndo;
  toast.hidden = false;
  clearTimeout(mailToast.timer);
  mailToast.timer = setTimeout(() => {
    toast.hidden = true;
    mailState.undo = null;
  }, 7000);
}

function visibleMails() {
  return mailState.mails.filter((mail) => {
    const statusOk = mailState.statusFilter === "all" || mail.status === mailState.statusFilter;
    const channelOk = mailState.channelFilter === "all" || mail.channel === mailState.channelFilter;
    return statusOk && channelOk;
  });
}

function currentMail() {
  return mailState.mails.find((mail) => mail.id === mailState.selectedId) || null;
}

function markViewButtons() {
  document.querySelectorAll("[data-action='set-view']").forEach((button) => {
    const on = button.dataset.view === document.body.dataset.view;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function renderMailStats() {
  const scoped = mailState.mails.filter((mail) => mail.channel === mailState.channelFilter);
  const counts = { all: scoped.length, open: 0, approved: 0, changes: 0 };
  scoped.forEach((mail) => { counts[mail.status] += 1; });
  const filters = [["all", "All"], ["open", "Open"], ["approved", "Approved"], ["changes", "Changes"]]
    .filter(([status]) => status === "all" || status === mailState.statusFilter || counts[status] > 0);
  document.getElementById("stats").innerHTML = filters.map(([status, label]) => {
    const on = mailState.statusFilter === status;
    return `<button type="button" class="stat${on ? " is-on" : ""}" aria-pressed="${on}" data-action="filter" data-value="${status}"><strong>${counts[status]}</strong><span>${label}</span></button>`;
  }).join("");
  document.title = counts.open ? `MVP Approval · ${counts.open} open` : "MVP Approval";
}

function renderMailChannels() {
  const el = document.getElementById("channel-filter");
  el.hidden = true;
  el.innerHTML = "";
  document.querySelectorAll("#mail-source [data-action='channel']").forEach((button) => {
    const on = button.dataset.value === mailState.channelFilter;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function renderMailQueue() {
  const sc = document.getElementById("queue-scroll");
  const mails = visibleMails();
  if (!mails.length) {
    const source = mailState.channelFilter === "omnisend" ? "OmniSend" : "Shopify";
    sc.innerHTML = `<p class="queue-empty">${mailState.mails.length ? `No ${source} mail yet.` : "No preview yet."}</p>`;
    return;
  }
  sc.innerHTML = mails.map((mail) => `
    <button type="button" class="q-item q-item-plain${mail.id === mailState.selectedId ? " is-on" : ""}" data-action="select" data-id="${mail.id}" ${mail.id === mailState.selectedId ? 'aria-current="true"' : ""}>
      <span class="q-copy">
        <span class="q-name">${mailEsc(cleanSubject(mail.subject))}</span>
        <span class="q-meta"><span class="dot ${mail.status}"></span>${MAIL_LABEL[mail.status]}</span>
      </span>
    </button>`).join("");
}

function setupHtml() {
  const address = mailState.status?.address || "mvp.preview@gmail.com";
  return `<div class="done">
    <p class="eyebrow">Inbox</p>
    <h2>Preview address</h2>
    <p>Test mail from OmniSend and Shopify goes to this address. The app shows the full mail here.</p>
    <p class="address-line">${mailEsc(address)} <button type="button" class="btn ink" data-action="copy-address">Copy address</button></p>
    <ol class="setup-steps">
      <li>Create the Gmail account ${mailEsc(address)} if it does not exist yet.</li>
      <li>Turn on 2-Step Verification for that account.</li>
      <li>Under Google Account → Security, create an app password named MVP Approval.</li>
      <li>Put that app password in the .env file after GMAIL_APP_PASSWORD.</li>
      <li>Start the app again with starten.bat.</li>
    </ol>
    <p>Use the same address in OmniSend under Send test email and in Shopify under Send test.</p>
  </div>`;
}

function offlineHtml() {
  return `<div class="done">
    <p class="eyebrow">Server</p>
    <h2>Open this with starten.bat</h2>
    <p>The mail preview needs MVP Approval. Double-click starten.bat and the right page opens.</p>
  </div>`;
}

function emptyMailHtml() {
  const address = mailState.status?.address || "";
  return `<div class="done">
    <p class="eyebrow">Waiting for a preview</p>
    <h2>No mail yet.</h2>
    <p>Send a test from OmniSend or Shopify to this address. It shows up here with the subject and the full mail.</p>
    <p class="address-line">${mailEsc(address)} <button type="button" class="btn ink" data-action="copy-address">Copy address</button></p>
  </div>`;
}

function mailHead(mail, list) {
  const index = list.findIndex((entry) => entry.id === mail.id);
  const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(mail.date));
  const pager = list.length > 1 ? `<span class="pager pager-inline">
      <button type="button" data-action="prev" ${index > 0 ? "" : "disabled"}>Previous</button>
      <span>${index + 1} of ${list.length}</span>
      <button type="button" data-action="next" ${index < list.length - 1 ? "" : "disabled"}>Next</button>
    </span>` : "";
  const device = mailState.device === "mobile" ? "mobile" : "desktop";
  return `<div class="mail-head">
    <div class="mail-head-copy">
      <h2 class="mail-subject">${mailEsc(cleanSubject(mail.subject))}</h2>
      <p class="sub"><span>${mailEsc(shortFrom(mail))} · ${when}</span>${pager}</p>
    </div>
    <div class="mail-toolbar" role="group" aria-label="Width">
      <button type="button" class="chip${device === "desktop" ? " is-on" : ""}" data-action="device" data-value="desktop">Desktop</button>
      <button type="button" class="chip${device === "mobile" ? " is-on" : ""}" data-action="device" data-value="mobile">Phone</button>
    </div>
  </div>`;
}

function mailDock(mail) {
  const draft = mailState.drafts[mail.id] != null ? mailState.drafts[mail.id] : (mail.note || "");
  const showComposer = mailState.composer || mail.status === "changes";
  const dirty = draft.trim() !== (mail.note || "").trim();
  const saveDisabled = !draft.trim() || (mail.status === "changes" && !dirty);
  const composer = showComposer ? `<div class="composer">
      <label for="note">What needs to change?</label>
      <textarea id="note" maxlength="500" class="${mailState.noteError ? "is-error" : ""}" placeholder="A short note on what to change.">${mailEsc(draft)}</textarea>
      <div class="composer-foot">
        <p class="error" id="note-error" ${mailState.noteError ? "" : "hidden"}>Add a short note on what to change.</p>
        <p class="note-count" id="note-count">${draft.length} / 500</p>
      </div>
      <button type="button" class="btn save" data-action="save-changes" ${saveDisabled ? "disabled" : ""}>${mail.status === "changes" ? "Save changes" : "Save note"}</button>
    </div>` : "";
  return `<div class="actions">
      <button type="button" class="decide approve${mail.status === "approved" ? " is-on" : ""}" data-action="approve">${mail.status === "approved" ? "Approved" : "Approve"}</button>
      <button type="button" class="decide changes${mail.status === "changes" ? " is-on" : ""}" data-action="compose">Needs changes</button>
    </div>
    ${composer}
    ${mail.status !== "open" ? '<div class="tools"><button type="button" class="text-btn" data-action="reopen">Reopen</button></div>' : ""}`;
}

function renderMailStage() {
  const stage = document.getElementById("stage");
  if (!mailState.ready) {
    stage.innerHTML = `<div class="done"><p>Loading mail…</p></div>`;
    return;
  }
  if (!mailState.status) {
    stage.innerHTML = offlineHtml();
    return;
  }
  if (!mailState.status.configured && !mailState.mails.length) {
    stage.innerHTML = setupHtml();
    return;
  }
  const list = visibleMails();
  const mail = currentMail();
  if (!mailState.mails.length) {
    stage.innerHTML = emptyMailHtml();
    return;
  }
  if (!mail || !list.some((entry) => entry.id === mail.id)) {
    const source = mailState.channelFilter === "omnisend" ? "OmniSend" : "Shopify";
    stage.innerHTML = `<div class="done"><p class="eyebrow">${source}</p><h2>No ${source} mail yet.</h2><p>Send a test to this inbox, or switch to the other one above.</p></div>`;
    return;
  }
  const device = mailState.device === "mobile" ? "mobile" : "desktop";
  stage.innerHTML = `<div class="review mail-review">
      ${mailHead(mail, list)}
      <div class="mail-frame${device === "mobile" ? " is-mobile" : ""}">
        <iframe sandbox="allow-popups allow-popups-to-escape-sandbox" title="${mailEsc(mail.subject)}" src="/api/mails/${mail.id}/html"></iframe>
      </div>
      <div class="dock">${mailDock(mail)}</div>
    </div>`;
  if (mailState.focusNote) {
    mailState.focusNote = false;
    const note = document.getElementById("note");
    if (note) {
      note.focus();
      note.setSelectionRange(note.value.length, note.value.length);
    }
  }
}

function renderMailFoot() {
  const foot = document.querySelector(".queue-foot");
  if (!foot || !mailView()) return;
  foot.dataset.mode = "mails";
  const sync = mailState.status?.lastSync
    ? `Last checked ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(mailState.status.lastSync))}`
    : "Inbox not checked yet";
  const error = mailState.status?.error ? `<p class="sync-line">${mailEsc(mailState.status.error)}</p>` : "";
  foot.innerHTML = `
    <p class="sync-line">${sync}</p>
    ${error}`;
}

function renderMails() {
  markViewButtons();
  if (!mailView()) return;
  renderMailStats();
  renderMailChannels();
  renderMailQueue();
  renderMailStage();
  renderMailFoot();
}

async function loadMails() {
  try {
    const statusRes = await fetch("/api/status");
    if (!statusRes.ok) throw new Error("status");
    mailState.status = await statusRes.json();
    const mailRes = await fetch("/api/mails");
    const payload = await mailRes.json();
    mailState.mails = payload.mails || [];
  } catch {
    mailState.status = null;
    mailState.mails = [];
  }
  mailState.ready = true;
  if (!mailState.pickedSource) {
    const hasShopify = mailState.mails.some((mail) => mail.channel === "shopify");
    const hasOmni = mailState.mails.some((mail) => mail.channel === "omnisend");
    if (!hasShopify && hasOmni) mailState.channelFilter = "omnisend";
    mailState.pickedSource = true;
  }
  const signature = JSON.stringify(mailState.mails) + JSON.stringify(mailState.status);
  const typing = document.activeElement && document.activeElement.id === "note";
  if (signature === mailState.signature && mailState.readyPainted && typing) return;
  const unchanged = signature === mailState.signature && mailState.readyPainted;
  const visible = visibleMails();
  if (!mailState.selectedId || !visible.some((mail) => mail.id === mailState.selectedId)) {
    const open = visible.find((mail) => mail.status === "open");
    mailState.selectedId = (open || visible[0] || {}).id || null;
    if (!mailState.readyPainted) {
      mailState.statusFilter = mailState.mails.some((mail) => mail.status === "open") ? "open" : "all";
    }
  }
  const mail = currentMail();
  if (mail && mailState.drafts[mail.id] == null) mailState.drafts[mail.id] = mail.note || "";
  if (!typing) mailState.composer = mail?.status === "changes";
  mailState.signature = signature;
  mailState.readyPainted = true;
  if (!unchanged) renderMails();
}

function selectMail(id) {
  mailState.selectedId = id;
  mailState.noteError = false;
  const mail = currentMail();
  if (mail && mailState.drafts[mail.id] == null) mailState.drafts[mail.id] = mail.note || "";
  mailState.composer = mail?.status === "changes";
  renderMails();
}

function moveMail(step) {
  const list = visibleMails();
  const index = list.findIndex((mail) => mail.id === mailState.selectedId);
  const next = list[index + step];
  if (next) selectMail(next.id);
}

async function saveMail(patch) {
  const mail = currentMail();
  if (!mail) return null;
  const previous = { status: mail.status, note: mail.note, channel: mail.channel, decidedAt: mail.decidedAt };
  const response = await fetch(`/api/mails/${mail.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    mailToast("Could not save.", false);
    return null;
  }
  const payload = await response.json();
  Object.assign(mail, payload.mail);
  mailState.drafts[mail.id] = mail.note || "";
  mailState.undo = { id: mail.id, previous };
  return previous;
}

async function approveMail() {
  const mail = currentMail();
  if (!mail || mail.status === "approved") return;
  await saveMail({ status: "approved", channel: mail.channel });
  mailState.composer = false;
  mailToast(`${cleanSubject(mail.subject)} approved.`, true);
  renderMails();
}

async function saveMailChanges() {
  const mail = currentMail();
  if (!mail) return;
  const note = (mailState.drafts[mail.id] || "").trim();
  if (!note) {
    mailState.noteError = true;
    mailState.composer = true;
    mailState.focusNote = true;
    renderMails();
    return;
  }
  await saveMail({ status: "changes", note, channel: mail.channel });
  mailState.composer = true;
  mailToast(`${cleanSubject(mail.subject)} needs changes.`, true);
  renderMails();
}

async function reopenMail() {
  const mail = currentMail();
  if (!mail || mail.status === "open") return;
  await saveMail({ status: "open", channel: mail.channel });
  mailState.composer = false;
  mailToast(`${cleanSubject(mail.subject)} reopened.`, true);
  renderMails();
}

async function undoMail() {
  const entry = mailState.undo;
  mailState.undo = null;
  document.getElementById("toast").hidden = true;
  if (!entry) return;
  mailState.selectedId = entry.id;
  await saveMail({
    status: entry.previous.status,
    note: entry.previous.note,
    channel: entry.previous.channel,
  });
  mailState.undo = null;
  mailState.composer = entry.previous.status === "changes";
  mailToast("Undone.", false);
  renderMails();
}

function bindMail() {
  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === "set-view") {
      document.body.dataset.view = button.dataset.view;
      if (button.dataset.view === "mails") document.body.dataset.sourceOpen = "true";
      else delete document.body.dataset.sourceOpen;
      markViewButtons();
      if (button.dataset.view === "mails") renderMails();
      return;
    }
    if (!mailView()) return;
    if (action === "select") selectMail(button.dataset.id);
    if (action === "filter") {
      mailState.statusFilter = button.dataset.value;
      const list = visibleMails();
      if (list.length && !list.some((mail) => mail.id === mailState.selectedId)) mailState.selectedId = list[0].id;
      renderMails();
    }
    if (action === "channel") {
      mailState.pickedSource = true;
      mailState.channelFilter = button.dataset.value;
      const list = visibleMails();
      if (list.length && !list.some((mail) => mail.id === mailState.selectedId)) mailState.selectedId = list[0].id;
      renderMails();
    }
    if (action === "approve") approveMail();
    if (action === "compose") {
      mailState.composer = true;
      mailState.focusNote = true;
      renderMails();
    }
    if (action === "save-changes") saveMailChanges();
    if (action === "reopen") reopenMail();
    if (action === "prev") moveMail(-1);
    if (action === "next") moveMail(1);
    if (action === "device") {
      mailState.device = button.dataset.value;
      sessionStorage.setItem("andy-mail-device", mailState.device);
      renderMails();
    }
    if (action === "undo") undoMail();
    if (action === "copy-address") {
      const address = mailState.status?.address || "mvp.preview@gmail.com";
      navigator.clipboard.writeText(address).then(() => mailToast("Address copied.", false));
    }
  });

  document.body.addEventListener("input", (event) => {
    if (!mailView() || event.target.id !== "note") return;
    const mail = currentMail();
    if (!mail) return;
    mailState.drafts[mail.id] = event.target.value;
    mailState.noteError = false;
    const save = document.querySelector("[data-action='save-changes']");
    if (save) save.disabled = !event.target.value.trim() || (mail.status === "changes" && event.target.value.trim() === (mail.note || "").trim());
    const counter = document.getElementById("note-count");
    if (counter) counter.textContent = `${event.target.value.length} / 500`;
    const error = document.getElementById("note-error");
    if (error) error.hidden = true;
    event.target.classList.remove("is-error");
  });

  document.body.addEventListener("change", async (event) => {
    if (!mailView() || !event.target.matches("[data-action='move-channel']")) return;
    const mail = currentMail();
    if (!mail) return;
    await saveMail({ status: mail.status, note: mail.note, channel: event.target.value });
    mailState.undo = null;
    mailToast(`Moved to ${MAIL_LABEL[event.target.value] || "Mail"}.`, false);
    renderMails();
  });

  window.addEventListener("keydown", (event) => {
    if (!mailView()) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (event.key === "Escape") {
      const mail = currentMail();
      mailState.composer = mail?.status === "changes";
      mailState.noteError = false;
      renderMails();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && (mailState.composer || currentMail()?.status === "changes")) {
      event.preventDefault();
      saveMailChanges();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || typing) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      approveMail();
    } else if (key === "b") {
      event.preventDefault();
      mailState.composer = true;
      mailState.focusNote = true;
      renderMails();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveMail(-1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveMail(1);
    }
  });
}

bindMail();
loadMails();
setInterval(() => { if (mailView()) loadMails(); }, 15000);
