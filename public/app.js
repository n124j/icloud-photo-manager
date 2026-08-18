const socket = io();

// ---------- state ----------
let jobs = [];
let runs = [];
let activeRunProgress = {}; // runId -> {done,total,jobName,type}
let browseTargetField = null;
let selectedType = "hydrate";

// ---------- elements ----------
const jobGrid = document.getElementById("jobGrid");
const jobEmpty = document.getElementById("jobEmpty");
const jobCount = document.getElementById("jobCount");
const consoleEl = document.getElementById("console");
const runningList = document.getElementById("runningList");
const runHistoryEl = document.getElementById("runHistory");

// ---------- view switching ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    document.getElementById("view-jobs").style.display = view === "jobs" ? "" : "none";
    document.getElementById("view-activity").style.display = view === "activity" ? "" : "none";
  });
});

// ---------- connection status ----------
socket.on("connect", () => {
  document.getElementById("connDot").classList.add("online");
  document.getElementById("connLabel").textContent = "Connected";
});
socket.on("disconnect", () => {
  document.getElementById("connDot").classList.remove("online");
  document.getElementById("connLabel").textContent = "Disconnected";
});

// ---------- data loading ----------
async function loadJobs() {
  jobs = await (await fetch("/api/jobs")).json();
  renderJobs();
}
async function loadRuns() {
  runs = await (await fetch("/api/runs")).json();
  renderRunHistory();
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function shortPath(p) {
  if (!p) return "—";
  return p.length > 42 ? "…" + p.slice(-40) : p;
}

// ---------- render: job cards ----------
function renderJobs() {
  jobGrid.innerHTML = "";
  jobCount.textContent = jobs.length || "";
  jobEmpty.style.display = jobs.length ? "none" : "block";

  jobs.forEach((job) => {
    const card = document.createElement("div");
    card.className = "job-card";

    const statusBadge = !job.enabled
      ? `<span class="badge off">Off</span>`
      : job.lastRun
      ? `<span class="badge ${job.lastRun.status}">${job.lastRun.status}</span>`
      : `<span class="badge idle">Idle</span>`;

    const scheduleChip = job.schedule && job.schedule.enabled
      ? `<span class="chip">⏱ ${job.schedule.description || job.schedule.cron}</span>`
      : `<span class="chip">Manual only</span>`;

    card.innerHTML = `
      <div class="job-card-top">
        <div>
          <h3>${escapeHtml(job.name)}</h3>
          <span class="badge ${job.type}">${job.type === "hydrate" ? "Hydrate" : "Move / Copy"}</span>
        </div>
        ${statusBadge}
      </div>
      <div class="job-path" title="${escapeHtml(job.sourceFolder)}">from: ${shortPath(job.sourceFolder)}</div>
      ${job.type === "sync" ? `<div class="job-path" title="${escapeHtml(job.destFolder)}">to: ${shortPath(job.destFolder)}</div>` : ""}
      <div class="job-meta-row">
        <span class="chip">${job.extensions || "*"}</span>
        <span class="chip">${job.count > 0 ? job.count + " files" : "all matches"}</span>
        <span class="chip">${job.orderBy}</span>
        ${job.type === "sync" ? `<span class="chip">${job.action}</span>` : ""}
        ${scheduleChip}
      </div>
      <div class="job-card-actions">
        <button class="btn small primary" data-action="run">Run now</button>
        <button class="btn small ghost" data-action="edit">Edit</button>
        <button class="btn small ghost danger" data-action="delete">Delete</button>
      </div>
    `;

    card.querySelector('[data-action="run"]').addEventListener("click", () => runJob(job.id));
    card.querySelector('[data-action="edit"]').addEventListener("click", () => openJobModal(job));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteJob(job.id));

    jobGrid.appendChild(card);
  });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- job actions ----------
async function runJob(id) {
  await fetch(`/api/jobs/${id}/run`, { method: "POST" });
  document.querySelector('.tab-btn[data-view="activity"]').click();
}
async function deleteJob(id) {
  if (!confirm("Delete this job? Its schedule will stop immediately.")) return;
  await fetch(`/api/jobs/${id}`, { method: "DELETE" });
  loadJobs();
}

// ---------- job modal ----------
const jobModalBackdrop = document.getElementById("jobModalBackdrop");
const jobForm = document.getElementById("jobForm");

document.getElementById("newJobBtn").addEventListener("click", () => openJobModal(null));
document.getElementById("cancelModalBtn").addEventListener("click", closeJobModal);

document.getElementById("typeCardHydrate").addEventListener("click", () => setType("hydrate"));
document.getElementById("typeCardSync").addEventListener("click", () => setType("sync"));

function setType(t) {
  selectedType = t;
  document.getElementById("typeCardHydrate").classList.toggle("selected", t === "hydrate");
  document.getElementById("typeCardSync").classList.toggle("selected", t === "sync");
  document.getElementById("destFolderField").style.display = t === "sync" ? "" : "none";
  document.getElementById("actionField").style.display = t === "sync" ? "" : "none";
}

document.getElementById("scheduleEnabled").addEventListener("change", (e) => {
  document.getElementById("scheduleFields").style.display = e.target.checked ? "" : "none";
});

document.getElementById("freqPreset").addEventListener("change", (e) => {
  ["freqHourly", "freqDaily", "freqWeekly", "freqCustom"].forEach((id) => (document.getElementById(id).style.display = "none"));
  document.getElementById({ hourly: "freqHourly", daily: "freqDaily", weekly: "freqWeekly", custom: "freqCustom" }[e.target.value]).style.display = "";
});

function openJobModal(job) {
  document.getElementById("modalTitle").textContent = job ? "Edit job" : "New job";
  document.getElementById("jobId").value = job ? job.id : "";
  document.getElementById("jobName").value = job ? job.name : "";
  document.getElementById("sourceFolder").value = job ? job.sourceFolder : "";
  document.getElementById("destFolder").value = job ? job.destFolder : "";
  document.getElementById("extensions").value = job ? job.extensions : "*";
  document.getElementById("count").value = job ? job.count : 0;
  document.getElementById("orderBy").value = job ? job.orderBy : "Newest";
  document.getElementById("action").value = job ? job.action : "Copy";
  document.getElementById("jobEnabled").checked = job ? job.enabled : true;

  setType(job ? job.type : "hydrate");

  const schedEnabled = job && job.schedule && job.schedule.enabled;
  document.getElementById("scheduleEnabled").checked = !!schedEnabled;
  document.getElementById("scheduleFields").style.display = schedEnabled ? "" : "none";
  document.getElementById("customCron").value = job && job.schedule ? job.schedule.cron : "";
  document.getElementById("freqPreset").value = "custom";
  document.getElementById("freqCustom").style.display = "";
  document.getElementById("freqHourly").style.display = "none";
  document.getElementById("freqDaily").style.display = "none";
  document.getElementById("freqWeekly").style.display = "none";

  jobModalBackdrop.style.display = "flex";
}
function closeJobModal() {
  jobModalBackdrop.style.display = "none";
}

function buildCron() {
  const preset = document.getElementById("freqPreset").value;
  if (preset === "hourly") {
    const n = Math.max(1, parseInt(document.getElementById("everyHours").value || "6", 10));
    return { cron: `0 */${n} * * *`, description: `Every ${n}h` };
  }
  if (preset === "daily") {
    const [h, m] = (document.getElementById("dailyTime").value || "02:00").split(":").map((x) => parseInt(x, 10));
    return { cron: `${m || 0} ${h || 0} * * *`, description: `Daily ${document.getElementById("dailyTime").value}` };
  }
  if (preset === "weekly") {
    const day = document.getElementById("weeklyDay").value;
    const [h, m] = (document.getElementById("weeklyTime").value || "02:00").split(":").map((x) => parseInt(x, 10));
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return { cron: `${m || 0} ${h || 0} * * ${day}`, description: `Weekly ${dayNames[day]} ${document.getElementById("weeklyTime").value}` };
  }
  const c = document.getElementById("customCron").value.trim();
  return { cron: c, description: c };
}

jobForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("jobId").value;
  const scheduleEnabled = document.getElementById("scheduleEnabled").checked;
  const { cron, description } = scheduleEnabled ? buildCron() : { cron: "", description: "" };

  const payload = {
    name: document.getElementById("jobName").value || "Untitled job",
    type: selectedType,
    sourceFolder: document.getElementById("sourceFolder").value,
    destFolder: document.getElementById("destFolder").value,
    extensions: document.getElementById("extensions").value || "*",
    count: parseInt(document.getElementById("count").value || "0", 10),
    orderBy: document.getElementById("orderBy").value,
    action: document.getElementById("action").value,
    enabled: document.getElementById("jobEnabled").checked,
    schedule: { enabled: scheduleEnabled, cron, description },
  };

  if (id) {
    await fetch(`/api/jobs/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } else {
    await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  closeJobModal();
  loadJobs();
});

// ---------- folder browser ----------
const browseModalBackdrop = document.getElementById("browseModalBackdrop");
const browserList = document.getElementById("browserList");
const browserPath = document.getElementById("browserPath");
let currentBrowsePath = "";

document.querySelectorAll("[data-browse]").forEach((btn) => {
  btn.addEventListener("click", () => {
    browseTargetField = btn.dataset.browse;
    openBrowser("");
  });
});
document.getElementById("cancelBrowseBtn").addEventListener("click", () => (browseModalBackdrop.style.display = "none"));
document.getElementById("selectFolderBtn").addEventListener("click", () => {
  if (browseTargetField) document.getElementById(browseTargetField).value = currentBrowsePath;
  browseModalBackdrop.style.display = "none";
});

async function openBrowser(path) {
  const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  currentBrowsePath = data.path || "";
  browserPath.textContent = currentBrowsePath || "This PC";
  browserList.innerHTML = "";

  if (data.parent) {
    const up = document.createElement("div");
    up.className = "browser-item";
    up.innerHTML = "⬆ .. (up one level)";
    up.addEventListener("click", () => openBrowser(data.parent));
    browserList.appendChild(up);
  }

  data.entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "browser-item";
    item.innerHTML = `📁 ${escapeHtml(entry.name)}`;
    item.addEventListener("click", () => openBrowser(entry.path));
    browserList.appendChild(item);
  });

  browseModalBackdrop.style.display = "flex";
}

// ---------- activity: running jobs + console ----------
function addConsoleLine(text, cls) {
  const line = document.createElement("div");
  line.className = "line " + (cls || "plain");
  line.textContent = text;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  while (consoleEl.children.length > 500) consoleEl.removeChild(consoleEl.firstChild);
}

function renderRunningList() {
  const active = Object.entries(activeRunProgress);
  runningList.innerHTML = "";
  if (active.length === 0) {
    runningList.innerHTML = `<div class="empty-state" style="padding:22px;">No jobs currently running.</div>`;
    return;
  }
  active.forEach(([runId, p]) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "run-row";
    row.innerHTML = `
      <span class="badge running">Running</span>
      <span class="name">${escapeHtml(p.jobName || "Job")}</span>
      <div class="progress-bar"><div style="width:${pct}%"></div></div>
      <span class="time">${p.done || 0}/${p.total || "?"}</span>
    `;
    runningList.appendChild(row);
  });
}

function renderRunHistory() {
  runHistoryEl.innerHTML = "";
  if (!runs.length) {
    runHistoryEl.innerHTML = `<div class="empty-state" style="padding:22px;">No runs yet.</div>`;
    return;
  }
  runs.slice(0, 30).forEach((r) => {
    const row = document.createElement("div");
    row.className = "run-row";
    const summaryText = r.summary
      ? Object.entries(r.summary).filter(([k]) => k !== "type").map(([k, v]) => `${k}: ${v}`).join("  ·  ")
      : "";
    row.innerHTML = `
      <span class="badge ${r.status}">${r.status}</span>
      <span class="name">${escapeHtml(r.jobName)}</span>
      <span class="chip">${r.type}</span>
      <span class="time">${fmtTime(r.startedAt)}</span>
      <button class="btn small ghost" data-log="${r.id}">View log</button>
    `;
    row.querySelector("[data-log]").addEventListener("click", async () => {
      const text = await (await fetch(`/api/runs/${r.id}/log`)).text();
      alert(text.slice(-4000));
    });
    runHistoryEl.appendChild(row);
  });
}

// ---------- pipeline signature: live counts ----------
function pulseFlow(kind) {
  const dot = document.getElementById(kind === "hydrate" ? "dotHydrate" : "dotMove");
  dot.classList.add("active");
  clearTimeout(dot._t);
  dot._t = setTimeout(() => dot.classList.remove("active"), 2200);
}

let runningJobTypes = {}; // runId -> type

// ---------- socket events ----------
socket.on("run:status", (run) => {
  if (!run) return;
  if (run.status === "running") {
    activeRunProgress[run.id] = { done: 0, total: 0, jobName: run.jobName };
    runningJobTypes[run.id] = run.type;
    addConsoleLine(`▶ Started "${run.jobName}" (${run.type})`, "plain");
  } else {
    delete activeRunProgress[run.id];
    delete runningJobTypes[run.id];
    addConsoleLine(`■ Finished "${run.jobName}" — ${run.status}`, run.status === "error" ? "error" : "plain");
    loadJobs();
    loadRuns();
  }
  renderRunningList();
});

socket.on("run:event", (evt) => {
  if (evt.type === "start") {
    activeRunProgress[evt.runId] = activeRunProgress[evt.runId] || {};
    activeRunProgress[evt.runId].total = evt.total;
    renderRunningList();
  } else if (evt.type === "progress") {
    if (activeRunProgress[evt.runId]) activeRunProgress[evt.runId].done = evt.done;
    renderRunningList();
    addConsoleLine(`${evt.action.padEnd(14)} ${evt.file}${evt.message ? " — " + evt.message : ""}`, evt.action);
    const type = runningJobTypes[evt.runId];
    if (evt.action === "hydrated") pulseFlow("hydrate");
    if (evt.action === "copied" || evt.action === "deletedSource") pulseFlow("move");
  } else if (evt.type === "summary") {
    if (evt.hydrated !== undefined) document.getElementById("countLocal").textContent = evt.hydrated;
    if (evt.cloudOnly !== undefined) document.getElementById("countCloud").textContent = evt.cloudOnly;
    if (evt.copied !== undefined || evt.deletedSource !== undefined) {
      document.getElementById("countArchive").textContent = (evt.copied || 0) + (evt.deletedSource || 0) > 0 ? (evt.copied || 0) : evt.copied || 0;
    }
    addConsoleLine(`Σ Summary: ${JSON.stringify(evt)}`, "plain");
  } else if (evt.type === "error") {
    addConsoleLine(`Error: ${evt.message}`, "error");
  }
});

socket.on("run:log", (payload) => {
  addConsoleLine(payload.line, "plain");
});

// ---------- init ----------
loadJobs();
loadRuns();
setInterval(loadRuns, 15000);
