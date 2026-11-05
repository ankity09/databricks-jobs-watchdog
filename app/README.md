# Watchdog app

A Databricks App, built with [AppKit](https://developers.databricks.com/docs/appkit/v0/), for the Watchdog. It shows what the scans found, keeps the job list in Lakebase with a version history, and answers questions about the jobs through a Genie space. The repository's bundle deploys it (see `../DEPLOY.md`).

## What is where

- `server/`: the Express server. `server.ts` starts the AppKit plugins (server, analytics, lakebase, jobs, genie) and creates the Postgres schema `watchdog_app` on start.
- `client/`: the React front end (appkit-ui, Tailwind CSS 4, React Router 7). `routes.tsx` lists the pages; `layout/` holds the nav.
- `shared/joblist/`: the job list types and the dependency impact, used by the server and the client.
- `config/queries/`: the SQL the analytics plugin runs. A `.obo.sql` file runs as the signed-in person.
- `app.yaml`: the start command, and the app resources each environment variable comes from.

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
