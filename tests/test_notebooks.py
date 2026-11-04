import ast
import os
from pathlib import Path

import pytest

from jobs_watchdog.sqlfiles import repo_root

NOTEBOOKS = repo_root() / "notebooks"
EXPLORE = NOTEBOOKS / "explore"
TOP_LEVEL = sorted(path for path in NOTEBOOKS.glob("[0-9][0-9]_*.py"))
EXPLORE_NOTEBOOKS = sorted(EXPLORE.glob("[0-9][0-9]_*.py"))


def find_repo_root_from_setup():
    """The _find_repo_root function from notebooks/_setup.py, without running the rest of it."""
    tree = ast.parse((NOTEBOOKS / "_setup.py").read_text())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_find_repo_root")
    namespace = {"os": os, "Path": Path}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "_setup.py", "exec"), namespace)
    return namespace["_find_repo_root"]


@pytest.mark.parametrize("folder", ["notebooks", "notebooks/explore"])
def test_setup_finds_the_repo_root_from_each_notebook_folder(monkeypatch, folder):
    monkeypatch.chdir(repo_root() / folder)
    assert find_repo_root_from_setup()() == repo_root()


def test_setup_explains_where_to_open_the_notebooks_when_there_is_no_repo(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(RuntimeError, match="repo root"):
        find_repo_root_from_setup()()


def test_the_explore_notebooks_live_in_their_own_folder():
    assert [path.name for path in EXPLORE_NOTEBOOKS] == ["03_explore_system_tables.py", "04_explore_jobs_api.py"]
    assert not any(path.name.startswith(("03_", "04_")) for path in TOP_LEVEL)


@pytest.mark.parametrize("path", TOP_LEVEL, ids=lambda path: path.name)
def test_top_level_notebooks_run_the_shared_setup_next_to_them(path):
    assert "# MAGIC %run ./_setup" in path.read_text()


@pytest.mark.parametrize("path", EXPLORE_NOTEBOOKS, ids=lambda path: path.name)
def test_explore_notebooks_run_the_shared_setup_one_folder_up(path):
    text = path.read_text()
    assert "# MAGIC %run ../_setup" in text and "%run ./_setup" not in text
    assert "run by hand" in text


@pytest.mark.parametrize("path", TOP_LEVEL + EXPLORE_NOTEBOOKS, ids=lambda path: path.name)
def test_notebooks_compile_and_explain_themselves(path):
    text = path.read_text()
    compile(text, str(path), "exec")
    assert text.startswith("# Databricks notebook source")
    for heading in ("What it does", "Inputs (widgets)", "What to look for"):
        assert heading in text, heading


def test_cleanup_notebook_runs_the_delete_file_after_checking_the_tables():
    text = (NOTEBOOKS / "10_delete_old_findings.py").read_text()
    assert 'NAMES = ("catalog", "schema", "retention_days")' in text
    assert text.index("require_current_tables(spark") < text.index("run_sql(spark, \"sql/maintenance/50_delete_old_findings.sql\"")
    assert "if s.retention_days == 0:" in text
    assert "Oldest observed_at left" in text
