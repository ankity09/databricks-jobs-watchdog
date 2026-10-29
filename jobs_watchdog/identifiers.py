"""Validate catalog and schema names before they reach any SQL statement."""

import re

_IDENTIFIER = re.compile(r"[A-Za-z0-9_]+")


def validate_identifier(value, field):
    """Return value if it is a plain identifier, otherwise raise ValueError.

    Only ASCII letters, digits and underscores are allowed. That keeps names
    safe to pass to IDENTIFIER() and avoids quoting surprises.
    """
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"{field} must be letters, digits or underscores: {value!r}")
    return value
