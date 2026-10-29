"""Shared test helpers."""

import re


def for_parsing(text):
    """Swap IDENTIFIER clauses and parameter markers for literals sqlglot can parse."""
    text = re.sub(r"IDENTIFIER\(\s*:catalog\s*\|\|\s*'\.'\s*\|\|\s*:schema\s*\|\|\s*'\.(\w+)'\s*\)", r"cat.sch.\1", text)
    text = re.sub(r"IDENTIFIER\(\s*:catalog\s*\|\|\s*'\.'\s*\|\|\s*:schema\s*\)", "cat.sch", text)
    for marker, value in ((":lookback_hours", "48"), (":scan_id", "'scan'"), (":region", "'region'"),
                          (":code_version_tag", "'code_version'")):
        text = text.replace(marker, value)
    return text
