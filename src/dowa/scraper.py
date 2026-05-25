from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import docker
from docker.errors import DockerException, NotFound

from .storage import Storage

log = logging.getLogger(__name__)


def _compute_cpu_percent(stats: dict) -> float | None:
    """Replicate `docker stats` CPU% formula from raw stats payload."""
    try:
        cpu = stats["cpu_stats"]
        pre = stats["precpu_stats"]
        cpu_delta = cpu["cpu_usage"]["total_usage"] - pre["cpu_usage"].get("total_usage", 0)
        system_delta = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
        online = cpu.get("online_cpus") or len(cpu["cpu_usage"].get("percpu_usage") or []) or 1
    except (KeyError, TypeError):
        return None
    if system_delta <= 0 or cpu_delta < 0:
        return None
    return (cpu_delta / system_delta) * online * 100.0


def _sum_network(stats: dict) -> tuple[int, int]:
    networks = stats.get("networks") or {}
    rx = sum(int(n.get("rx_bytes", 0)) for n in networks.values())
    tx = sum(int(n.get("tx_bytes", 0)) for n in networks.values())
    return rx, tx


def _sum_blkio(stats: dict) -> tuple[int, int]:
    entries = (stats.get("blkio_stats") or {}).get("io_service_bytes_recursive") or []
    read = sum(int(e.get("value", 0)) for e in entries if (e.get("op") or "").lower() == "read")
    write = sum(int(e.get("value", 0)) for e in entries if (e.get("op") or "").lower() == "write")
    return read, write


def _mem(stats: dict) -> tuple[int, int, float | None]:
    m = stats.get("memory_stats") or {}
    usage = int(m.get("usage", 0))
    # Subtract cache like `docker stats` does, when available.
    cache = int((m.get("stats") or {}).get("cache", 0))
    used = max(usage - cache, 0)
    limit = int(m.get("limit", 0))
    pct = (used / limit * 100.0) if limit else None
    return used, limit, pct


def _sample_for(container, ts: float) -> dict | None:
    try:
        raw = container.stats(stream=False)
    except NotFound:
        return None
    except DockerException as exc:
        log.warning("stats failed for %s: %s", container.id[:12], exc)
        return None

    mem_used, mem_limit, mem_pct = _mem(raw)
    net_rx, net_tx = _sum_network(raw)
    blk_r, blk_w = _sum_blkio(raw)
    return {
        "container_id": container.id,
        "name": (container.name or container.id[:12]).lstrip("/"),
        "image": (container.image.tags[0] if container.image and container.image.tags else None),
        "ts": ts,
        "cpu_percent": _compute_cpu_percent(raw),
        "mem_used": mem_used,
        "mem_limit": mem_limit,
        "mem_percent": mem_pct,
        "net_rx": net_rx,
        "net_tx": net_tx,
        "block_read": blk_r,
        "block_write": blk_w,
        "pids": int((raw.get("pids_stats") or {}).get("current", 0)),
    }


class Scraper:
    def __init__(
        self,
        storage: Storage,
        interval_seconds: float,
        retention_days: int,
        workers: int,
        docker_base_url: str | None = None,
    ) -> None:
        self.storage = storage
        self.interval = interval_seconds
        self.retention_days = retention_days
        self.workers = workers
        self.client = (
            docker.DockerClient(base_url=docker_base_url) if docker_base_url else docker.from_env()
        )
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_prune = 0.0
        self._tick_count = 0
        self._known: dict[str, str] = {}  # container_id -> name (so we can name disappearances)

    def _log_docker_info(self) -> None:
        try:
            info = self.client.version()
            log.info(
                "docker daemon: api=%s engine=%s os=%s arch=%s",
                info.get("ApiVersion"),
                info.get("Version"),
                info.get("Os"),
                info.get("Arch"),
            )
        except DockerException as exc:
            log.warning("could not query docker version: %s", exc)

    def start(self) -> None:
        if self._thread:
            return
        self._log_docker_info()
        self._thread = threading.Thread(target=self._run, name="dowa-scraper", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        try:
            self.client.close()
        except Exception:
            pass

    def _run(self) -> None:
        log.info("scraper started: interval=%.1fs workers=%d", self.interval, self.workers)
        while not self._stop.is_set():
            start = time.monotonic()
            try:
                self._tick()
            except Exception:
                log.exception("scrape tick failed")
            # Periodic retention sweep (hourly).
            if time.time() - self._last_prune > 3600:
                try:
                    removed = self.storage.prune(self.retention_days)
                    if removed:
                        log.info("pruned %d old samples", removed)
                except Exception:
                    log.exception("prune failed")
                self._last_prune = time.time()
            elapsed = time.monotonic() - start
            self._stop.wait(max(0.0, self.interval - elapsed))

    def _tick(self) -> None:
        t_list = time.monotonic()
        try:
            containers = self.client.containers.list()
        except DockerException as exc:
            log.error("could not list containers: %s", exc)
            return
        list_ms = (time.monotonic() - t_list) * 1000
        self._tick_count += 1

        if not containers:
            if self._known:
                # All containers gone.
                for cid, name in self._known.items():
                    log.info("container disappeared: %s (%s)", name, cid[:12])
                self._known.clear()
            log.info("tick #%d: 0 containers (list in %.0f ms)", self._tick_count, list_ms)
            return

        ts = time.time()
        rows: list[dict] = []
        failures = 0
        t_stats = time.monotonic()
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            futures = [ex.submit(_sample_for, c, ts) for c in containers]
            for fut in as_completed(futures):
                row = fut.result()
                if row is None:
                    failures += 1
                else:
                    rows.append(row)
        stats_ms = (time.monotonic() - t_stats) * 1000

        t_write = time.monotonic()
        if rows:
            self.storage.insert_samples(rows)
        write_ms = (time.monotonic() - t_write) * 1000

        seen = {r["container_id"]: r["name"] for r in rows}
        for cid, name in seen.items():
            if cid not in self._known:
                log.info("container appeared: %s (%s)", name, cid[:12])
        for cid, name in list(self._known.items()):
            if cid not in seen:
                log.info("container disappeared: %s (%s)", name, cid[:12])
        self._known = seen

        log.info(
            "tick #%d: %d sampled%s (list %.0f ms, stats %.0f ms, write %.0f ms)",
            self._tick_count,
            len(rows),
            f", {failures} failed" if failures else "",
            list_ms,
            stats_ms,
            write_ms,
        )
