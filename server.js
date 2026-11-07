require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const JWT_SECRET = process.env.JWT_SECRET || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const WEEKLY_TEST_TOKENS = Math.max(0, Number(process.env.WEEKLY_TEST_TOKENS || 1000));
// Użytkownik płaci 50% szacowanego zużycia tokenów modelu.
const CREDIT_CHARGE_RATE = 0.5;
const PURPLE_API_URL = (process.env.PURPLE_API_URL || "").replace(/\/$/, "");
const PURPLE_API_KEY = process.env.PURPLE_API_KEY || "";
const TOSTHOST_API_BASE = (process.env.TOSTHOST_API_BASE || "https://my.tosthost.pl/api/v1").replace(/\/$/, "");
const TOSTHOST_API_KEY = process.env.TOSTHOST_API_KEY || "";
const TOSTHOST_SANDBOX = String(process.env.TOSTHOST_SANDBOX || "false").toLowerCase() === "true";

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Ustaw JWT_SECRET o długości co najmniej 32 znaków w pliku .env");
  process.exit(1);
}
if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length < 32) {
  console.error("Ustaw WEBHOOK_SECRET o długości co najmniej 32 znaków w pliku .env");
  process.exit(1);
}

let packages = {};
try {
  packages = JSON.parse(process.env.PAYMENT_PACKAGES_JSON || "{}");
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) packages = {};
} catch {
  console.error("PAYMENT_PACKAGES_JSON musi być poprawnym obiektem JSON.");
  process.exit(1);
}

const dbPath = path.resolve(process.env.DATABASE_PATH || "./data/inter.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_hash TEXT,
  verify_expires INTEGER,
  credits INTEGER NOT NULL DEFAULT 0,
  next_weekly_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  package_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PLN',
  credits INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
`);

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    upgradeInsecureRequests: null
  }
}}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "INTER <onboarding@resend.dev>";

async function sendVerificationEmail(to, verifyUrl) {
  if (!RESEND_API_KEY) throw new Error("Brak RESEND_API_KEY.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: "Potwierdź adres e-mail — INTER",
      text: "Aby aktywować konto INTER, otwórz link: " + verifyUrl + "\nLink jest ważny przez 24 godziny."
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Resend API error:", response.status, data);
    throw new Error(data.message || data.error || "Resend nie wysłał wiadomości.");
  }
  return data;
}

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const makeToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const makeApiKey = () => "purple_" + makeToken(32);

function auth(req, res, next) {
  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!raw) return res.status(401).json({ error: "Zaloguj się." });
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    const user = db.prepare("SELECT id,email,verified,credits,next_weekly_at FROM users WHERE id=?").get(payload.sub);
    if (!user || !user.verified) return res.status(401).json({ error: "Konto nie istnieje lub nie jest zweryfikowane." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Sesja wygasła. Zaloguj się ponownie." });
  }
}

function apiKeyAuth(req, res, next) {
  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!raw.startsWith("purple_")) return res.status(401).json({ error: "Nieprawidłowy token Purple AI." });
  const record = db.prepare("SELECT user_id,key_hash FROM api_keys WHERE key_prefix=?").get(raw.slice(0, 15));
  if (!record || !safeEqual(record.key_hash, sha256(raw))) return res.status(401).json({ error: "Nieprawidłowy token Purple AI." });
  const user = db.prepare("SELECT id,email,verified,credits,next_weekly_at FROM users WHERE id=?").get(record.user_id);
  if (!user || !user.verified) return res.status(401).json({ error: "Konto nieaktywne." });
  req.user = user;
  next();
}

function refreshWeeklyAllowance(userId) {
  const user = db.prepare("SELECT credits,next_weekly_at FROM users WHERE id=?").get(userId);
  if (!user) return;
  const timestamp = now();
  if (timestamp >= user.next_weekly_at) {
    const weeks = Math.max(1, Math.floor((timestamp - user.next_weekly_at) / (7 * 86400)) + 1);
    const next = user.next_weekly_at + weeks * 7 * 86400;
    db.prepare("UPDATE users SET credits=credits+?, next_weekly_at=? WHERE id=?")
      .run(WEEKLY_TEST_TOKENS, next, userId);
  }
}

function getAccount(userId) {
  refreshWeeklyAllowance(userId);
  const user = db.prepare("SELECT id,email,credits,next_weekly_at,created_at FROM users WHERE id=?").get(userId);
  const key = db.prepare("SELECT key_prefix,created_at FROM api_keys WHERE user_id=?").get(userId) || null;
  const usage = db.prepare("SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM usage_log WHERE user_id=? AND created_at>=?")
    .get(userId, now() - 30 * 86400);
  return { ...user, next_weekly_at: user.next_weekly_at, api_key: key, usage_30d: usage };
}

function estimateInputTokens(messages) {
  const text = messages.map(m => String(m.content || "")).join(" ");
  return Math.max(1, Math.ceil(text.length / 4));
}

function consumeCredits(userId, inputTokens, outputTokens) {
  const total = Math.max(1, Math.ceil((inputTokens + outputTokens) * CREDIT_CHARGE_RATE));
  const tx = db.transaction(() => {
    refreshWeeklyAllowance(userId);
    const user = db.prepare("SELECT credits FROM users WHERE id=?").get(userId);
    if (!user || user.credits < total) return false;
    db.prepare("UPDATE users SET credits=credits-? WHERE id=?").run(total, userId);
    db.prepare("INSERT INTO usage_log(user_id,input_tokens,output_tokens,created_at) VALUES(?,?,?,?)")
      .run(userId, inputTokens, outputTokens, now());
    return true;
  });
  return tx();
}

function refundCredits(userId, amount) {
  db.prepare("UPDATE users SET credits=credits+? WHERE id=?").run(amount, userId);
}

async function callPurple(messages, options = {}) {
  if (!PURPLE_API_URL || !PURPLE_API_KEY) {
    const error = new Error("Serwer Purple AI nie jest jeszcze skonfigurowany.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(PURPLE_API_URL + "/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + PURPLE_API_KEY },
    body: JSON.stringify({
      messages,
      max_new_tokens: Math.min(512, Math.max(1, Number(options.max_new_tokens || 160))),
      temperature: 0.8,
      top_k: 40
    }),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.detail || data.error || "Purple AI chwilowo nie odpowiada.");
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return data;
}

async function handleChat(req, res) {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20 ||
      messages.some(m => !m || !["system", "user", "assistant"].includes(m.role) ||
        typeof m.content !== "string" || !m.content.trim() || m.content.length > 4000)) {
    return res.status(400).json({ error: "Podaj poprawną tablicę messages (1–20 wiadomości)." });
  }
  const inputTokens = estimateInputTokens(messages);
  const outputTokens = Math.min(512, Math.max(1, Number(req.body.max_new_tokens || 160)));
  const modelTokenEstimate = inputTokens + outputTokens;
  const cost = Math.max(1, Math.ceil(modelTokenEstimate * CREDIT_CHARGE_RATE));
  refreshWeeklyAllowance(req.user.id);
  const current = db.prepare("SELECT credits FROM users WHERE id=?").get(req.user.id);
  if (!current || current.credits < cost) {
    return res.status(402).json({ error: "Brak tokenów. Poczekaj na tygodniowy pakiet testowy lub kup dodatkowe tokeny.", code: "INSUFFICIENT_CREDITS" });
  }
  // Reserve the maximum estimated cost before calling the model; refund unused estimate on failure.
  const reserved = db.prepare("UPDATE users SET credits=credits-? WHERE id=? AND credits>=?").run(cost, req.user.id, cost);
  if (!reserved.changes) return res.status(402).json({ error: "Brak tokenów.", code: "INSUFFICIENT_CREDITS" });
  try {
    const data = await callPurple(messages, { max_new_tokens: outputTokens });
    const answer = String(data.answer ?? data.choices?.[0]?.message?.content ?? "");
    const actualOutput = Math.min(outputTokens, Math.max(1, Number(data.usage?.generated_tokens || Math.ceil(answer.length / 4))));
    const actualModelTokens = inputTokens + actualOutput;
    const actualCost = Math.max(1, Math.ceil(actualModelTokens * CREDIT_CHARGE_RATE));
    if (cost > actualCost) refundCredits(req.user.id, cost - actualCost);
    db.prepare("INSERT INTO usage_log(user_id,input_tokens,output_tokens,created_at) VALUES(?,?,?,?)")
      .run(req.user.id, inputTokens, actualOutput, now());
    return res.json({ ...data, answer, usage: { ...(data.usage || {}), input_tokens: inputTokens, output_tokens: actualOutput, total_tokens: actualModelTokens, credits_charged: actualCost, remaining_credits: getAccount(req.user.id).credits } });
  } catch (error) {
    refundCredits(req.user.id, cost);
    return res.status(error.status || 502).json({ error: error.message || "Błąd połączenia z Purple AI." });
  }
}

app.post("/api/auth/register", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  if (password.length < 10 || password.length > 128)
    return res.status(400).json({ error: "Hasło musi mieć od 10 do 128 znaków." });
  if (!RESEND_API_KEY) return res.status(503).json({ error: "Administrator musi dodać RESEND_API_KEY, aby włączyć rejestrację." });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email))
    return res.status(409).json({ error: "Konto z tym adresem e-mail już istnieje." });

  const timestamp = now();
  const verifyToken = makeToken(32);
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const info = db.prepare("INSERT INTO users(email,password_hash,verified,verify_hash,verify_expires,credits,next_weekly_at,created_at) VALUES(?,?,0,?,?,?, ?,?)")
      .run(email, passwordHash, sha256(verifyToken), timestamp + 86400, WEEKLY_TEST_TOKENS, timestamp + 7 * 86400, timestamp);
    const baseUrl = PUBLIC_URL || (req.protocol + "://" + req.get("host"));
    const verifyUrl = baseUrl + "/api/auth/verify?token=" + encodeURIComponent(verifyToken);
    await sendVerificationEmail(email, verifyUrl);
    return res.status(201).json({ message: "Wysłaliśmy link aktywacyjny na Twój e-mail." });
  } catch (error) {
    console.error("Registration/email error:", error.message);
    return res.status(500).json({ error: "Nie udało się utworzyć konta lub wysłać wiadomości." });
  }
});

app.get("/api/auth/verify", (req, res) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).send("Brak tokenu weryfikacyjnego.");
  const row = db.prepare("SELECT id,user_id,expires_at FROM email_verifications WHERE token_hash=?").get(sha256(token));
  // Compatibility with the verification hash stored directly on the user.
  const user = db.prepare("SELECT id,email,verify_hash,verify_expires FROM users WHERE verify_hash=?").get(sha256(token));
  if (!user || user.verify_expires < now()) return res.status(400).send("Link jest nieprawidłowy lub wygasł.");
  db.prepare("UPDATE users SET verified=1,verify_hash=NULL,verify_expires=NULL WHERE id=?").run(user.id);
  return res.redirect("/?verified=1");
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Nieprawidłowy e-mail lub hasło." });
  if (!user.verified) return res.status(403).json({ error: "Najpierw potwierdź adres e-mail." });
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({ token, account: getAccount(user.id) });
});

app.get("/api/account", auth, (req, res) => res.json(getAccount(req.user.id)));

app.post("/api/account/api-key", auth, (req, res) => {
  const existing = db.prepare("SELECT id FROM api_keys WHERE user_id=?").get(req.user.id);
  if (existing && req.body.regenerate !== true)
    return res.status(409).json({ error: "Masz już jeden token API. Użyj regeneracji, aby unieważnić stary i utworzyć nowy." });
  const key = makeApiKey();
  const prefix = key.slice(0, 15);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM api_keys WHERE user_id=?").run(req.user.id);
    db.prepare("INSERT INTO api_keys(user_id,key_hash,key_prefix,created_at) VALUES(?,?,?,?)")
      .run(req.user.id, sha256(key), prefix, now());
  });
  tx();
  return res.status(201).json({ api_key: key, warning: "Skopiuj token teraz. Nie będzie można wyświetlić go ponownie." });
});

app.delete("/api/account/api-key", auth, (req, res) => {
  db.prepare("DELETE FROM api_keys WHERE user_id=?").run(req.user.id);
  res.json({ message: "Token API został unieważniony." });
});

app.post("/api/chat", auth, handleChat);
app.post("/v1/chat", apiKeyAuth, handleChat);

app.get("/api/payments/packages", (_req, res) => {
  const safe = Object.entries(packages).map(([id, p]) => ({
    id, label: String(p.label || id), amount: Number(p.amount), currency: "PLN", credits: Number(p.credits)
  })).filter(p => Number.isFinite(p.amount) && p.amount > 0 && Number.isInteger(p.credits) && p.credits > 0);
  res.json({ packages: safe });
});

app.post("/api/payments/create", auth, async (req, res) => {
  if (!TOSTHOST_API_KEY) return res.status(503).json({ error: "Płatności TostHost nie są jeszcze skonfigurowane." });
  if (!PUBLIC_URL) return res.status(503).json({ error: "Ustaw PUBLIC_URL w konfiguracji serwera." });
  const pack = packages[String(req.body.package_id || "")];
  if (!pack || !Number.isFinite(Number(pack.amount)) || Number(pack.amount) <= 0 ||
      !Number.isInteger(Number(pack.credits)) || Number(pack.credits) <= 0)
    return res.status(400).json({ error: "Nieprawidłowy pakiet." });

  const reference = "purple_" + makeToken(18);
  const amount = Number(Number(pack.amount).toFixed(2));
  db.prepare("INSERT INTO purchases(user_id,reference,package_id,amount,credits,status,created_at) VALUES(?,?,?,?,?,'CREATED',?)")
    .run(req.user.id, reference, String(req.body.package_id), amount, Number(pack.credits), now());

  try {
    const response = await fetch(TOSTHOST_API_BASE + "/transactions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOSTHOST_API_KEY },
      body: JSON.stringify({
        amount, currency: "PLN",
        successUrl: PUBLIC_URL + "/?payment=success",
        cancelUrl: PUBLIC_URL + "/?payment=cancelled",
        notifyUrl: PUBLIC_URL + "/api/payments/webhook?secret=" + encodeURIComponent(WEBHOOK_SECRET),
        customerEmail: req.user.email,
        customReference: reference,
        isSandbox: TOSTHOST_SANDBOX
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.transactionId || !data.paymentLink)
      throw new Error(data.message || data.error || "TostHost nie zwrócił transactionId i paymentLink.");
    db.prepare("UPDATE purchases SET provider_transaction_id=? WHERE reference=?")
      .run(String(data.transactionId), reference);
    return res.json({ payment_url: String(data.paymentLink), reference });
  } catch (error) {
    db.prepare("UPDATE purchases SET status='ERROR' WHERE reference=?").run(reference);
    console.error("TostHost create payment:", error.message);
    return res.status(502).json({ error: "Nie udało się utworzyć płatności. Spróbuj później." });
  }
});

app.post("/api/payments/webhook", async (req, res) => {
  const suppliedSecret = String(req.query.secret || "");
  if (!safeEqual(suppliedSecret, WEBHOOK_SECRET)) return res.sendStatus(401);
  const transactionId = String(req.body?.transactionId || "");
  const reference = String(req.body?.customReference || "");
  if (!transactionId || !reference) return res.sendStatus(400);
  const purchase = db.prepare("SELECT * FROM purchases WHERE reference=? AND provider_transaction_id=?")
    .get(reference, transactionId);
  if (!purchase) return res.sendStatus(404);

  try {
    // Do not trust the webhook status alone: verify the transaction with TostHost.
    const response = await fetch(TOSTHOST_API_BASE + "/transactions/status/" + encodeURIComponent(transactionId), {
      headers: { "Authorization": "Bearer " + TOSTHOST_API_KEY, "Accept": "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const statusData = await response.json().catch(() => ({}));
    if (!response.ok) return res.sendStatus(502);
    const verifiedTransaction = statusData.data || statusData.transaction || statusData;
    const verifiedStatus = String(verifiedTransaction.status || "").toUpperCase();
    if (verifiedStatus !== "PAID") {
      db.prepare("UPDATE purchases SET status=? WHERE id=?").run(verifiedStatus || "UNKNOWN", purchase.id);
      return res.sendStatus(200);
    }
    if (verifiedTransaction.customReference && verifiedTransaction.customReference !== reference) return res.sendStatus(400);
    if (verifiedTransaction.isSandbox === true && !TOSTHOST_SANDBOX) return res.sendStatus(400);
    if (verifiedTransaction.amount !== undefined && Number(verifiedTransaction.amount) !== Number(purchase.amount)) return res.sendStatus(400);
    if (verifiedTransaction.currency && String(verifiedTransaction.currency).toUpperCase() !== "PLN") return res.sendStatus(400);

    const tx = db.transaction(() => {
      const current = db.prepare("SELECT status FROM purchases WHERE id=?").get(purchase.id);
      if (current.status === "PAID") return;
      db.prepare("UPDATE purchases SET status='PAID',paid_at=? WHERE id=?").run(now(), purchase.id);
      db.prepare("UPDATE users SET credits=credits+? WHERE id=?").run(purchase.credits, purchase.user_id);
    });
    tx();
    return res.sendStatus(200);
  } catch (error) {
    console.error("TostHost webhook verification:", error.message);
    return res.sendStatus(502);
  }
});

app.get("/api/account/purchases", auth, (req, res) => {
  const rows = db.prepare("SELECT package_id,amount,currency,credits,status,created_at,paid_at FROM purchases WHERE user_id=? ORDER BY id DESC LIMIT 30")
    .all(req.user.id);
  res.json({ purchases: rows });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("Purple AI Inter działa na porcie " + PORT);
});
