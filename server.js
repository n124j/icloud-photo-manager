const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");

const PORT = process.env.PORT || 4173;
const DB_PATH = path.join(__dirname, "data", "db.json");
const LOG_DIR = path.join(__dirname, "logs");
const SCRIPTS_DIR = path.join(__dirname, "scripts");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- tiny file-based "database" ----------
function readDb() {
  if (!fs.existsSync(DB_PATH)) return { jobs: [], runs: [] };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- app / server / sockets ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

// runId -> { proc, jobId }
const activeRuns = new Map();
// jobId -> cron.ScheduledTask
const scheduledTasks = new Map();

// ---------- helpers ----------
function buildArgs(job) {
  const scriptPath =
    job.type === "hydrate"
      ? path.join(SCRIPTS_DIR, "hydrate-photos.ps1")
      : path.join(SCRIPTS_DIR, "sync-move.ps1");

  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
  args.push("-SourceFolder", job.sourceFolder);

  if (job.type === "sync") {
    args.push("-DestFolder", job.destFolder);
    args.push("-Action", job.action || "Copy");
  }

  args.push("-Extensions", job.extensions || "*");
  args.push("-Count", String(job.count || 0));
  args.push("-OrderBy", job.orderBy || "Newest");

  return { scriptPath, args };
}

function runJob(job) {
  return new Promise((resolve) => {
    const runId = uuid();
    const startedAt = new Date().toISOString();
    const logFile = path.join(LOG_DIR, `${runId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    const db = readDb();
    const run = {
      id: runId,
      jobId: job.id,
      jobName: job.name,
      type: job.type,
      status: "running",
      startedAt,
      finishedAt: null,
      summary: null,
    };
    db.runs.unshift(run);
    db.runs = db.runs.slice(0, 200); // cap history
    writeDb(db);

    io.emit("run:status", run);

    const { args } = buildArgs(job);
    const proc = spawn("powershell.exe", args, { windowsHide: true });
    activeRuns.set(runId, { proc, jobId: job.id });

    let buffer = "";
    const handleChunk = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line) continue;
        logStream.write(line + "\n");
        if (line.startsWith("::EVENT::")) {
          try {
            const data = JSON.parse(line.replace("::EVENT::", ""));
            io.emit("run:event", { runId, jobId: job.id, ...data });
          } catch {
            io.emit("run:log", { runId, jobId: job.id, line });
          }
        } else {
          io.emit("run:log", { runId, jobId: job.id, line });
        }
      }
    };

    proc.stdout.on("data", handleChunk);
    proc.stderr.on("data", (d) => {
      const line = d.toString();
      logStream.write("[stderr] " + line);
      io.emit("run:log", { runId, jobId: job.id, line: "[error] " + line.trim() });
    });

    proc.on("close", (code) => {
      logStream.end();
      activeRuns.delete(runId);

      const db2 = readDb();
      const r = db2.runs.find((x) => x.id === runId);
      if (r) {
        r.status = code === 0 ? "success" : "error";
        r.finishedAt = new Date().toISOString();
      }
      const j = db2.jobs.find((x) => x.id === job.id);
      if (j) {
        j.lastRun = { runId, status: r ? r.status : "error", finishedAt: r ? r.finishedAt : new Date().toISOString() };
      }
      writeDb(db2);
      io.emit("run:status", r);
      resolve(r);
    });
  });
}

function scheduleJob(job) {
  const existing = scheduledTasks.get(job.id);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(job.id);
  }
  if (job.enabled && job.schedule && job.schedule.enabled && job.schedule.cron && cron.validate(job.schedule.cron)) {
    const task = cron.schedule(job.schedule.cron, () => {
      runJob(job);
    });
    scheduledTasks.set(job.id, task);
  }
}

function scheduleAll() {
  const db = readDb();
  db.jobs.forEach(scheduleJob);
}

// ---------- REST API ----------
app.get("/api/jobs", (req, res) => {
  res.json(readDb().jobs);
});

app.post("/api/jobs", (req, res) => {
  const db = readDb();
  const job = {
    id: uuid(),
    name: req.body.name || "Untitled job",
    type: req.body.type === "sync" ? "sync" : "hydrate",
    sourceFolder: req.body.sourceFolder || "",
    destFolder: req.body.destFolder || "",
    extensions: req.body.extensions || "*",
    count: Number(req.body.count) || 0,
    orderBy: req.body.orderBy || "Newest",
    action: req.body.action === "Move" ? "Move" : "Copy",
    enabled: req.body.enabled !== false,
    schedule: {
      enabled: !!(req.body.schedule && req.body.schedule.enabled),
      cron: (req.body.schedule && req.body.schedule.cron) || "",
      description: (req.body.schedule && req.body.schedule.description) || "",
    },
    lastRun: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.jobs.push(job);
  writeDb(db);
  scheduleJob(job);
  res.status(201).json(job);
});

app.put("/api/jobs/:id", (req, res) => {
  const db = readDb();
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  Object.assign(job, {
    name: req.body.name ?? job.name,
    type: req.body.type ?? job.type,
    sourceFolder: req.body.sourceFolder ?? job.sourceFolder,
    destFolder: req.body.destFolder ?? job.destFolder,
    extensions: req.body.extensions ?? job.extensions,
    count: req.body.count !== undefined ? Number(req.body.count) : job.count,
    orderBy: req.body.orderBy ?? job.orderBy,
    action: req.body.action ?? job.action,
    enabled: req.body.enabled !== undefined ? req.body.enabled : job.enabled,
    schedule: req.body.schedule ?? job.schedule,
    updatedAt: new Date().toISOString(),
  });

  writeDb(db);
  scheduleJob(job);
  res.json(job);
});

app.delete("/api/jobs/:id", (req, res) => {
  const db = readDb();
  const task = scheduledTasks.get(req.params.id);
  if (task) {
    task.stop();
    scheduledTasks.delete(req.params.id);
  }
  db.jobs = db.jobs.filter((j) => j.id !== req.params.id);
  writeDb(db);
  res.status(204).end();
});

app.post("/api/jobs/:id/run", (req, res) => {
  const db = readDb();
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  runJob(job); // fire and forget; progress streams over socket.io
  res.status(202).json({ started: true });
});

app.get("/api/runs", (req, res) => {
  const db = readDb();
  const jobId = req.query.jobId;
  const runs = jobId ? db.runs.filter((r) => r.jobId === jobId) : db.runs;
  res.json(runs.slice(0, 100));
});

app.get("/api/runs/:runId/log", (req, res) => {
  const logFile = path.join(LOG_DIR, `${req.params.runId}.log`);
  if (!fs.existsSync(logFile)) return res.status(404).json({ error: "No log found" });
  res.type("text/plain").send(fs.readFileSync(logFile, "utf-8"));
});

// Simple folder browser so the UI can let the user pick paths without typing them blind
app.get("/api/browse", (req, res) => {
  let target = req.query.path;
  if (!target) {
    // Sensible starting points on Windows
    const roots = ["C:\\Users", "C:\\"];
    const home = process.env.USERPROFILE;
    if (home) roots.unshift(home);
    return res.json({ path: "", entries: roots.map((r) => ({ name: r, path: r })) });
  }
  try {
    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }));
    const parent = path.dirname(target);
    res.json({ path: target, parent: parent !== target ? parent : null, entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/runs/:runId/cancel", (req, res) => {
  const active = activeRuns.get(req.params.runId);
  if (!active) return res.status(404).json({ error: "Run not active" });
  active.proc.kill();
  res.json({ cancelled: true });
});

io.on("connection", (socket) => {
  socket.emit("hello", { activeRuns: Array.from(activeRuns.keys()) });
});

scheduleAll();

server.listen(PORT, () => {
  console.log(`iCloud Photo Manager running at http://localhost:${PORT}`);
});
