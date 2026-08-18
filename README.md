# iCloud Photo Manager

A local web dashboard for scheduling two kinds of jobs against your iCloud Photos
sync folder on Windows:

- **Hydrate** — force cloud-only photos to download and become fully local
- **Move to folder** — copy (or copy-then-delete) already-local photos into an
  archive/destination folder, skipping anything already there

Jobs run as background PowerShell processes, on a schedule you set from the UI,
and you get live progress + logs while they run.

This builds directly on the `hydrate` and `sync-move` PowerShell logic from
earlier — same cloud-only detection (`RecallOnOpen` / `RecallOnDataAccess`
attributes), same skip-if-exists + size-verified delete safety checks — just
wrapped in a scheduler and a UI instead of run by hand.

## Requirements

- **Windows 10/11**, with iCloud for Windows installed and Photos sync turned on
- **Node.js 18+** — https://nodejs.org (LTS installer is fine)
- PowerShell (built into Windows — no separate install needed)

## Setup

1. Copy the whole `icloud-photo-manager` folder to your PC, e.g. `C:\Apps\icloud-photo-manager`
2. Open a terminal (PowerShell or Command Prompt) in that folder:
   ```
   cd C:\Apps\icloud-photo-manager
   npm install
   ```
3. Start the app:
   ```
   npm start
   ```
4. Open **http://localhost:4173** in your browser.

Leave the terminal window open — that's what's running the background server.
Closing it stops the scheduler. See "Running persistently" below to avoid
needing to keep a terminal open.

## Using it

1. Click **New job**.
2. Pick a type:
   - **Make available locally** — targets cloud-only files under a source
     folder and downloads them.
   - **Move to folder** — targets already-local files under a source folder
     and copies (or moves) them into a destination folder.
3. Set the **source folder** — use **Browse** to navigate, or paste a path
   directly. Typically your iCloud Photos folder, e.g.
   `C:\Users\<you>\Pictures\iCloud Photos\Photos`.
4. Optionally narrow by file type (`jpg,heic,mov` or `*` for all) and limit
   how many files to process per run (0 = no limit).
5. Toggle **Run on a schedule** if you want it automatic — hourly, daily,
   weekly, or a raw cron expression — otherwise just use **Run now** whenever
   you like.
6. Save. You'll land on the **Activity & logs** tab where you can watch it
   run in real time: a progress bar, a live console (color-coded by
   hydrated/copied/skipped/deleted/error), and the pipeline diagram at the
   top of the Jobs tab reflects the latest counts.

Every run is logged to `logs/<runId>.log` and summarized in the Activity tab's
run history, so you always have a record of what was copied, skipped, moved,
or failed — even after the fact.

### Safety behavior carried over from the original script

- **Move to folder** never deletes a source file until the destination copy
  exists and its byte size matches the source.
- Files that already exist at the destination are always skipped, never
  overwritten.
- Hydration only targets files Windows has actually marked cloud-only; it
  won't re-download files that are already local.

## Running persistently in the background

Right now `npm start` runs in the foreground of whatever terminal launched
it. Two good options if you want it running continuously without a terminal
window open, so scheduled jobs fire even when you're not watching:

**Option A — pm2 (simplest)**
```
npm install -g pm2
pm2 start server.js --name icloud-photo-manager
pm2 save
pm2-startup install    # follow the printed instructions to launch on login
```

**Option B — Windows Task Scheduler**
Create a task that runs at log-on:
- Program: `node.exe` (find the path with `where node`)
- Arguments: `server.js`
- Start in: the `icloud-photo-manager` folder
- Check "Run whether user is logged on or not" if you want it to survive logout

Either way, once the server process is running continuously, your in-app
schedules (hourly/daily/weekly/cron) will keep firing on their own — you only
need the browser open when you actually want to look at something.

## Notes

- This app only listens on `localhost` — it's not exposed to your network,
  so it's only reachable from the PC it runs on.
- The folder browser only lists directories (not files) and starts from your
  user profile and drive roots.
- If PowerShell execution is blocked on your system, the app launches
  scripts with `-ExecutionPolicy Bypass` scoped to that single process, the
  same safe, non-persistent workaround used when running the original
  standalone script.
