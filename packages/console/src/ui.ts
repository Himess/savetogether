/**
 * The console page. One file, no build step, no framework.
 *
 * The conversation is the interface. This page exists only for the moments that
 * must not happen in chat: unlocking the vault, confirming a reveal, and typing
 * an amount the user does not want in the transcript.
 *
 * The signature counter is the most important element on the page. It is the
 * product's central claim rendered as a number, and it is the thing a viewer
 * checks first.
 */
export function consoleHtml(token: string): string {
  return `<!doctype html>
<html lang="en" data-token="${token}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GhostKey</title>
<style>
  :root {
    --bg: #0b0c0e; --panel: #131519; --line: #23262d; --text: #e8eaed;
    --dim: #8b919c; --accent: #7dd3a0; --warn: #f0b849; --danger: #f0736a;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f7f8fa; --panel:#fff; --line:#e3e6ea; --text:#14161a; --dim:#5f6672; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; justify-content: center; padding: 40px 20px;
  }
  main { width: 100%; max-width: 640px; }
  h1 { font-size: 17px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 13px; margin: 0 0 28px; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 18px 20px; margin-bottom: 14px;
  }
  .counter { text-align: center; padding: 26px 20px; }
  .counter .n {
    font: 600 56px/1 var(--mono); color: var(--accent); display: block; margin-bottom: 6px;
  }
  .counter .label { color: var(--dim); font-size: 13px; letter-spacing: 0.02em; }
  .counter .note { color: var(--dim); font-size: 12px; margin-top: 10px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; font-size: 13px; }
  .row + .row { border-top: 1px solid var(--line); }
  .row .k { color: var(--dim); }
  .row .v { font-family: var(--mono); text-align: right; word-break: break-all; }
  .pending { border-color: var(--warn); }
  .pending h2 { font-size: 14px; margin: 0 0 6px; color: var(--warn); }
  .pending p { margin: 0 0 14px; font-size: 13px; color: var(--dim); }
  .detail { font-family: var(--mono); font-size: 12px; background: var(--bg);
            border: 1px solid var(--line); border-radius: 6px; padding: 10px; margin-bottom: 14px; }
  button {
    font: 500 13px/1 inherit; padding: 9px 16px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--panel); color: var(--text);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #08130d; }
  button.danger { background: transparent; border-color: var(--danger); color: var(--danger); }
  button:disabled { opacity: .45; cursor: default; }
  input {
    width: 100%; font: 14px var(--mono); padding: 10px 12px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--text); margin-bottom: 12px;
  }
  .actions { display: flex; gap: 8px; }
  .idle { color: var(--dim); font-size: 13px; text-align: center; padding: 8px 0; }
  footer { color: var(--dim); font-size: 12px; margin-top: 24px; line-height: 1.6; }
  code { font-family: var(--mono); font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>GhostKey</h1>
  <p class="sub">Local console &middot; 127.0.0.1 only</p>

  <div class="card counter">
    <span class="n" id="sigCount">0</span>
    <span class="label">Signatures this session</span>
    <div class="note" id="sigNote">no session open</div>
  </div>

  <div class="card" id="statusCard">
    <div class="row"><span class="k">vault</span><span class="v" id="vault">—</span></div>
    <div class="row"><span class="k">session key</span><span class="v" id="skey">—</span></div>
    <div class="row"><span class="k">expires</span><span class="v" id="expiry">—</span></div>
    <div class="row"><span class="k">transfers</span><span class="v" id="txcount">—</span></div>
    <div class="row"><span class="k">allowlist</span><span class="v" id="allow">—</span></div>
    <div class="row"><span class="k">balance visible to session</span><span class="v" id="tier">—</span></div>
  </div>

  <div id="pending"></div>

  <div class="card">
    <div class="actions">
      <button class="danger" id="revoke">Revoke everything</button>
    </div>
  </div>

  <footer>
    The conversation is the interface. This page exists for the three things that must not
    happen in chat: unlocking the vault, confirming that a number may be revealed, and typing
    an amount you do not want in the transcript.
  </footer>
</main>
<script>
const TOKEN = document.documentElement.dataset.token;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ghostkey-token": TOKEN },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

function renderStatus(s) {
  $("sigCount").textContent = s.signatures ?? 0;
  $("sigNote").textContent = s.session
    ? "one vault unlock authorised this whole session"
    : "no session open";
  $("vault").textContent = s.vault ?? "—";
  $("skey").textContent = s.sessionKey ?? "—";
  $("expiry").textContent = s.expiry ? new Date(s.expiry * 1000).toLocaleString() : "—";
  $("txcount").textContent = s.session
    ? (s.maxTxCount ? s.txCount + " / " + s.maxTxCount : s.txCount + " / unlimited")
    : "—";
  $("allow").textContent = (s.recipients && s.recipients.length)
    ? s.recipients.map((a) => a.slice(0, 8) + "…").join(", ") : "—";
  $("tier").textContent = s.session ? (s.tier === "balance-visible" ? "yes" : "no") : "—";
}

function renderPending(list) {
  const host = $("pending");
  if (!list.length) { host.innerHTML = '<div class="card idle">Nothing waiting on you.</div>'; return; }
  host.innerHTML = list.map((p) => {
    if (p.kind === "unlock") return card(p,
      "Unlock the vault",
      "The vault key signs the session open, then locks again. Nothing after this needs you.",
      "", '<button class="primary" data-id="' + p.id + '" data-act="approve">Unlock</button>' +
          '<button data-id="' + p.id + '" data-act="deny">Cancel</button>');
    if (p.kind === "reveal") return card(p,
      "Reveal an amount to the model?",
      "The model has not seen this number. Approving puts it in the conversation.",
      esc(p.detail || ""),
      '<button class="primary" data-id="' + p.id + '" data-act="approve">Reveal</button>' +
      '<button data-id="' + p.id + '" data-act="deny">Keep it hidden</button>');
    if (p.kind === "sealed") return card(p,
      "Enter the amount",
      "Typed here, encrypted here. The model receives only whether it went through.",
      esc(p.detail || ""),
      '<input id="amt-' + p.id + '" placeholder="0.00" autocomplete="off" inputmode="decimal">' +
      '<div class="actions"><button class="primary" data-id="' + p.id + '" data-act="sealed">Send</button>' +
      '<button data-id="' + p.id + '" data-act="deny">Cancel</button></div>');
    return "";
  }).join("");
}

function card(p, title, note, detail, actions) {
  return '<div class="card pending"><h2>' + esc(title) + '</h2><p>' + esc(note) + '</p>' +
    (detail ? '<div class="detail">' + detail + '</div>' : '') +
    (actions.includes('class="actions"') ? actions : '<div class="actions">' + actions + '</div>') +
    '</div>';
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id, act = btn.dataset.act;
  btn.disabled = true;
  if (act === "sealed") {
    const input = $("amt-" + id);
    await post("/api/resolve", { id, approved: true, value: input ? input.value : "" });
  } else {
    await post("/api/resolve", { id, approved: act === "approve" });
  }
  refresh();
});

$("revoke").addEventListener("click", async () => {
  if (!confirm("Close the session and revoke everything it can do?")) return;
  await post("/api/revoke");
  refresh();
});

async function refresh() {
  try {
    const s = await (await fetch("/api/state", { headers: { "x-ghostkey-token": TOKEN } })).json();
    renderStatus(s.status);
    renderPending(s.pending);
  } catch { /* the server is gone; the page will recover on the next tick */ }
}

const es = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN));
es.onmessage = refresh;
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
