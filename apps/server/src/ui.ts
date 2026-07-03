export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>reflow</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922;--purple:#bc8cff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:24px;max-width:1100px;margin:0 auto}
h1{font-size:18px;margin-bottom:4px}
h1 span{color:var(--accent)}
.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.layout{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.panel h2{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--border)}
.run{padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;gap:10px;align-items:center}
.run:hover{background:#1c2129}
.run.selected{background:#1f2733}
.run .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run .id{color:var(--muted);font-size:11px}
.badge{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid}
.badge.pending{color:var(--muted);border-color:var(--muted)}
.badge.running{color:var(--accent);border-color:var(--accent)}
.badge.sleeping{color:var(--yellow);border-color:var(--yellow)}
.badge.completed{color:var(--green);border-color:var(--green)}
.badge.failed{color:var(--red);border-color:var(--red)}
.event{padding:8px 14px;border-bottom:1px solid var(--border);display:flex;gap:10px}
.event .seq{color:var(--muted);min-width:26px}
.event .type{min-width:130px}
.event .type.step_completed{color:var(--green)}
.event .type.step_failed{color:var(--red)}
.event .type.run_failed{color:var(--red)}
.event .type.run_completed{color:var(--green)}
.event .type.timer_started,.event .type.timer_fired{color:var(--yellow)}
.event .type.signal_received{color:var(--purple)}
.event .type.child_started{color:var(--accent)}
.event .detail{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.empty{padding:20px 14px;color:var(--muted)}
button{background:none;border:1px solid var(--red);color:var(--red);border-radius:6px;padding:2px 10px;font:inherit;font-size:11px;cursor:pointer}
button:hover{background:var(--red);color:var(--bg)}
.meta{padding:10px 14px;border-bottom:1px solid var(--border);color:var(--muted);font-size:12px;word-break:break-all}
.meta b{color:var(--text)}
</style>
</head>
<body>
<h1><span>reflow</span> runs</h1>
<div class="sub">auto refresh every 2s</div>
<div class="layout">
  <div class="panel"><h2>runs</h2><div id="runs"><div class="empty">no runs yet</div></div></div>
  <div class="panel"><h2>history</h2><div id="history"><div class="empty">select a run</div></div></div>
</div>
<script>
let selected = null;

function esc(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}

function describe(ev) {
  if (ev.type === "step_completed" || ev.type === "step_failed") {
    let text = ev.stepId;
    if (ev.attempt) text += " attempt " + ev.attempt;
    if (ev.error) text += " " + ev.error;
    return text;
  }
  if (ev.type === "timer_started") return "wake at " + ev.wakeAt;
  if (ev.type === "signal_received") return ev.name + " " + JSON.stringify(ev.payload);
  if (ev.type === "child_started") return ev.workflowName + " " + ev.childRunId;
  if (ev.type === "value_recorded") return ev.kind + " = " + JSON.stringify(ev.value);
  if (ev.type === "run_completed") return JSON.stringify(ev.output);
  if (ev.type === "run_failed") return ev.error;
  if (ev.type === "run_started") return JSON.stringify(ev.input);
  return "";
}

async function loadRuns() {
  const res = await fetch("/api/runs?limit=50");
  const { runs } = await res.json();
  const box = document.getElementById("runs");
  if (!runs.length) {
    box.innerHTML = '<div class="empty">no runs yet</div>';
    return;
  }
  box.innerHTML = runs.map((r) =>
    '<div class="run' + (r.id === selected ? " selected" : "") + '" data-id="' + r.id + '">' +
      '<span class="name">' + esc(r.workflowName) + '<br><span class="id">' + r.id + "</span></span>" +
      (r.status === "failed" ? '<button data-retry="' + r.id + '">retry</button>' : "") +
      '<span class="badge ' + r.status + '">' + r.status + "</span>" +
    "</div>"
  ).join("");
}

async function loadHistory() {
  const box = document.getElementById("history");
  if (!selected) return;
  const res = await fetch("/api/runs/" + selected + "?include=history");
  if (!res.ok) return;
  const run = await res.json();
  const meta =
    '<div class="meta"><b>' + esc(run.workflowName) + "</b> " + run.id +
    "<br>input " + esc(JSON.stringify(run.input)) +
    (run.output !== null ? "<br>output " + esc(JSON.stringify(run.output)) : "") +
    (run.error ? "<br>error " + esc(run.error) : "") +
    "</div>";
  box.innerHTML = meta + run.history.map((ev) =>
    '<div class="event"><span class="seq">' + ev.seq + '</span>' +
    '<span class="type ' + ev.type + '">' + ev.type + "</span>" +
    '<span class="detail">' + esc(describe(ev)) + "</span></div>"
  ).join("");
}

document.getElementById("runs").addEventListener("click", async (e) => {
  const retryId = e.target.getAttribute && e.target.getAttribute("data-retry");
  if (retryId) {
    await fetch("/api/runs/" + retryId + "/retry", { method: "POST" });
    await loadRuns();
    return;
  }
  const row = e.target.closest(".run");
  if (!row) return;
  selected = row.getAttribute("data-id");
  await loadRuns();
  await loadHistory();
});

async function refresh() {
  try {
    await loadRuns();
    await loadHistory();
  } catch {}
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
