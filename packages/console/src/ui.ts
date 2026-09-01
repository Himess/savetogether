/**
 * The console page. One file, no build step, no framework.
 *
 * The conversation is the interface. This page exists for the things that must
 * not happen in chat — unlocking the vault, confirming a reveal, typing an amount
 * that must stay out of the transcript — and for the setup a chat window is a bad
 * place to do: funding the vault and minting test tokens.
 *
 * The unlock counter is the most important element on it. It is the product's
 * central claim rendered as a number, and the thing a viewer checks first, so it
 * counts what the claim is actually about. With both keys on this machine the
 * vault SIGNS three transactions per session; what happens once is the unlock.
 * A counter reading "signatures: 1" would be false.
 */
export function consoleHtml(token: string): string {
  return `<!doctype html>
<html lang="en" data-token="${token}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SaveTogether</title>
<style>
  :root {
    --bg:#0b0c0e; --panel:#131519; --line:#23262d; --text:#e8eaed; --dim:#8b919c;
    --accent:#7dd3a0; --warn:#f0b849; --danger:#f0736a;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#e2e5ea; --text:#14161a; --dim:#5f6672; }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
    display:flex; justify-content:center; padding:40px 20px 64px;
  }
  main { width:100%; max-width:660px; }
  h1 { font-size:17px; margin:0 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--dim); font-size:13px; margin:0 0 28px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
          padding:18px 20px; margin-bottom:14px; }
  .card h2 { font-size:13px; margin:0 0 12px; color:var(--dim); font-weight:600;
             letter-spacing:.03em; text-transform:uppercase; }
  .counter { text-align:center; padding:26px 20px; }
  .counter .n { font:600 56px/1 var(--mono); color:var(--accent); display:block; margin-bottom:6px; }
  .counter .label { color:var(--dim); font-size:13px; letter-spacing:.02em; }
  .counter .note { color:var(--dim); font-size:12px; margin-top:10px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:7px 0; font-size:13px; }
  .row + .row { border-top:1px solid var(--line); }
  .row .k { color:var(--dim); flex:0 0 auto; }
  .row .v { font-family:var(--mono); text-align:right; word-break:break-all; }
  .pending { border-color:var(--warn); }
  .pending h2 { color:var(--warn); text-transform:none; letter-spacing:0; font-size:14px; }
  .pending p { margin:0 0 14px; font-size:13px; color:var(--dim); }
  .detail { font-family:var(--mono); font-size:12px; background:var(--bg);
            border:1px solid var(--line); border-radius:6px; padding:10px; margin-bottom:14px; }
  button { font:500 13px/1 inherit; padding:9px 16px; border-radius:7px; cursor:pointer;
           border:1px solid var(--line); background:var(--panel); color:var(--text); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#08130d; }
  button.danger { background:transparent; border-color:var(--danger); color:var(--danger); }
  button:disabled { opacity:.45; cursor:default; }
  input { width:100%; font:14px var(--mono); padding:10px 12px; border-radius:7px;
          border:1px solid var(--line); background:var(--bg); color:var(--text); margin-bottom:12px; }
  .inline { display:flex; gap:8px; align-items:center; }
  .inline input { margin:0; }
  .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .hint { color:var(--dim); font-size:12px; margin:0 0 12px; }
  .note { color:var(--dim); font-size:12px; }
  .idle { color:var(--dim); font-size:13px; text-align:center; padding:8px 0; }
  .addr { font-family:var(--mono); font-size:12px; word-break:break-all; }
  footer { color:var(--dim); font-size:12px; margin-top:24px; line-height:1.6; }
</style>
</head>
<body>
<main>
  <h1>SaveTogether</h1>
  <p class="sub">Local console &middot; 127.0.0.1 only</p>

  <div class="card counter">
    <span class="n" id="sigCount">0</span>
    <span class="label">Vault unlocks this session</span>
    <div class="note" id="sigNote">no session open</div>
  </div>

  <div id="pending"></div>

  <div class="card" id="vaultCard">
    <h2>Vault</h2>
    <div class="row"><span class="k">address</span><span class="v addr" id="vaultAddr">—</span></div>
    <div class="row"><span class="k">gas</span><span class="v" id="vaultEth">—</span></div>
    <div class="row"><span class="k">network</span><span class="v" id="vaultChain">—</span></div>
    <p class="hint" style="margin-top:12px">
      Send Sepolia ETH to the address above so the vault can pay for transactions.
      Confidential token balances are not shown here &mdash; that is what the conversation is for.
    </p>
    <div class="actions">
      <button id="copyAddr">Copy address</button>
      <button id="refreshVault">Refresh</button>
      <span class="note" id="vaultNote"></span>
    </div>
  </div>

  <div class="card" id="mintCard">
    <h2>Test tokens</h2>
    <p class="hint">Mints confidential test tokens straight to the vault. Testnet only.</p>
    <div class="inline">
      <select id="mintToken" style="font:13px var(--mono);padding:9px 10px;border-radius:7px;
        border:1px solid var(--line);background:var(--bg);color:var(--text)"></select>
      <input id="mintAmount" value="1000" inputmode="decimal" style="max-width:140px">
      <button class="primary" id="mintBtn">Mint</button>
    </div>
    <div class="note" id="mintNote" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <h2>Session</h2>
    <div class="row"><span class="k">session key</span><span class="v addr" id="skey">—</span></div>
    <div class="row"><span class="k">expires</span><span class="v" id="expiry">—</span></div>
    <div class="row"><span class="k">transfers</span><span class="v" id="txcount">—</span></div>
    <div class="row"><span class="k">allowlist</span><span class="v" id="allow">—</span></div>
    <div class="row"><span class="k">balance visible to session</span><span class="v" id="tier">—</span></div>
  </div>

  <div class="card">
    <h2>Transfer cap for the next session</h2>
    <p class="hint">
      Caps how many transfers a session can make &mdash; and with it, how many observations
      an outsider can gather about it. The residual timing channel needs roughly 120
      to become measurable at all.
    </p>
    <div class="inline">
      <input id="capInput" type="number" min="0" step="1" inputmode="numeric" style="max-width:140px">
      <button id="capSave">Save</button>
      <span class="note" id="capNote"></span>
    </div>
  </div>

  <div class="card">
    <div class="actions">
      <button class="danger" id="revoke">Revoke everything</button>
      <span class="note">Closes the session immediately. The session key can do this alone.</span>
    </div>
  </div>

  <footer>
    The conversation is the interface. This page exists for the things that must not happen
    in chat: unlocking the vault, confirming that a number may be revealed, typing an amount
    you do not want in the transcript &mdash; and the setup a chat window is a bad place for.
  </footer>
</main>
<script>
const TOKEN = document.documentElement.dataset.token;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-savetogether-token": TOKEN },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

function renderStatus(s) {
  $("sigCount").textContent = s.vaultUnlocks ?? 0;
  // Naming what the count is FOR is what makes a later increment read as
  // attributable rather than as drift. wrap and add_recipient each cost another
  // unlock by design, so the note has to say which, not just that it moved.
  const LABEL = {
    session: ["session", "sessions"],
    recipient: ["recipient added", "recipients added"],
    wrap: ["wrap", "wraps"],
  };
  const spent = (s.unlocks || [])
    .filter(function (u) { return u.n > 0; })
    .map(function (u) {
      const l = LABEL[u.reason] || [u.reason, u.reason];
      return u.n + " " + (u.n === 1 ? l[0] : l[1]);
    });
  $("sigNote").textContent = spent.length
    ? spent.join(" · ") + " · the vault locked again after each"
    : s.session
      ? "session open"
      : "no session open";
  $("skey").textContent = s.sessionKey ?? "—";
  $("expiry").textContent = s.expiry ? new Date(s.expiry * 1000).toLocaleString() : "—";
  $("txcount").textContent = s.session
    ? (s.maxTxCount ? s.txCount + " / " + s.maxTxCount : s.txCount + " / uncapped")
    : "—";
  $("allow").textContent = (s.recipients && s.recipients.length)
    ? s.recipients.map((a) => a.slice(0, 10) + "…").join(", ") : "—";
  $("tier").textContent = s.session ? (s.tier === "balance-visible" ? "yes" : "no") : "—";
}

function renderVault(v, err) {
  if (!v) {
    $("vaultNote").textContent = err
      ? "could not read the vault: " + err
      : "reading the vault…";
    return;
  }
  $("vaultAddr").textContent = v.address || "—";
  $("vaultEth").textContent = v.ethBalance != null ? v.ethBalance + " ETH" : "—";
  $("vaultChain").textContent = v.chainName || (v.chainId ? "chain " + v.chainId : "—");
  const sel = $("mintToken");
  if (v.tokens && sel.options.length !== v.tokens.length) {
    sel.innerHTML = v.tokens.map((t) => '<option>' + esc(t) + '</option>').join("");
  }
  $("mintCard").style.display = v.canMint ? "" : "none";
}

function renderSettings(cfg) {
  const input = $("capInput");
  if (document.activeElement !== input) input.value = cfg.maxTxCount ?? 0;
  $("capNote").textContent = (cfg.maxTxCount === 0) ? "uncapped" : "";
}

function renderPending(list) {
  const host = $("pending");
  if (!list.length) { host.innerHTML = ""; return; }
  host.innerHTML = list.map((p) => {
    if (p.kind === "unlock") return card("Unlock the vault",
      "The vault key signs the session open, then locks again. Nothing after this needs you.",
      esc(p.detail || ""),
      '<button class="primary" data-id="' + p.id + '" data-act="approve">Unlock</button>' +
      '<button data-id="' + p.id + '" data-act="deny">Cancel</button>');
    if (p.kind === "reveal") return card("Reveal an amount to the model?",
      "The model has not seen this number. Approving puts it in the conversation.",
      esc(p.detail || ""),
      '<button class="primary" data-id="' + p.id + '" data-act="approve">Reveal</button>' +
      '<button data-id="' + p.id + '" data-act="deny">Keep it hidden</button>');
    if (p.kind === "sealed") return card("Enter the amount",
      "Typed here, encrypted here. The model receives only whether it went through.",
      esc(p.detail || ""),
      '<input id="amt-' + p.id + '" placeholder="0.00" autocomplete="off" inputmode="decimal">' +
      '<div class="actions"><button class="primary" data-id="' + p.id + '" data-act="sealed">Send</button>' +
      '<button data-id="' + p.id + '" data-act="deny">Cancel</button></div>');
    return "";
  }).join("");
  const first = host.querySelector("input");
  if (first) first.focus();
}

function card(title, note, detail, actions) {
  return '<div class="card pending"><h2>' + esc(title) + '</h2><p>' + esc(note) + '</p>' +
    (detail ? '<div class="detail">' + detail + '</div>' : '') +
    (actions.indexOf('class="actions"') >= 0 ? actions : '<div class="actions">' + actions + '</div>') +
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

$("capSave").addEventListener("click", async () => {
  const r = await post("/api/settings", { maxTxCount: Number($("capInput").value) });
  $("capNote").textContent = r.ok ? "saved" : (r.reason || "rejected");
  setTimeout(refresh, 700);
});

$("copyAddr").addEventListener("click", async () => {
  const a = $("vaultAddr").textContent;
  try { await navigator.clipboard.writeText(a); $("vaultNote").textContent = "copied"; }
  catch { $("vaultNote").textContent = "select it and copy by hand"; }
  setTimeout(() => { $("vaultNote").textContent = ""; }, 2000);
});

$("refreshVault").addEventListener("click", async () => {
  $("vaultNote").textContent = "checking…";
  const r = await post("/api/vault", {});
  renderVault(r.vault, r.reason);
  $("vaultNote").textContent = r.ok === false ? (r.reason || "failed") : "";
});

$("mintBtn").addEventListener("click", async () => {
  const btn = $("mintBtn");
  btn.disabled = true;
  $("mintNote").textContent = "minting… this takes a few seconds";
  const r = await post("/api/mint", { symbol: $("mintToken").value, amount: $("mintAmount").value });
  $("mintNote").textContent = r.ok ? ("done — " + (r.tx || "")).slice(0, 80) : (r.reason || "failed");
  btn.disabled = false;
  refresh();
});

$("revoke").addEventListener("click", async () => {
  if (!confirm("Close the session and revoke everything it can do?")) return;
  await post("/api/revoke");
  refresh();
});

async function refresh() {
  try {
    const s = await (await fetch("/api/state", { headers: { "x-savetogether-token": TOKEN } })).json();
    renderStatus(s.status);
    renderSettings(s.settings || {});
    renderVault(s.vault, s.vaultError);
    renderPending(s.pending);
  } catch { /* the server is gone; the next tick will recover */ }
}

const es = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN));
es.onmessage = refresh;
refresh();
setInterval(refresh, 2500);
</script>
</body>
</html>`;
}
