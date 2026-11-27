// Wheel lead landing: serves the page, receives WhatsApp leads, forwards them.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const env = process.env;
const PORT = env.PORT || 3000;
const PHONE_RE = new RegExp(env.PHONE_REGEX || "^\\+34[67]\\d{8}$");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "20kb" }));

/* ---------- storage: Postgres if DATABASE_URL, else a local JSONL file ---------- */
let pool = null;
const FILE = path.join(__dirname, "data", "leads.jsonl");

async function initStorage() {
  if (env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_URL.includes("railway.internal") ? false : { rejectUnauthorized: false },
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now(),
      phone TEXT UNIQUE NOT NULL,
      prize TEXT, brand TEXT, subid TEXT, fbclid TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
      ip TEXT, user_agent TEXT, event_id TEXT,
      leaddeus_status TEXT, keitaro_status TEXT, capi_status TEXT
    )`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS sheet_status TEXT`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_id TEXT`);
    console.log("Storage: Postgres");
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    console.warn("Storage: local file (data/leads.jsonl). Add a Postgres database on Railway, the file is lost on redeploy.");
  }
}

async function saveLead(l) {
  if (pool) {
    const r = await pool.query(
      `INSERT INTO leads (phone, prize, brand, subid, fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, ip, user_agent, event_id, lead_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (phone) DO NOTHING RETURNING id`,
      [l.phone, l.prize, l.brand, l.subid, l.fbclid, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.ip, l.user_agent, l.event_id, l.lead_id]
    );
    return { isNew: r.rowCount > 0, id: r.rows[0] && r.rows[0].id };
  }
  const exists = fs.existsSync(FILE) && fs.readFileSync(FILE, "utf8").includes(`"phone":"${l.phone}"`);
  if (!exists) fs.appendFileSync(FILE, JSON.stringify({ created_at: new Date().toISOString(), ...l }) + "\n");
  return { isNew: !exists };
}

async function setStatus(id, field, value) {
  if (pool && id) await pool.query(`UPDATE leads SET ${field} = $1 WHERE id = $2`, [String(value).slice(0, 200), id]).catch(() => {});
}

/* ---------- outbound calls ---------- */
async function post(url, body, headers = {}, tries = 2) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      if (r.ok) return `ok ${r.status}`;
      const t = await r.text();
      if (i === tries) return `error ${r.status}: ${t.slice(0, 120)}`;
    } catch (e) {
      if (i === tries) return `error: ${e.message}`;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

// LeadDeus: generic JSON POST. Adjust the body here to match the exact field names LeadDeus expects.
async function sendToLeadDeus(l) {
  if (!env.LEADDEUS_WEBHOOK_URL) return "skipped";
  const headers = env.LEADDEUS_API_KEY ? { Authorization: `Bearer ${env.LEADDEUS_API_KEY}` } : {};
  return post(env.LEADDEUS_WEBHOOK_URL, {
    phone: l.phone,
    source: l.brand,
    prize: l.prize,
    subid: l.subid,
    utm_source: l.utm_source,
    utm_campaign: l.utm_campaign,
    created_at: new Date().toISOString(),
  }, headers);
}

// Google Sheets ("Quiz leads Oct 2026") through the Apps Script web app.
// Keys match the sheet's column headers, so the row lines up with the other landings.
function sheetTimestamp(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: env.SHEET_TIMEZONE || "Europe/Vilnius",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

async function sendToSheet(l) {
  if (!env.SHEETS_WEBHOOK_URL) return "skipped";
  const row = {
    timestamp: sheetTimestamp(),
    lead_id: l.lead_id,
    quiz_id: env.SHEET_QUIZ_ID || "es_wheel_wa_channel",
    geo: env.SHEET_GEO || "ES",
    club: "", email: "",
    phone: l.phone,
    whatsapp_consent: true,
    favourite_team: "", bet_frequency: "",
    answers_json: JSON.stringify({ wheel_gift: l.prize }),
    consent: true,
    consent_text_version: env.SHEET_CONSENT_VERSION || "es-wheel-wa-v1",
    utm_source: l.utm_source, utm_medium: l.utm_medium, utm_campaign: l.utm_campaign,
    utm_content: l.utm_content, utm_term: l.utm_term,
    fbclid: l.fbclid,
    brand: l.brand,
    landing_url: l.landing_url || l.page,
    referrer: l.referrer,
  };
  const form = env.SHEETS_FORMAT === "form";
  for (let i = 1; i <= 2; i++) {
    try {
      // Apps Script answers a POST with a 302; fetch follows it to read the script's reply.
      const r = await fetch(env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "text/plain;charset=utf-8" },
        body: form ? new URLSearchParams(Object.entries(row).map(([k, v]) => [k, String(v ?? "")])).toString() : JSON.stringify(row),
        redirect: "follow",
      });
      const t = (await r.text()).replace(/\s+/g, " ").slice(0, 120);
      if (r.ok && !/error|exception/i.test(t)) return `ok ${r.status} ${t}`.trim();
      if (i === 2) return `error ${r.status}: ${t}`;
    } catch (e) {
      if (i === 2) return `error: ${e.message}`;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function sendKeitaro(l) {
  if (!env.KEITARO_POSTBACK_URL || !l.subid) return "skipped";
  try {
    const url = env.KEITARO_POSTBACK_URL.replace("{subid}", encodeURIComponent(l.subid));
    const r = await fetch(url);
    return `${r.ok ? "ok" : "error"} ${r.status}`;
  } catch (e) { return `error: ${e.message}`; }
}

// Meta Conversions API, deduplicated with the browser pixel through event_id.
async function sendCapi(l) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) return "skipped";
  const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
  const body = {
    data: [{
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: l.event_id,
      action_source: "website",
      event_source_url: l.page,
      user_data: {
        ph: [sha(l.phone.replace(/\D/g, ""))],
        client_ip_address: l.ip,
        client_user_agent: l.user_agent,
        ...(l.fbc ? { fbc: l.fbc } : {}),
        ...(l.fbp ? { fbp: l.fbp } : {}),
      },
      custom_data: { content_name: l.prize },
    }],
    ...(env.META_TEST_EVENT_CODE ? { test_event_code: env.META_TEST_EVENT_CODE } : {}),
  };
  return post(`https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`, body, {}, 1);
}

/* ---------- simple rate limit: 30 submits per IP per 10 min (mobile carriers share IPs) ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > 30;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

/* ---------- routes ---------- */
app.get("/config.js", (req, res) => {
  const cfg = {};
  if (env.BRAND_NAME) cfg.brand = env.BRAND_NAME;
  if (env.CHANNEL_URL || env.TELEGRAM_CHANNEL_URL) cfg.channelUrl = env.CHANNEL_URL || env.TELEGRAM_CHANNEL_URL;
  if (env.META_PIXEL_ID) cfg.pixelId = env.META_PIXEL_ID;
  if (env.GURU_NAME) cfg.guruName = env.GURU_NAME;
  if (env.WHEEL_SEGMENTS) cfg.segments = env.WHEEL_SEGMENTS.split("|").map((s) => s.trim()).filter(Boolean);
  if (env.WHEEL_WIN_INDEX) cfg.winIndex = parseInt(env.WHEEL_WIN_INDEX, 10);
  res.type("application/javascript").set("Cache-Control", "no-store")
    .send(`Object.assign(window.LP, ${JSON.stringify(cfg)});`);
});

app.post("/api/lead", async (req, res) => {
  const b = req.body || {};
  const ip = req.ip;
  if (limited(ip)) return res.status(429).json({ ok: false, error: "too_many_requests" });

  const phone = String(b.phone || "").replace(/[^\d+]/g, "");
  if (!PHONE_RE.test(phone)) return res.status(400).json({ ok: false, error: "invalid_phone" });
  if (b.consent !== true) return res.status(400).json({ ok: false, error: "no_consent" });

  const s = (v) => (v == null ? "" : String(v).slice(0, 300));
  const lead = {
    phone,
    prize: s(b.prize), brand: s(b.brand), event_id: s(b.event_id),
    subid: s(b.subid), fbclid: s(b.fbclid), fbc: s(b.fbc), fbp: s(b.fbp),
    utm_source: s(b.utm_source), utm_medium: s(b.utm_medium), utm_campaign: s(b.utm_campaign),
    utm_content: s(b.utm_content), utm_term: s(b.utm_term),
    page: s(b.page), landing_url: s(b.landing_url), referrer: s(b.referrer),
    lead_id: crypto.randomUUID(),
    ip, user_agent: s(req.get("user-agent")),
  };

  let saved;
  try { saved = await saveLead(lead); }
  catch (e) { console.error("Save failed", e); return res.status(500).json({ ok: false, error: "save_failed" }); }

  // Answer the visitor right away; forwarding happens in the background.
  res.json({ ok: true, duplicate: !saved.isNew });
  if (!saved.isNew) return;

  const [sh, ld, kt, capi] = await Promise.all([sendToSheet(lead), sendToLeadDeus(lead), sendKeitaro(lead), sendCapi(lead)]);
  console.log(`Lead ${phone.slice(0, 6)}*** | Sheet: ${sh} | LeadDeus: ${ld} | Keitaro: ${kt} | CAPI: ${capi}`);
  await setStatus(saved.id, "sheet_status", sh);
  await setStatus(saved.id, "leaddeus_status", ld);
  await setStatus(saved.id, "keitaro_status", kt);
  await setStatus(saved.id, "capi_status", capi);
});

// CSV export: /admin/leads.csv?token=ADMIN_TOKEN
app.get("/admin/leads.csv", async (req, res) => {
  if (!env.ADMIN_TOKEN || req.query.token !== env.ADMIN_TOKEN) return res.status(401).send("Unauthorized");
  let rows = [];
  if (pool) rows = (await pool.query("SELECT * FROM leads ORDER BY id DESC")).rows;
  else if (fs.existsSync(FILE)) rows = fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse();
  const cols = ["created_at", "phone", "prize", "subid", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "sheet_status", "leaddeus_status", "keitaro_status", "capi_status"];
  const esc = (v) => `"${String(v == null ? "" : v instanceof Date ? v.toISOString() : v).replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  res.type("text/csv").set("Content-Disposition", "attachment; filename=leads.csv").send(csv);
});

app.get("/health", (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

initStorage()
  .then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch((e) => { console.error("Startup failed", e); process.exit(1); });
