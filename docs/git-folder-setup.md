# Set up the repo in a Databricks Git folder

A Git folder is a folder in your Databricks workspace that holds a clone of a Git repository. You clone this repo once, run the notebooks from it, and pull to get updates. You never push to it.

## Clone

1. In the workspace, open **Workspace** and go to your home folder, or a shared folder your team uses.
2. Choose **Create**, then **Git folder**.
3. Enter the repository URL `https://github.com/ankity09/databricks-jobs-watchdog`. The Git provider (GitHub) and the folder name fill in from the URL.
4. Choose **Create Git folder**.

The repo is public, so cloning and pulling need no Git credentials. If your workspace limits which Git URLs can be cloned, a workspace admin adds this one to the allow list.

## Keep your settings outside the tracked files

A pull replaces the tracked files: the notebooks, the SQL files and the example config. Keep your own values somewhere a pull never touches.

- **Settings.** At the root of the Git folder, create `accelerator.local.yaml` as a copy of `accelerator.yaml`, and fill in `target.catalog`, `target.region` and anything else you want to change. The file is git-ignored: it is never committed and never conflicts with a pull. The notebooks read their widget defaults from it. You can also type values into the widgets instead.
- **Your monitored jobs.** Copy `config/monitored_jobs.example.yml` outside the Git folder, for example:
  - your home folder: `/Workspace/Users/<you>/watchdog/monitored_jobs.yml`
  - a Unity Catalog volume: `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`

  Then set `scan.monitored_jobs_path` in `accelerator.local.yaml`, or the `monitored_jobs_path` widget in notebook 02, to that path. A volume suits a team, because access follows Unity Catalog grants.
- **Do not edit tracked files** in the Git folder. A change there makes a later pull conflict. If you want to change a notebook or a query, copy it to your home folder first.

## Run the notebooks

1. Open `notebooks/00_check_access` in the Git folder.
2. Attach it to **Serverless** compute.
3. Run the first two code cells. The input boxes (widgets) appear at the top of the notebook; check them, then run all cells.
4. Continue with `01_create_tables` through `07_validate_phase_1`, in order.

The notebooks find the repo root by looking upward from their own folder, so open them where they are. A notebook copied elsewhere cannot import `jobs_watchdog`.

## Pull updates

1. Open the Git folder and select the branch name (`main`) to open the Git dialog.
2. Choose **Pull**.
3. **Restart Python** in any notebook that is open: run `dbutils.library.restartPython()` in a cell, or detach and reattach the notebook. Python keeps `jobs_watchdog` loaded until it restarts, so without this the notebook keeps running the old code.
4. Read what changed in the repo's commit history on GitHub before you run a scan.

## Troubleshooting

| You see | Cause and fix |
|---|---|
| `Cannot find the repo root above ...` | The notebook is not inside the Git folder's `notebooks` folder. Open it from the Git folder. |
| `ModuleNotFoundError: No module named 'jobs_watchdog'` | Same cause, or Python started before the folder was complete. Open the notebook from the Git folder and restart Python. |
| Old behavior after a pull | Restart Python (step 3 above). |
| The pull reports a conflict | A tracked file was edited in the Git folder. Copy your edits somewhere safe, discard the local changes in the Git dialog, and pull again. |
