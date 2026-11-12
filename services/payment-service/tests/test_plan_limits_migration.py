"""plans.max_recording_seconds boot migration: additive and written once."""

import asyncio

from app.plan_seed import migrate_plan_limits


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class FakeConn:
    """Records every statement; answers the column lookup with `has_column`."""

    def __init__(self, has_column: bool):
        self.has_column = has_column
        self.statements: list[tuple[str, dict | None]] = []

    async def execute(self, statement, params=None):
        sql = str(statement)
        self.statements.append((sql, params))
        if "information_schema.columns" in sql:
            return _Result(1 if self.has_column else None)
        return _Result(None)


def test_existing_column_is_left_alone():
    conn = FakeConn(has_column=True)
    assert asyncio.run(migrate_plan_limits(conn)) is False
    assert len(conn.statements) == 1


def test_missing_column_is_added_and_record_gets_three_minutes():
    conn = FakeConn(has_column=False)
    assert asyncio.run(migrate_plan_limits(conn)) is True
    sqls = [s for s, _ in conn.statements]
    assert any("ADD COLUMN IF NOT EXISTS max_recording_seconds INTEGER" in s for s in sqls)
    assert not any("DROP" in s.upper() for s in sqls)
    updates = [p for s, p in conn.statements if s.startswith("UPDATE plans")]
    assert updates == [{"seconds": 180, "key": "record"}]
    # Only fills an empty value; never overwrites what the admin set.
    assert all("max_recording_seconds IS NULL" in s for s in sqls if s.startswith("UPDATE"))
