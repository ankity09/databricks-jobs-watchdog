import pytest

from jobs_watchdog.identifiers import validate_identifier


@pytest.mark.parametrize("value", ["main", "watchdog", "watchdog_2", "A1_b2"])
def test_accepts_plain_names(value):
    assert validate_identifier(value, "catalog") == value


@pytest.mark.parametrize(
    "value",
    ["", "my-catalog", "a b", "x;drop", "`x`", "cat.schema", "naïve", None, 3],
)
def test_rejects_anything_else(value):
    with pytest.raises(ValueError) as err:
        validate_identifier(value, "catalog")
    assert "catalog" in str(err.value)
