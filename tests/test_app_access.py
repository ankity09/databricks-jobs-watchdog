import pytest

from jobs_watchdog.app_access import AppAccessError, app_service_principal, grant_app_access

SP = "00000000-0000-4000-8000-000000000001"
ME = "someone@example.com"


class FakeCursor:
    """Answers the catalog queries grant_app_access sends, and records every statement."""

    def __init__(self, db):
        self.db = db
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self.db.statements.append((" ".join(sql.split()), params))
        if "FROM pg_namespace" in sql:
            self.rows = [(self.db.owner,)] if self.db.owner else []
        elif "FROM pg_roles" in sql:
            self.rows = [(1,)] if params[0] in self.db.roles else []
        elif "FROM pg_class" in sql:
            self.rows = [(name,) for name in self.db.tables]
        elif "has_schema_privilege" in sql:
            self.rows = [(self.db.has_access,) * 4]
        elif "pg_has_role" in sql:
            self.rows = [(ME, self.db.owner in self.db.mine)]
        else:
            self.rows = []

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeDb:
    def __init__(self, owner=ME, roles=(SP, ME), tables=("job_list_versions",), has_access=False, mine=(ME,)):
        self.owner, self.roles, self.tables, self.has_access, self.mine = owner, set(roles), list(tables), has_access, set(mine)
        self.statements = []
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def grants(self):
        return [sql for sql, _ in self.statements if sql.startswith("GRANT")]


def test_after_a_teardown_the_new_service_principal_gets_the_rights_the_app_needs():
    db = FakeDb()
    result = grant_app_access(db, SP)
    assert result.changed
    assert db.grants() == [
        f'GRANT USAGE, CREATE ON SCHEMA "watchdog_app" TO "{SP}"',
        f'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA "watchdog_app" TO "{SP}"',
    ]
    assert db.committed
    assert "job_list_versions" in result.message


def test_nothing_changes_when_the_app_owns_the_schema():
    db = FakeDb(owner=SP)
    result = grant_app_access(db, SP)
    assert not result.changed and db.grants() == [] and "owns" in result.message


def test_nothing_changes_before_the_app_has_created_the_schema():
    db = FakeDb(owner=None)
    result = grant_app_access(db, SP)
    assert not result.changed and db.grants() == [] and "first start" in result.message


def test_nothing_changes_when_the_service_principal_already_has_the_rights():
    db = FakeDb(has_access=True)
    result = grant_app_access(db, SP)
    assert not result.changed and db.grants() == [] and "already" in result.message


def test_a_service_principal_with_no_role_yet_says_to_deploy_the_app_first():
    db = FakeDb(roles=(ME,))
    with pytest.raises(AppAccessError, match="no Postgres role"):
        grant_app_access(db, SP)
    assert db.rolled_back and not db.committed


@pytest.mark.parametrize("db", [FakeDb(owner=SP), FakeDb(owner=None), FakeDb(has_access=True)], ids=["owner", "no schema", "has rights"])
def test_a_run_that_changes_nothing_still_ends_its_transaction(db):
    grant_app_access(db, SP)
    assert db.committed


def test_an_owner_this_identity_cannot_act_for_is_named_with_what_to_do():
    old = "00000000-0000-4000-8000-000000000002"
    with pytest.raises(AppAccessError) as err:
        grant_app_access(FakeDb(owner=old, roles=(SP, ME, old)), SP)
    text = str(err.value)
    assert old in text and ME in text and f"dbrx-apps-{old}" in text and "reassign" in text


def test_role_names_are_quoted_so_they_cannot_break_out_of_the_statement():
    db = FakeDb(roles=('a"b', ME))
    grant_app_access(db, 'a"b')
    assert db.grants()[0].endswith('TO "a""b"')


class FakeApi:
    def __init__(self, app):
        self.app, self.calls = app, []

    def do(self, method, path, **_):
        self.calls.append((method, path))
        return self.app


def test_the_service_principal_comes_from_the_app():
    api = FakeApi({"name": "watchdog-app", "service_principal_client_id": SP})
    assert app_service_principal(api, "watchdog-app") == SP
    assert api.calls == [("GET", "/api/2.0/apps/watchdog-app")]


def test_an_app_without_a_service_principal_says_to_deploy_it():
    with pytest.raises(AppAccessError, match="deploy"):
        app_service_principal(FakeApi({"name": "watchdog-app"}), "watchdog-app")
