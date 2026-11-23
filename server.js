import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const htmlDir = path.join(dataDir, "html");
const stateFile = path.join(dataDir, "state.json");
const env = loadEnv(path.join(root, ".env"));
const port = Number(env.PORT || 8756);
const user = (env.GMAIL_USER || "").trim();
const pass = (env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const configured = Boolean(user && pass);
const andyEmail = (env.ANDY_EMAIL || "").trim();
const publicUrl = (env.PUBLIC_URL || "https://mvp-approval.onrender.com").replace(/\/$/, "");
const notifyLabel = "MVP-Notified";
const removedLabel = "MVP-Removed";
const toldAndy = new Set();
let deleting = false;

fs.mkdirSync(htmlDir, { recursive: true });

const store = readState();
let syncing = false;
let syncWait = null;

function loadEnv(file) {
  const out = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  for (const key of ["GMAIL_USER", "GMAIL_APP_PASSWORD", "PORT", "ANDY_EMAIL", "PUBLIC_URL"]) {
    if (process.env[key]) out[key] = process.env[key];
  }
  return out;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!Array.isArray(parsed.mails)) parsed.mails = [];
    if (!Array.isArray(parsed.removed)) parsed.removed = [];
    return parsed;
  } catch {
    return { mails: [], removed: [], lastSync: null, error: null };
  }
}

function writeState() {
  fs.writeFileSync(stateFile, JSON.stringify(store, null, 2));
}

function mailId(parsed) {
  const raw = parsed.messageId || `${parsed.subject || ""}|${parsed.date || ""}|${parsed.from?.text || ""}`;
  return crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 20);
}

function isAccountMail(fromAddress) {
  const from = (fromAddress || "").toLowerCase();
  return from.endsWith("@accounts.google.com") || from === "no-reply@google.com";
}

function channelOf(fromAddress, subject) {
  const from = (fromAddress || "").toLowerCase();
  const sub = subject || "";
  if (from.includes("omnisend")) return "omnisend";
  if (from.includes("shopify")) return "shopify";
  if (/\[\s*preview\s*\]/i.test(sub)) return "omnisend";
  if (/\[\s*test\s*\]/i.test(sub)) return "shopify";
  return "unknown";
}

function cleanSubject(subject) {
  return String(subject || "").replace(/^\[(?:test|preview)\]\s*/i, "").trim() || "(No subject)";
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function previewFromHtml(html) {
  const pattern = /<div\b[^>]*\bstyle="[^"]*display:\s*none[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const text = decodeEntities(match[1]).replace(/[\u00ad\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
    if (/[A-Za-z0-9]/.test(text)) return text.slice(0, 220);
  }
  return "";
}

function previewFor(mail) {
  if (mail.preview) return mail.preview;
  try {
    const html = fs.readFileSync(path.join(htmlDir, `${mail.id}.html`), "utf8");
    mail.preview = previewFromHtml(html);
  } catch {
    mail.preview = "";
  }
  return mail.preview;
}

function andyNote(mail) {
  const source = mail.channel === "omnisend" ? "OmniSend" : "Shopify";
  const title = cleanSubject(mail.subject);
  return {
    subject: `New preview to approve: ${title}`,
    text: [
      "There's a new email preview waiting for you.",
      "",
      `${source}: ${title}`,
      "",
      publicUrl,
    ].join("\n"),
  };
}

function hasLabel(labels, name) {
  for (const label of labels || []) {
    if (String(label).toLowerCase() === name.toLowerCase()) return true;
  }
  return false;
}

async function tellAndy(mail) {
  if (!andyEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(andyEmail)) return false;
  if (mail.channel !== "shopify" && mail.channel !== "omnisend") return false;
  if (toldAndy.has(mail.id)) return true;
  const age = Date.now() - new Date(mail.date).getTime();
  if (!Number.isFinite(age) || age > 1000 * 60 * 60 * 24 * 3) return false;
  const note = andyNote(mail);
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  await transport.sendMail({
    from: `"MVP Approval" <${user}>`,
    to: andyEmail,
    subject: note.subject,
    text: note.text,
  });
  toldAndy.add(mail.id);
  console.log(`Told Andy about a new preview: ${note.subject}`);
  return true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function documentHtml(parsed) {
  let html = parsed.html || "";
  if (!html) {
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><pre style="white-space:pre-wrap;font-family:Segoe UI,sans-serif">${escapeHtml(parsed.text || "Diese Mail hat keinen Inhalt.")}</pre></body></html>`;
  }
  for (const attachment of parsed.attachments || []) {
    if (!attachment.content) continue;
    const type = attachment.contentType || "application/octet-stream";
    const href = `data:${type};base64,${attachment.content.toString("base64")}`;
    if (attachment.cid) html = html.split(`cid:${attachment.cid}`).join(href);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8"><base target="_blank">');
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body>${html}</body></html>`;
}

function publicMail(mail) {
  return {
    id: mail.id,
    from: mail.from,
    fromAddress: mail.fromAddress,
    subject: mail.subject,
    preview: previewFor(mail),
    date: mail.date,
    channel: mail.channel,
    status: mail.status,
    note: mail.note,
    decidedAt: mail.decidedAt,
  };
}

function explainImapError(error) {
  const text = `${error?.authenticationFailed ? "auth" : ""} ${error?.message || error}`;
  if (/auth|invalid credentials|application-specific password|login/i.test(text)) {
    return "Gmail refused access. Check the address and the app password in the .env file.";
  }
  return "The inbox could not be read just now. Try again in a moment.";
}

async function mailboxPaths(client) {
  const paths = ["INBOX"];
  try {
    const boxes = await client.list();
    const junk = boxes.find((box) => box.specialUse === "\\Junk" || /spam/i.test(box.path || ""));
    if (junk?.path && junk.path !== "INBOX") paths.push(junk.path);
  } catch {
    paths.push("[Gmail]/Spam");
  }
  return paths;
}

async function importMailbox(client, mailbox) {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 45);
    const uids = await client.search({ since }, { uid: true });
    const list = Array.isArray(uids) ? uids : [];
    const seen = new Set();
    if (!list.length) return { added: 0, seen };
    let added = 0;
    const pending = [];
    for await (const message of client.fetch(list, { source: true, uid: true, labels: true }, { uid: true })) {
      const parsed = await simpleParser(message.source);
      const id = mailId(parsed);
      const fromAddress = parsed.from?.value?.[0]?.address || "";
      if (isAccountMail(fromAddress)) continue;
      seen.add(id);
      if (store.removed.includes(id) || hasLabel(message.labels, removedLabel)) {
        if (!store.removed.includes(id)) store.removed.push(id);
        continue;
      }
      const subject = parsed.subject || "(No subject)";
      if (!store.mails.some((mail) => mail.id === id)) {
        const html = documentHtml(parsed);
        fs.writeFileSync(path.join(htmlDir, `${id}.html`), html);
        store.mails.push({
          id,
          from: parsed.from?.text || fromAddress,
          fromAddress,
          subject,
          preview: previewFromHtml(html),
          date: (parsed.date || new Date()).toISOString(),
          channel: channelOf(fromAddress, subject),
          status: "open",
          note: "",
          decidedAt: null,
        });
        added += 1;
      }
      const saved = store.mails.find((mail) => mail.id === id);
      if (saved && !hasLabel(message.labels, notifyLabel)) pending.push({ uid: message.uid, mail: saved });
    }
    for (const item of pending) {
      try {
        const sent = await tellAndy(item.mail);
        if (sent) await client.messageFlagsAdd(item.uid, [notifyLabel], { uid: true, useLabels: true });
      } catch {
        console.error("Could not mail Andy about a new preview.");
      }
    }
    return { added, seen };
  } finally {
    lock.release();
  }
}

async function hideInGmail(id) {
  if (!configured) return;
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });
  try {
    await client.connect();
    const boxes = await mailboxPaths(client);
    for (const mailbox of boxes) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
        const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 45);
        const uids = await client.search({ since }, { uid: true });
        const list = Array.isArray(uids) ? uids.slice(-40) : [];
        const hits = [];
        if (list.length) {
          for await (const message of client.fetch(list, { source: true, uid: true }, { uid: true })) {
            const parsed = await simpleParser(message.source);
            if (mailId(parsed) === id) hits.push(message.uid);
          }
        }
        for (const uid of hits) {
          await client.messageFlagsAdd(uid, [removedLabel], { uid: true, useLabels: true });
        }
      } catch (error) {
        if (mailbox === "INBOX") throw error;
      } finally {
        if (lock) lock.release();
      }
    }
  } finally {
    try { await client.logout(); } catch { /* Verbindung ist schon zu. */ }
  }
}

async function removeMail(id) {
  deleting = true;
  try {
    if (syncing && syncWait) await syncWait;
    try {
      await hideInGmail(id);
    } catch {
      console.error("Could not mark the mail in Gmail.");
    }
    if (!store.removed.includes(id)) store.removed.push(id);
    store.mails = store.mails.filter((mail) => mail.id !== id);
    const file = path.join(htmlDir, `${id}.html`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    writeState();
  } finally {
    deleting = false;
  }
}

function pruneMissing(seen) {
  const windowMs = 1000 * 60 * 60 * 24 * 45;
  for (const mail of [...store.mails]) {
    const age = Date.now() - new Date(mail.date).getTime();
    if (!Number.isFinite(age) || age > windowMs) continue;
    if (seen.has(mail.id)) continue;
    store.mails = store.mails.filter((entry) => entry.id !== mail.id);
    const file = path.join(htmlDir, `${mail.id}.html`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function syncMailbox() {
  if (!configured) return { ok: false, error: "Inbox is not set up yet." };
  if (deleting) return { ok: true, added: 0 };
  if (syncing) return syncWait;
  syncing = true;
  syncWait = (async () => {
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
    });
    try {
      await client.connect();
      const boxes = await mailboxPaths(client);
      let added = 0;
      const seen = new Set();
      let inboxOk = false;
      for (const mailbox of boxes) {
        try {
          const result = await importMailbox(client, mailbox);
          added += result.added;
          for (const id of result.seen) seen.add(id);
          if (mailbox === "INBOX") inboxOk = true;
        } catch (error) {
          if (mailbox === "INBOX") throw error;
        }
      }
      if (inboxOk) pruneMissing(seen);
      store.lastSync = new Date().toISOString();
      store.error = null;
      writeState();
      return { ok: true, added };
    } catch (error) {
      store.error = explainImapError(error);
      store.lastSync = new Date().toISOString();
      writeState();
      return { ok: false, error: store.error };
    } finally {
      syncing = false;
      syncWait = null;
      try { await client.logout(); } catch { /* Verbindung ist schon zu. */ }
    }
  })();
  return syncWait;
}

function lanAddresses() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

function statusPayload() {
  return {
    configured,
    address: user,
    lastSync: store.lastSync,
    error: store.error,
  };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("..") || pathname.startsWith("/data") || pathname.startsWith("/node_modules")) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const file = path.join(root, pathname);
  if (!file.startsWith(root)) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const base = path.basename(file);
  if (base.startsWith(".env") || base === "server.js" || base === "package.json" || base === "package-lock.json") {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, content, types[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/status" && req.method === "GET") {
      send(res, 200, JSON.stringify(statusPayload()));
      return;
    }
    if (url.pathname === "/api/mails" && req.method === "GET") {
      const mails = [...store.mails].sort((a, b) => new Date(b.date) - new Date(a.date)).map(publicMail);
      send(res, 200, JSON.stringify({ mails }));
      return;
    }
    if (url.pathname === "/api/sync" && req.method === "POST") {
      const result = await syncMailbox();
      send(res, result.ok ? 200 : 400, JSON.stringify({ ...result, ...statusPayload() }));
      return;
    }
    const htmlMatch = url.pathname.match(/^\/api\/mails\/([a-f0-9]{20})\/html$/);
    if (htmlMatch && req.method === "GET") {
      const file = path.join(htmlDir, `${htmlMatch[1]}.html`);
      if (!fs.existsSync(file)) {
        send(res, 404, "Not found", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, fs.readFileSync(file), "text/html; charset=utf-8");
      return;
    }
    const decisionMatch = url.pathname.match(/^\/api\/mails\/([a-f0-9]{20})$/);
    if (decisionMatch && req.method === "DELETE") {
      const id = decisionMatch[1];
      const known = store.mails.some((entry) => entry.id === id) || store.removed.includes(id);
      if (!known) {
        send(res, 404, JSON.stringify({ error: "Mail not found." }));
        return;
      }
      await removeMail(id);
      send(res, 200, JSON.stringify({ ok: true }));
      return;
    }
    if (decisionMatch && req.method === "POST") {
      const mail = store.mails.find((entry) => entry.id === decisionMatch[1]);
      if (!mail) {
        send(res, 404, JSON.stringify({ error: "Mail not found." }));
        return;
      }
      const body = await readBody(req);
      if (["open", "approved", "changes"].includes(body.status) && body.status !== mail.status) {
        mail.status = body.status;
        mail.note = body.status === "changes" ? String(body.note || "").trim() : "";
        mail.decidedAt = body.status === "open" ? null : new Date().toISOString();
      } else if (body.status === "changes" && mail.status === "changes") {
        mail.note = String(body.note || "").trim();
      }
      if (["omnisend", "shopify", "unknown"].includes(body.channel)) mail.channel = body.channel;
      writeState();
      send(res, 200, JSON.stringify({ mail: publicMail(mail) }));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      send(res, 404, JSON.stringify({ error: "Not found." }));
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    send(res, 500, JSON.stringify({ error: "Internal error." }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`MVP Approval is running at http://127.0.0.1:${port}`);
  for (const link of lanAddresses()) console.log(`On this network: ${link}`);
  if (!configured) console.log("Inbox is not set up yet. Create a .env file.");
  else syncMailbox();
});

if (configured) setInterval(() => { syncMailbox(); }, 60000);
