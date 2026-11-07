const $ = (id) => document.getElementById(id);
let sessionToken = localStorage.getItem("purple_session") || "";
let currentAccount = null;

async function request(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (sessionToken) headers.Authorization = "Bearer " + sessionToken;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail || "Wystąpił błąd.");
  return data;
}
function showMessage(id, text, error = false) {
  const el = $(id); el.textContent = text; el.style.color = error ? "#ff9aa9" : "#c9b2ff";
}
function setTab(tab) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("loginForm").classList.toggle("hidden", tab !== "login");
  $("registerForm").classList.toggle("hidden", tab !== "register");
  showMessage("authMessage", "");
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const data = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    sessionToken = data.token; localStorage.setItem("purple_session", sessionToken);
    await loadDashboard();
  } catch (error) { showMessage("authMessage", error.message, true); }
});
$("registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const data = await request("/api/auth/register", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    showMessage("authMessage", data.message);
  } catch (error) { showMessage("authMessage", error.message, true); }
});

function renderAccount(account) {
  currentAccount = account;
  $("userEmail").textContent = account.email;
  $("creditCount").textContent = Number(account.credits).toLocaleString("pl-PL");
  $("statCredits").textContent = Number(account.credits).toLocaleString("pl-PL");
  $("statKey").textContent = account.api_key ? "Aktywny" : "Brak";
  $("keyPrefix").textContent = account.api_key ? account.api_key.key_prefix + "••••••••••" : "Nie utworzono tokenu";
  $("createKeyBtn").classList.toggle("hidden", Boolean(account.api_key));
  $("statRenewal").textContent = new Date(account.next_weekly_at * 1000).toLocaleDateString("pl-PL");
}
async function loadDashboard() {
  try {
    const account = await request("/api/account");
    renderAccount(account);
    $("authPanel").classList.add("hidden"); $("hero").classList.add("hidden");
    $("dashboard").classList.remove("hidden"); $("logoutBtn").classList.remove("hidden");
    await loadPackages();
  } catch (error) {
    sessionToken = ""; localStorage.removeItem("purple_session");
    $("authPanel").classList.remove("hidden"); $("hero").classList.remove("hidden");
    $("dashboard").classList.add("hidden"); $("logoutBtn").classList.add("hidden");
  }
}
async function createKey(regenerate = false) {
  if (regenerate && !confirm("Stary token natychmiast przestanie działać. Kontynuować?")) return;
  try {
    const data = await request("/api/account/api-key", { method: "POST", body: JSON.stringify({ regenerate }) });
    const area = $("keyArea"); area.innerHTML = "";
    const code = document.createElement("code"); code.textContent = data.api_key;
    const copy = document.createElement("button"); copy.className = "secondary-btn"; copy.textContent = "Kopiuj";
    copy.addEventListener("click", async () => { await navigator.clipboard.writeText(data.api_key); copy.textContent = "Skopiowano"; });
    area.append(code, copy);
    showMessage("dashMessage", data.warning);
    await loadDashboard();
    // Keep the one-time key visible after refreshing account data.
    area.replaceChildren(code, copy);
  } catch (error) { showMessage("dashMessage", error.message, true); }
}
$("createKeyBtn").addEventListener("click", () => createKey(false));
$("regenKeyBtn").addEventListener("click", () => createKey(true));
$("revokeKeyBtn").addEventListener("click", async () => {
  if (!confirm("Na pewno unieważnić token API?")) return;
  try { await request("/api/account/api-key", { method: "DELETE" }); showMessage("dashMessage", "Token unieważniony."); await loadDashboard(); }
  catch (error) { showMessage("dashMessage", error.message, true); }
});
async function loadPackages() {
  try {
    const { packages } = await request("/api/payments/packages");
    const target = $("packages"); target.replaceChildren();
    if (!packages.length) { target.innerHTML = '<p class="small-muted">Pakiety zostaną pokazane po ustawieniu cen w konfiguracji serwera.</p>'; return; }
    packages.forEach(pack => {
      const row = document.createElement("div"); row.className = "package";
      const info = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = pack.label;
      const details = document.createElement("small"); details.textContent = pack.credits.toLocaleString("pl-PL") + " tokenów";
      info.append(name, details);
      const button = document.createElement("button"); button.className = "primary-btn compact"; button.textContent = pack.amount.toFixed(2) + " zł";
      button.addEventListener("click", async () => {
        try { const result = await request("/api/payments/create", { method: "POST", body: JSON.stringify({ package_id: pack.id }) }); location.href = result.payment_url; }
        catch (error) { showMessage("dashMessage", error.message, true); }
      });
      row.append(info, button); target.append(row);
    });
  } catch (error) { showMessage("dashMessage", error.message, true); }
}
function addBubble(role, text) {
  const bubble = document.createElement("div"); bubble.className = "bubble " + role; bubble.textContent = text;
  $("chatMessages").append(bubble); $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}
$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("chatInput"); const text = input.value.trim(); if (!text) return;
  addBubble("user", text); input.value = "";
  const pending = document.createElement("div"); pending.className = "bubble assistant"; pending.textContent = "Purple AI odpowiada…"; $("chatMessages").append(pending);
  try {
    const data = await request("/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: text }], max_new_tokens: 160 }) });
    pending.textContent = data.answer || "Model zwrócił pustą odpowiedź.";
    if (data.usage?.remaining_credits !== undefined) {
      $("creditCount").textContent = Number(data.usage.remaining_credits).toLocaleString("pl-PL");
      $("statCredits").textContent = Number(data.usage.remaining_credits).toLocaleString("pl-PL");
    }
  } catch (error) { pending.textContent = error.message; pending.style.borderColor = "#a64c62"; }
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
});
$("logoutBtn").addEventListener("click", () => { localStorage.removeItem("purple_session"); sessionToken = ""; location.reload(); });

if (new URLSearchParams(location.search).get("verified") === "1") showMessage("authMessage", "E-mail potwierdzony. Możesz się zalogować.");
if (new URLSearchParams(location.search).get("payment") === "success") showMessage("authMessage", "Płatność została przekazana do weryfikacji. Saldo zaktualizuje się po potwierdzeniu TostHost.");
if (new URLSearchParams(location.search).get("payment") === "cancelled") showMessage("authMessage", "Płatność została anulowana.");
if (sessionToken) loadDashboard();
