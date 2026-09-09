// Every database field placed into HTML must go through esc() — prevents stored-XSS
// if a bad actor registers a capture with an HTML payload in the URL or captureId.

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// JSON.stringify does not escape < > & by default, so a Host header like
// `evil.com</script><script>alert(1)//` would break out of the script tag.
// Use Unicode escapes for these three characters to guarantee safe embedding.
function safeJson(v: string): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

export function buildValidatePage(apiBase: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privo Capture Validator</title>
<style>
:root{
  --bg:#f5f2ef;--surface:#fff;--ink:#0f0f12;--ink2:#5a5865;
  --line:#e0d9d2;--accent:#1a5fff;--accent-s:#edf1ff;
  --good:#0d7a44;--good-s:#e4f5ec;--good-b:#b8e6cc;
  --bad:#c0271d;--bad-s:#fdecea;--bad-b:#f5b8b4;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0d0d10;--surface:#18181c;--ink:#f0eee9;--ink2:#8a8794;
  --line:#2c2b33;--accent:#5c8aff;--accent-s:#1a2340;
  --good:#3fc47a;--good-s:#0e2818;--good-b:#1e5535;
  --bad:#f47068;--bad-s:#2a0e0c;--bad-b:#5c1a16;
}}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--bg);color:var(--ink);
  font:15px/1.65 -apple-system,'Segoe UI',system-ui,sans-serif;
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
}
.wrap{width:100%;max-width:560px;display:flex;flex-direction:column;gap:20px}
.header{display:flex;flex-direction:column;gap:4px}
.eyebrow{font:600 10px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
h1{font-size:26px;font-weight:800;letter-spacing:-.03em;line-height:1.1}
.sub{font-size:13.5px;color:var(--ink2);line-height:1.55}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
/* drop zone */
label.drop{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;padding:44px 32px;cursor:pointer;
  border:2px dashed var(--line);border-radius:14px;
  color:var(--ink2);transition:border-color .15s,background .15s,color .15s;
  text-align:center;
}
label.drop:hover,label.drop.over{border-color:var(--accent);background:var(--accent-s);color:var(--ink)}
label.drop .drop-icon{
  width:44px;height:44px;border-radius:12px;
  background:var(--line);display:flex;align-items:center;justify-content:center;
  transition:background .15s;
}
label.drop:hover .drop-icon,label.drop.over .drop-icon{background:var(--accent-s)}
label.drop .drop-icon svg{opacity:.5;transition:opacity .15s}
label.drop:hover .drop-icon svg,label.drop.over .drop-icon svg{opacity:.9}
label.drop .drop-label{font-size:14px;font-weight:500}
label.drop .drop-hint{font-size:12px;color:var(--ink2)}
input[type=file]{display:none}
/* states */
.checking{
  display:none;align-items:center;gap:10px;
  padding:16px 20px;font-size:14px;color:var(--ink2);
  border-top:1px solid var(--line);
}
.checking.visible{display:flex}
.spinner{
  width:16px;height:16px;border:2px solid var(--line);
  border-top-color:var(--accent);border-radius:50%;
  animation:spin .7s linear infinite;flex-shrink:0;
}
@keyframes spin{to{transform:rotate(360deg)}}
/* result */
.result{display:none;padding:18px 20px;border-top:1px solid var(--line)}
.result.ok{display:block;background:var(--good-s)}
.result.no{display:block;background:var(--bad-s)}
.result-head{
  display:flex;align-items:center;gap:8px;
  font-size:15px;font-weight:700;margin-bottom:6px;
}
.result.ok .result-head{color:var(--good)}
.result.no .result-head{color:var(--bad)}
.result-msg{font-size:13px;color:var(--ink2);margin-bottom:10px}
.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 16px}
.meta dt{font-size:12px;font-weight:600;color:var(--ink2);white-space:nowrap;padding-top:1px}
.meta dd{font:12px/1.5 ui-monospace,'SF Mono','Courier New',monospace;overflow-wrap:anywhere;color:var(--ink)}
/* divider line inside card */
.card > * + *{border-top:1px solid var(--line)}
.card > label.drop{border-top:none;border:2px dashed var(--line)}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <span class="eyebrow">// Privo AI</span>
    <h1>Capture Validator</h1>
    <p class="sub">Drop a sealed capture PNG here. Its SHA-256 hash is recomputed in your browser and checked against the registry — any pixel changed after sealing means no match.</p>
  </div>
  <div class="card">
    <label class="drop" id="drop">
      <div class="drop-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 8a2 2 0 012-2h2l1.5-2h7L17 6h2a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
          <circle cx="12" cy="13" r="3"/>
        </svg>
      </div>
      <span class="drop-label">Click or drop a PNG to validate</span>
      <span class="drop-hint">PNG files only · hash computed locally, never uploaded</span>
      <input type="file" id="file" accept="image/png">
    </label>
    <div class="checking" id="checking">
      <div class="spinner"></div>
      <span>Computing SHA-256 and checking registry…</span>
    </div>
    <div class="result" id="result"></div>
  </div>
</div>
<script>
(function () {
  var API = ${safeJson(apiBase)};
  var drop = document.getElementById('drop');
  var file = document.getElementById('file');
  var result = document.getElementById('result');
  var checking = document.getElementById('checking');

  drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function() { drop.classList.remove('over'); });
  drop.addEventListener('drop', function(e) {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) check(e.dataTransfer.files[0]);
  });
  file.addEventListener('change', function() { if (file.files[0]) check(file.files[0]); });

  async function check(f) {
    result.className = 'result';
    result.innerHTML = '';
    checking.classList.add('visible');
    try {
      var buf = await f.arrayBuffer();
      var hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
        .map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');

      var r = await fetch(API + '/captures/' + hash);
      checking.classList.remove('visible');

      if (r.status === 404) {
        showResult(false, 'No match', 'This file has no record in the registry. It was either never sealed by the extension, or it was modified after sealing.', null);
        return;
      }
      if (!r.ok) {
        showResult(false, 'Registry error', 'Could not reach the capture registry. Try again shortly.', null);
        return;
      }

      var data = await r.json();
      if (data.valid) {
        showResult(true, '✔ Authentic capture', null, data.record);
      } else {
        showResult(false, '✖ Signature invalid', 'The record exists but its signature does not match. The file may have been modified after sealing.', data.record);
      }
    } catch (err) {
      checking.classList.remove('visible');
      showResult(false, 'Error', String(err), null);
    }
  }

  /* All dynamic content is inserted via textContent, never innerHTML,
     so database values containing HTML/script cannot execute. */
  function showResult(ok, headline, message, record) {
    result.className = 'result ' + (ok ? 'ok' : 'no');

    var head = document.createElement('div');
    head.className = 'result-head';
    head.textContent = headline;
    result.appendChild(head);

    if (message) {
      var msg = document.createElement('p');
      msg.className = 'result-msg';
      msg.textContent = message;
      result.appendChild(msg);
    }

    if (record) {
      var dl = document.createElement('dl');
      dl.className = 'meta';
      var fields = [
        ['Capture ID', record.captureId],
        ['Page', record.url],
        ['Captured', record.capturedAt ? new Date(record.capturedAt).toLocaleString() : '—'],
        ['Registered', record.registeredAt],
        ['SHA-256', record.sha256],
      ];
      fields.forEach(function(pair) {
        var dt = document.createElement('dt');
        dt.textContent = pair[0];
        var dd = document.createElement('dd');
        dd.textContent = pair[1] ?? '—';
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      result.appendChild(dl);
    }
  }
})();
</script>
</body>
</html>`
}
