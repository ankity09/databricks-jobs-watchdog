"""Give a re-deployed Watchdog app access to the job list it kept in Lakebase.

The app's service principal creates the schema watchdog_app on its first start,
so it owns it. A plain teardown deletes the app, and the app's service principal
with it, but keeps the Lakebase project and the job list: Lakebase hands the
schema and its table to the identity that deleted the app. The next deploy
creates a new app with a new service principal, which may connect and create a
schema but cannot use that one, so the app's job list answers "no access".

grant_app_access gives the new service principal what the app needs there:
USAGE and CREATE on the schema (the app's startup check needs CREATE even when
the table exists) and SELECT and INSERT on its tables. Notebook 11 runs it as
the deploying identity (the watchdog_app_access job, which
scripts/deploy_regions.py runs after each region's deploy). When the app owns
the schema, or has those rights already, it changes nothing.

The caller passes in an open database connection (psycopg's), so the tests
run without one.
"""

import re
from dataclasses import dataclass

APP_SCHEMA = "watchdog_app"
_APP_ROLE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class AppAccessError(Exception):
    """Raised when the app's service principal cannot be given access to the job list."""


@dataclass(frozen=True)
class AccessResult:
    changed: bool
    message: str


def quote_ident(name):
    """A Postgres identifier in double quotes, with any quote inside doubled."""
    return '"' + str(name).replace('"', '""') + '"'


def app_service_principal(api, app_name):
    """The app's service principal client ID, which is also its Postgres role name."""
    app = api.do("GET", f"/api/2.0/apps/{app_name}") or {}
    client_id = app.get("service_principal_client_id")
    if not client_id:
        raise AppAccessError(f"the app {app_name} has no service principal yet: deploy it first (bundle deploy)")
    return client_id


def grant_app_access(connection, role, schema=APP_SCHEMA):
    """Give the role (the app's service principal) the rights the app needs on its schema. Returns what it did.

    It commits its work, or rolls it back on an error, so it never leaves a transaction open.
    """
    try:
        result = _grant(connection, role, schema)
    except BaseException:
        connection.rollback()
        raise
    connection.commit()
    return result


def _grant(connection, role, schema):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = %s", (schema,))
        row = cursor.fetchone()
        if row is None:
            return AccessResult(False, f"{schema} does not exist yet: the app creates it at its first start, and "
                                       "owns it, so there is nothing to grant")
        owner = row[0]
        if owner == role:
            return AccessResult(False, f"the app's service principal owns {schema}: there is nothing to grant")
        cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,))
        if cursor.fetchone() is None:
            raise AppAccessError(f"the app's service principal {role} has no Postgres role in this branch yet: "
                                 "deploy the app (bundle deploy), then run this again")
        cursor.execute("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                       "WHERE n.nspname = %s AND c.relkind IN ('r', 'p') ORDER BY c.relname", (schema,))
        tables = [name for (name,) in cursor.fetchall()]
        checks = ["has_schema_privilege(%s, %s, 'USAGE')", "has_schema_privilege(%s, %s, 'CREATE')"]
        params = [role, schema, role, schema]
        for table in tables:
            checks += ["has_table_privilege(%s, %s, 'SELECT')", "has_table_privilege(%s, %s, 'INSERT')"]
            params += [role, f"{quote_ident(schema)}.{quote_ident(table)}"] * 2
        cursor.execute(f"SELECT {', '.join(checks)}", tuple(params))
        if all(cursor.fetchone()):
            return AccessResult(False, f"the app's service principal already has access to {schema}")
        cursor.execute("SELECT current_user, pg_has_role(current_user, %s, 'USAGE')", (owner,))
        me, can_grant = cursor.fetchone()
        if not can_grant:
            hint = (f" If {owner} is the old app's service principal, delete its role and give its objects to you, "
                    f"for example databricks postgres delete-role <branch>/roles/dbrx-apps-{owner} "
                    f"--reassign-owned-to \"{me}\", then run this again" if _APP_ROLE.match(owner) else "")
            raise AppAccessError(f"{schema} belongs to {owner}, and {me} cannot grant on it: run this as {owner}, "
                                 f"the identity that ran the teardown.{hint}")
        cursor.execute(f"GRANT USAGE, CREATE ON SCHEMA {quote_ident(schema)} TO {quote_ident(role)}")
        cursor.execute(f"GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA {quote_ident(schema)} TO {quote_ident(role)}")
    listed = ", ".join(tables) or "no tables yet"
    return AccessResult(True, f"granted {role} USAGE and CREATE on {schema}, and SELECT and INSERT on its tables "
                              f"({listed}). Retry the job list in the app.")
