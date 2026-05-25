from __future__ import annotations

import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    container_id TEXT NOT NULL,
    name         TEXT NOT NULL,
    image        TEXT,
    ts           REAL NOT NULL,
    cpu_percent  REAL,
    mem_used     INTEGER,
    mem_limit    INTEGER,
    mem_percent  REAL,
    net_rx       INTEGER,
    net_tx       INTEGER,
    block_read   INTEGER,
    block_write  INTEGER,
    pids         INTEGER,
    PRIMARY KEY (container_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
CREATE INDEX IF NOT EXISTS idx_samples_container_ts ON samples(container_id, ts);
"""


class Storage:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            self.db_path,
            check_same_thread=False,
            isolation_level=None,  # autocommit
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._conn.executescript(SCHEMA)

    @contextmanager
    def _cursor(self) -> Iterator[sqlite3.Cursor]:
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
            finally:
                cur.close()

    def insert_samples(self, rows: Iterable[dict]) -> None:
        rows = list(rows)
        if not rows:
            return
        with self._cursor() as cur:
            cur.executemany(
                """INSERT OR REPLACE INTO samples
                   (container_id, name, image, ts, cpu_percent, mem_used, mem_limit,
                    mem_percent, net_rx, net_tx, block_read, block_write, pids)
                   VALUES (:container_id, :name, :image, :ts, :cpu_percent, :mem_used,
                           :mem_limit, :mem_percent, :net_rx, :net_tx, :block_read,
                           :block_write, :pids)""",
                rows,
            )

    def latest_per_container(self, fresh_within_seconds: float | None = None) -> list[dict]:
        """Latest sample per container_id.

        If `fresh_within_seconds` is set, only containers whose latest sample is
        within that many seconds of now are returned — this hides containers
        that disappeared (e.g. were rebuilt) without losing their history.
        """
        cutoff = (time.time() - fresh_within_seconds) if fresh_within_seconds else None
        with self._cursor() as cur:
            if cutoff is None:
                cur.execute(
                    """SELECT s.* FROM samples s
                       JOIN (SELECT container_id, MAX(ts) AS ts
                             FROM samples GROUP BY container_id) m
                       ON s.container_id = m.container_id AND s.ts = m.ts
                       ORDER BY s.name"""
                )
            else:
                cur.execute(
                    """SELECT s.* FROM samples s
                       JOIN (SELECT container_id, MAX(ts) AS ts
                             FROM samples GROUP BY container_id) m
                       ON s.container_id = m.container_id AND s.ts = m.ts
                       WHERE m.ts >= ?
                       ORDER BY s.name""",
                    (cutoff,),
                )
            return [dict(r) for r in cur.fetchall()]

    def latest_for(self, container_id: str) -> dict | None:
        """Latest sample for one container, no freshness filter — used by the
        detail view so you can still inspect a stopped container's history."""
        with self._cursor() as cur:
            cur.execute(
                "SELECT * FROM samples WHERE container_id = ? ORDER BY ts DESC LIMIT 1",
                (container_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None

    def history(self, container_id: str, since_ts: float) -> list[dict]:
        with self._cursor() as cur:
            cur.execute(
                """SELECT ts, cpu_percent, mem_used, mem_limit, mem_percent,
                          net_rx, net_tx, block_read, block_write, pids
                   FROM samples
                   WHERE container_id = ? AND ts >= ?
                   ORDER BY ts""",
                (container_id, since_ts),
            )
            return [dict(r) for r in cur.fetchall()]

    def history_per_container(
        self,
        container_ids: list[str],
        since_ts: float,
        bucket_seconds: int,
    ) -> dict[str, list[dict]]:
        """Bucketed history for many containers in one query.

        Samples within the same `bucket_seconds`-wide window are aggregated:
        gauges (CPU%, mem) are averaged, cumulative counters (net/blk) take
        the max in the bucket so they keep monotonic semantics.
        """
        if not container_ids:
            return {}
        bucket = max(1, int(bucket_seconds))
        placeholders = ",".join("?" * len(container_ids))
        # `bucket` is a sanitized int — safe to inline; the container IDs are bound.
        sql = f"""
            SELECT container_id,
                   MAX(ts)             AS ts,
                   AVG(cpu_percent)    AS cpu_percent,
                   AVG(mem_used)       AS mem_used,
                   AVG(mem_limit)      AS mem_limit,
                   AVG(mem_percent)    AS mem_percent,
                   MAX(net_rx)         AS net_rx,
                   MAX(net_tx)         AS net_tx,
                   MAX(block_read)     AS block_read,
                   MAX(block_write)    AS block_write,
                   AVG(pids)           AS pids
            FROM samples
            WHERE container_id IN ({placeholders}) AND ts >= ?
            GROUP BY container_id, CAST(ts / {bucket} AS INTEGER)
            ORDER BY container_id, ts
        """
        out: dict[str, list[dict]] = {cid: [] for cid in container_ids}
        with self._cursor() as cur:
            cur.execute(sql, (*container_ids, since_ts))
            for row in cur.fetchall():
                r = dict(row)
                cid = r.pop("container_id")
                out.setdefault(cid, []).append(r)
        return out

    def prune(self, retention_days: int) -> int:
        cutoff = time.time() - retention_days * 86400
        with self._cursor() as cur:
            cur.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            return cur.rowcount

    def close(self) -> None:
        with self._lock:
            self._conn.close()
