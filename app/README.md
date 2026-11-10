# Watchdog app

A Databricks App, built with [AppKit](https://developers.databricks.com/docs/appkit/v0/), for the Watchdog. It shows what the scans found, keeps the job list in Lakebase with a version history, and answers questions about the jobs through a Genie space. The repository's bundle deploys it (see `../DEPLOY.md`).

## What is where

- `server/`: the Express server. `server.ts` starts the AppKit plugins (server, analytics, lakebase, jobs, genie) and creates the Postgres schema `watchdog_app` on start.
- `client/`: the React front end (appkit-ui, Tailwind CSS 4, React Router 7). `routes.tsx` lists the pages; `layout/` holds the nav.
- `shared/joblist/`: the job list types and the dependency impact, used by the server and the client.
- `config/queries/`: the SQL the analytics plugin runs. A `.obo.sql` file runs as the signed-in person.
- `app.yaml`: the start command, and the app resources each environment variable comes from.

## The dependency map

The map page shows the monitored jobs and the services they need as cards, and each link as an arrow. A link or settings change saves a new version of the job list, as on the Job list page. Moving cards only saves the layout.

- **Move.** Drag a card, or select it and press the arrow keys. Shift moves it farther. Its spot is saved for everyone, in `watchdog_app.map_layout`, and each direction keeps its own layout.
- **Link.** Drag from a card's dot to another card, choose Job or Child job, and save the link. Add link does the same from the keyboard. Add service adds a service for a job that needs it.
- **Edit.** Select a job's card to change its common settings in the side panel. Edit job opens the full job editor.
- **Add.** Add job opens the workspace picker, then the job editor. Once the job saves, its card is selected.
- **Remove.** Click a line, then its ×, or press Delete, to remove a link. Remove from Watchdog in the side panel removes a job after a confirm.
- **Tidy up.** Puts back the automatic layout of the direction on screen, for everyone.
- **Undo.** Takes back your own moves, Tidy ups and link changes on the map, newest first, up to 20. Ctrl+Z or Cmd+Z does the same, except in a text field, in the side panel, while a dialog is open, and outside the map page. Undoing a link change saves a new version. Undo starts empty each time the page opens. Settings saves are not on the Undo stack.

## The copilot

The copilot page asks the Genie space in plain language. Each answer is one card.

- **Charts, numbers and tables.** Each query in an answer opens as a chart, a single number or a table. A chart never defaults to a pie. A person can switch the chart type, and pie and donut stay in the menu when the rows are parts of a whole. A list of categories where every row has the same number opens as a table, and so does an answer whose x values repeat, such as two jobs on each day. A steady daily series stays a chart.
- **Table and CSV.** A chart can switch to a table of its rows, and a single-number answer shows the number, with no table. Every answer with rows has a button that downloads them as a CSV file. When Genie returned only part of a result, a line under the table says so. Show SQL opens the query Genie ran, and who it ran as.
- **Feedback.** Each finished answer has Good answer and Bad answer buttons. A click goes to Genie through `POST /api/copilot/feedback`, as the signed-in person. Clicking the pressed button again clears the rating. A reopened chat starts unrated, because AppKit 0.84.0 does not pass on the rating Genie holds.

## Run it locally

You need Node.js 22 or later, npm, and the Databricks CLI signed in to the workspace.

```bash
cp .env.example .env    # then fill in the values
npm ci
npm run dev             # http://localhost:8000
```

Set `PGHOST` and `LAKEBASE_ENDPOINT` to a development branch of the Lakebase project, never to the production branch. The server does not start without `LAKEBASE_ENDPOINT`. Set `WATCHDOG_CATALOG`, `WATCHDOG_SCHEMA` and `WATCHDOG_REGION` to read an existing Watchdog schema; otherwise the app reads them from the `watchdog_scan` job's parameters.

## Checks

```bash
npm run typecheck
npm test                # vitest: server, shared and client tests
npm run lint:ast-grep   # AppKit's lint rules
npm run build
```

`npm run build` runs type generation first. The query files use sample values (`main`, `watchdog`), so in a workspace without that schema the query rows are typed `unknown`, and the hooks parse them with zod.
