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
            owner = self.db.cache_owner if params[0] == "appkit" else self.db.owner
            self.rows = [(owner,)] if owner else []
        elif "FROM pg_roles" in sql:
            self.rows = [(1,)] if params[0] in self.db.roles else []
        elif "FROM pg_class" in sql:
            self.rows = [(name,) for name in self.db.tables]
        elif "has_schema_privilege" in sql:
            self.rows = [(self.db.has_access,) * 4]
        elif "pg_has_role" in sql:
            self.rows = [(ME, params[0] in self.db.mine)]
        else:
            self.rows = []

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeDb:
    def __init__(self, owner=ME, roles=(SP, ME), tables=("job_list_versions",), has_access=False, mine=(ME,), cache_owner=None):
        self.owner, self.roles, self.tables, self.has_access, self.mine = owner, set(roles), list(tables), has_access, set(mine)
        self.cache_owner = cache_owner  # who owns AppKit's cache schema appkit, None when it does not exist
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

    def drops(self):
        return [sql for sql, _ in self.statements if sql.startswith("DROP")]


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


# AppKit's cache schema appkit: grants cannot give the app what AppKit's start runs on it (CREATE INDEX IF NOT
# EXISTS needs the table's owner), and the deploying identity cannot hand it over, so the handover drops it.


def test_after_a_teardown_appkit_s_cache_schema_is_dropped_so_the_app_creates_it_again():
    db = FakeDb(cache_owner=ME)
    result = grant_app_access(db, SP)
    assert db.drops() == ['DROP SCHEMA "appkit" CASCADE'] and db.committed
    assert result.changed and "appkit" in result.message and "next start" in result.message


def test_the_cache_schema_is_dropped_also_when_the_job_list_needs_nothing():
    for db in (FakeDb(owner=SP, cache_owner=ME), FakeDb(has_access=True, cache_owner=ME)):
        result = grant_app_access(db, SP)
        assert db.drops() == ['DROP SCHEMA "appkit" CASCADE'] and result.changed


def test_a_cache_schema_the_app_owns_or_that_does_not_exist_is_left_alone():
    for db in (FakeDb(cache_owner=SP), FakeDb(cache_owner=None), FakeDb(owner=SP, cache_owner=SP)):
        grant_app_access(db, SP)
        assert db.drops() == []
    assert not grant_app_access(FakeDb(owner=SP, cache_owner=SP), SP).changed


def test_one_message_says_what_happened_to_the_job_list_and_to_the_cache():
    result = grant_app_access(FakeDb(cache_owner=ME), SP)
    assert result.message.count("..") == 0 and result.message.startswith(f"granted {SP} USAGE and CREATE")


def test_a_cache_schema_an_old_app_role_still_owns_gets_the_delete_role_hint():
    old = "00000000-0000-4000-8000-000000000002"
    result = grant_app_access(FakeDb(cache_owner=old), SP)
    assert f"dbrx-apps-{old}" in result.message and "--reassign-owned-to" in result.message


def test_a_cache_schema_this_identity_cannot_drop_is_named_and_does_not_stop_the_grants():
    other = "someone-else@example.com"
    db = FakeDb(cache_owner=other)
    result = grant_app_access(db, SP)
    assert db.drops() == [] and len(db.grants()) == 2 and db.committed
    assert other in result.message and "DROP SCHEMA appkit CASCADE" in result.message and "in memory" in result.message


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
