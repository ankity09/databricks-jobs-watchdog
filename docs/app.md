# The Watchdog app

The Watchdog app is a Databricks App, a web app that Databricks hosts and signs people in to. It shows what the scans found, keeps your list of monitored jobs where you can edit it, and has a copilot you can ask about failures. It reads the same tables the dashboard reads. The checks do not change.

This page explains what each section shows, who each call runs as, what the app stores, how the job list is versioned, what the copilot can and cannot do, and what is not built. To install it, follow [DEPLOY.md](../DEPLOY.md#step-6-install-the-app).

## How the pieces fit

```
Browser (the person signed in)
  |
  v
watchdog-app (a Node server and a React page)
  |- Monitoring ------- SQL warehouse, as the person --> findings_latest, findings, config_loads
  |- Jobs and deps ---- Lakebase, as the app ---------> watchdog_app.job_list_versions
  |    '- job picker --- SQL warehouse, as the person --> system.lakeflow.jobs, system.access.workspaces_latest
  |- Copilot ---------- Genie agent, as the person ----> the six Watchdog tables
  '- Scan now --------- Jobs API, as the app ----------> starts watchdog_scan

watchdog_scan (the checks are the same as before)
  notebook 02, scan.config_source = yaml     -> reads the YAML file
  notebook 02, scan.config_source = lakebase -> reads the newest saved version of the job list
  -> the same four config tables -> notebooks 05 and 06 -> findings
  notebook 02 adds one row to config_loads on every run
```

Lakebase is Databricks' managed Postgres database. The app keeps the job list in a Lakebase project, one per Watchdog. A SQL warehouse is the compute that runs the app's queries on the Watchdog tables. Genie is the Databricks feature that turns a question into SQL over a set of tables.

Until you switch `scan.config_source` to `lakebase`, the scans keep reading the YAML file, and the app's job list is only a copy you can edit. The app says so in a banner (see [The config banner](#the-config-banner)).

## The sections

The app has a left navigation bar. It shows the Watchdog name and the region it watches, the three sections, and at the bottom the time of the last scan with a live dot, a Scan now button, and who is signed in. The bar collapses to icons and remembers whether you left it collapsed. On a narrow window it moves behind a menu button at the top of the page.

The page refreshes its data every 5 minutes while the tab is visible, and once when you come back to a tab that was away for 5 minutes or more.

### Monitoring

Monitoring shows the current status of every monitored job, from `findings_latest`.

- **Counts.** Four tiles show how many jobs are failed, warning, unknown and healthy. Clicking a tile filters the list to that status.
- **The job list.** One row per job per workspace, with its status (the worst of its checks), severity, owner, environment, last run and failing checks. A job the Watchdog could not find shows as unknown, with the reason.
- **Filters.** Environment, owner, severity, workspace, failing check and last run (in the last 24 hours, older, or none).
- **The detail panel.** Click a row. The panel shows each check's latest result with its error text, the failed tasks, the code version, links to the run and to the CI pipeline, and the jobs a failure affects. An Ask the copilot button opens a chat about that job.
- **The history strip.** For each job, its worst status in fixed time windows: 1-hour windows over 24 hours, 2-hour windows over 3 days (the default) and 4-hour windows over 7 days. A window with no scan shows as a gap, so a scan that stopped is visible. A window has no fixed link to your scan schedule: with a scan every 20 minutes, a 1-hour window holds three scans.
- **Scan now.** The button in the navigation bar starts `watchdog_scan` once. It shows progress with a link to the run, and refreshes the page when the run ends. If a scan is already running, it says so and shows that run.

On a Watchdog that reads its job list from Lakebase and has no jobs yet, Monitoring says the job list is empty and links to the Job list, instead of telling you to scan.

### Jobs and dependencies

This section edits the job list. It has four pages.

- **Job list.** The jobs the Watchdog monitors, with their schedule type, limits, severity, owner, environments, an Enabled switch and live status. Add job, edit a job, switch it off or delete it in a side form; rule errors show next to the field as you type. Deleting a job also removes its dependency links, and the confirmation names them. Import YAML and Export YAML are here too.
- **Add from workspace.** Searches the real jobs in the region and fills the form with the job's name, job ID and schedule type. The job picker lists up to 100 jobs whose name contains your text. While you type a name pattern in the form, it lists the real jobs the pattern matches (up to 50) and says when a pattern matches nothing. When a job has job IDs, the scan finds it by ID, so the preview says so.
- **Dependency map.** Jobs and services as boxes and dependencies as arrows, colored by current status. To add a link, click Add link, pick two boxes and choose the type: `job`, `child_job` or `service`. Click a link to remove it. Add a service for a dependency that is not a job. [data-model.md](data-model.md#job_dependencies) explains the three types.
- **Change log.** Every saved version, with who saved it, when, and a one-line summary. Open a version to see what it changed. The newest 50 load first; Load older versions shows more.
- **Defaults and workspace labels.** The settings every job gets unless it sets its own, and the environment label of each workspace. These are the `defaults` and `workspaces` sections of the YAML file.

### Copilot

The copilot answers questions about the Watchdog's findings, the monitored jobs and their dependencies. See [The copilot](#the-copilot).

## Who each call runs as

The app has two identities. The person signed in is the user. The app itself runs as its own service principal, an identity Databricks creates for each app. The app asks for two user scopes, `sql` and `dashboards.genie`. This is Databricks' user authorization for apps, and a workspace admin must allow those scopes.

| Who | What it does | What it needs |
|---|---|---|
| The person signed in | Every Monitoring query, the job picker and pattern preview, the config banner, the copilot's questions, and the list of that person's own copilot chats | `CAN USE` on the SQL warehouse; `SELECT` on the Watchdog schema; `SELECT` on `system.lakeflow.jobs` and `system.access.workspaces_latest`; `CAN RUN` on the copilot's Genie agent. [Who can use the app](multi-region.md#who-can-use-the-app) lists the grants. |
| The app's service principal | Reads and writes the job list in Lakebase; reads the scan job's settings and its runs; starts `watchdog_scan` when someone clicks Scan now | The grants the bundle gives through the app's resources: Lakebase `CAN_CONNECT_AND_CREATE`, the scan job `CAN_MANAGE_RUN`, the warehouse `CAN_USE`, the Genie agent `CAN_RUN`. Nothing to do by hand. |
| The scan job's identity (`watchdog_scan`) | When `scan.config_source` is `lakebase`, notebook 02 reads the newest saved version of the job list, with a short-lived database credential minted for it | Access to the app's Lakebase schema. The identity that deployed the bundle created the Lakebase project, so it has this. The job runs as that identity, in every target. |

Things that follow from this table:

- Because queries run as the person, two people can see different rows if their Unity Catalog grants differ. A person who cannot read a table gets a message that names it.
- A scan started with Scan now still runs as the scan job's own identity, not as the app.
- Saving the job list needs no grant for the person: the app's service principal writes it.
- The copilot reads the job list as of the last scan load (the config tables), not your unsaved or unscanned edits.
- There is no fallback for a workspace without user authorization. The app declares the scopes, and a workspace that does not allow them cannot deploy or start it. Running the queries as the service principal would show every user what the service principal can read, which defeats Unity Catalog's per-person access.

## What the app stores

The app keeps one Postgres schema, `watchdog_app`, in the Lakebase project (`jobs-watchdog` by default), branch `production`, database `watchdog`. The app's service principal creates and owns it when the app first starts. It has one table:

```sql
CREATE TABLE watchdog_app.job_list_versions (
  version        BIGINT PRIMARY KEY,           -- 1, 2, 3 ...
  document       JSONB NOT NULL,               -- the whole job list, in the shape of the YAML file
  saved_by       TEXT NOT NULL,                -- the signed-in person's email
  saved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_kind    TEXT NOT NULL CHECK (change_kind IN ('import','create','update','delete','restore')),
  change_target  TEXT,                         -- job:<name>, dependency:<a>-><b>:<type>, workspace:<key>, or defaults
  summary        TEXT NOT NULL                 -- for example: Changed max_gap_minutes on orders_ingest from 60 to 90
);
```

The shape of `document` is described in [data-model.md](data-model.md#the-job-list-document). AppKit, the framework the app is built on, also keeps its query cache in a schema called `appkit` in the same database. It holds only cached query results.

The copilot's conversations are not stored in Lakebase. Genie keeps each person's conversations. The app stores nothing else.

## How job-list versions work

The job list is never edited in place. Every save adds a new row to `job_list_versions`, so the whole history is there.

- **Saving a change.** Each save is one change to one thing: a job, a dependency link, a workspace label or the defaults. It carries the version the form was opened at. The server checks the whole list against the same rules the scan's loader uses, and writes version N+1 with the email of the person who saved it and a one-line summary.
- **Conflicts.** If someone else changed the same job (or the same link, label or defaults) after you opened it, the save is refused with "Someone else changed this since you opened it. Reload to see their change." Reload, look at their change, and apply yours again. Edits to different jobs never conflict. The check runs inside one database transaction under a lock, so two saves at the same moment cannot both win.
- **Broken rules.** A change that breaks a rule is refused with a message per field, for example a scheduled job with no `max_gap_minutes`. Nothing is saved.
- **The change log.** The Change log page lists every version. A version can be opened to see what it changed against the version before it.
- **Import.** Import YAML reads a monitored-jobs file with the Python loader's rules, shows the differences against the saved list, and saves one `import` version only after you confirm. A file that breaks a rule is not imported, and the message names the job, the field and the problem. Read the line about name patterns in [data-model.md](data-model.md#monitored_jobs): a pattern that Python accepts and Java does not is refused.
- **Export.** Export YAML downloads the newest version as a YAML file, with a first line that names the version, the time and who saved it. The Python loader reads it as is, so you can keep the file in Git, or switch back to `scan.config_source: yaml`.
- **Restore.** The server can save an old version's document as a new `restore` version (`POST /api/job-list/restore`). The app has no button for it yet. To go back to an old version today, open it in the Change log, or export the newest and import the older text.
- **Who saved it.** `saved_by` is the email that Databricks Apps adds to the request. It is a record of who made the change, not a permission check (see [Known gaps](#known-gaps)).

The rules that check a list are written twice, in Python (`jobs_watchdog/config.py`) for the scan and in TypeScript (`app/shared/joblist/`) for the app. A shared set of test files (`tests/fixtures/job-lists`) runs through both, and both must agree on every file.

## The config banner

A banner on the Job list and the Dependency map tells you which job list the scan uses. It reads the newest row of `config_loads`, the table where notebook 02 records every load.

| The banner says | Why |
|---|---|
| The scan could not load the job list, with the time and the error | The newest load failed. The scan keeps using the last list that loaded. |
| The scan still reads the YAML file | `scan.config_source` is `yaml`. Set it to `lakebase` and deploy again. |
| Saved as version N. The scan is on version M. | You saved a version the scan has not loaded yet. It applies at the next scan, or click Scan now. |
| Nothing | The scan is on the newest version, or no load has been recorded yet. |

## The copilot

The copilot is a Genie agent that the bundle creates over the six Watchdog tables and the `findings_latest` view. People ask it questions in plain language, such as "What is failing right now?", "Which jobs missed their schedule?" or "What breaks if orders_ingest fails?". The Copilot page offers four starting questions.

What it does:

- It writes a SQL query, runs it as the person asking, and answers in plain language: what failed, when, the likely cause, what it affects and the next step, with the run link when there is one.
- Each answer can show the SQL it ran, who it ran as, and a small table of the rows. Each answer is marked "AI-generated. Check before acting."
- Genie keeps each person's conversations. The navigation bar lists the person's recent chats (the latest 20). Opening one shows the answers and the SQL again.
- The Ask the copilot button in a job's detail panel opens a chat that already names the job.

What it cannot do:

- It only reads. It cannot change a job, rerun one, edit the job list or send anything. If you ask, it says so.
- It sees the job list as of the last scan load, from the config tables. It does not see edits saved in the app since then.
- It answers from the Watchdog tables only. It does not read other tables.
- Like any AI answer it can be wrong. Open the SQL and check it before you act.

The agent's instructions, sample questions and example queries are in [`resources/watchdog_copilot.genie.yml`](../resources/watchdog_copilot.genie.yml). The sample questions are also the Copilot page's suggested questions, so change both together. The agent needs a Pro or Serverless SQL warehouse.

## Known gaps

These are not built. Each is a choice for this release, not a hidden fault.

- **The scans run as the deploying identity.** The job runs as the identity that deployed the bundle, and that identity reads the job list from Lakebase. A scan job that runs as a different service principal needs a Postgres role and a grant for that principal first. That setup is not provided, so keep the deploying identity as the scan identity.
- **Lakebase access is per app, not per person.** The app's service principal reads and writes the job list. Anyone who can open the app can edit it. The app records who saved each version, but it does not limit who can save. Limit who can open the app with `app.users_group`.
- **User authorization is required.** There is no mode that runs the queries as the app's service principal.
- **One install per workspace.** The app name and the Lakebase project ID must be unique in a workspace, and the dev and demo targets do not add a prefix to them.
- **Restore has no button.** The server has the call; the app does not.
- **No per-person chat storage in the app.** Conversations live in Genie. If you delete the Genie agent (a plain teardown does), everyone's conversations go with it.
- **Query errors are blunt.** The app framework hides the text of a failed query. A missing grant and a missing table can look alike, so the app shows one combined message that names the table to check. The job picker reports any failed search as missing access to `system.lakeflow.jobs`. The pattern preview runs a second, table-free check to tell a bad pattern from missing access.
- **Scan now can queue a second run.** Two clicks whose reads both land before either run starts can queue a second run. The scan job allows one run at a time, so they never run together.
- **The page is sized for about 200 monitored jobs.** A query result sent to the page is capped at 16 MiB, which holds the history strip for about 2,000 jobs. A Watchdog with more would need the cap raised in `app/server/server.ts`, and the page has not been tested at that size.
- **The copilot has one agent.** You cannot pick another model, and it has no actions. Alerts, approvals, a roll-up across regions and a scan that reads Lakebase as a different identity are on the [roadmap](roadmap.md#backlog).
- **A teardown and a redeploy has not been run end to end.** The steps are in [Deploy again after a teardown](multi-region.md#deploy-again-after-a-teardown), with what was checked and what was not.
- **The app needs the internet at deploy time.** The platform runs `npm install` and builds the app when you deploy. A workspace that cannot reach an npm registry needs a package mirror.
