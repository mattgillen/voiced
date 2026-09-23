// Server-rendered pages: OAuth consent and plain error pages.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#16181d;--muted:#5d6370;--line:#e4e2dc;--accent:#1f6f5c;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#101214;--card:#181b1f;--ink:#eef0f2;--muted:#9aa1ab;--line:#2a2e34;--accent:#3fb28f;--accent-ink:#06130f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "Inter",system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:440px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px}ul{padding-left:18px;margin:0 0 20px}li{margin:6px 0}
.brand{font-weight:700;letter-spacing:-.01em;margin-bottom:18px;display:flex;gap:8px;align-items:center}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
small{display:block;color:var(--muted);margin-top:14px}`;

export function consentPage(clientName: string, query: string, user: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Voiced</title><style>${STYLE}</style></head><body><form class="card" method="post" action="/oauth/authorize?${esc(query)}">
<div class="brand"><span class="dot"></span>Voiced</div>
<h1>${esc(clientName)} wants to make calls for you</h1>
<p>Signed in as ${esc(user)}. If you allow it, ${esc(clientName)} can ask Voiced to:</p>
<ul>
<li>Call businesses and get through their phone trees for you</li>
<li>Enter your account details from your Voiced vault (${esc(clientName)} never sees card numbers or PINs)</li>
<li>Pay bills within limits you set; anything above them comes back to you</li>
<li>Wait on hold and connect you when a person picks up</li>
</ul>
<div class="row"><button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="allow">Allow</button></div>
<small>You can revoke access any time. Voiced tells every person it talks to that it is an AI assistant.</small>
</form></body></html>`;
}

export function errorPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voiced</title><style>${STYLE}</style></head><body><div class="card"><div class="brand"><span class="dot"></span>Voiced</div>
<h1>${esc(title)}</h1><p>${esc(detail)}</p></div></body></html>`;
}
