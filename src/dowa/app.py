from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import metrics as metrics_fmt
from .config import settings
from .scraper import Scraper
from .storage import Storage

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("dowa")

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage = Storage(settings.db_path)
    scraper = Scraper(
        storage=storage,
        interval_seconds=settings.interval_seconds,
        retention_days=settings.retention_days,
        workers=settings.scraper_workers,
        docker_base_url=settings.docker_base_url,
    )
    scraper.start()
    app.state.storage = storage
    app.state.scraper = scraper
    log.info("dowa started; db=%s interval=%.1fs", settings.db_path, settings.interval_seconds)
    try:
        yield
    finally:
        scraper.stop()
        storage.close()


app = FastAPI(title="dowa", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


MAX_MINUTES = 60 * 24 * 31  # 31 days, hard cap regardless of retention setting
TARGET_POINTS = 400  # ~points per series at the picked bucket size


def _pick_bucket(minutes: int) -> int:
    """Pick a sample bucket size (seconds) so that a window of `minutes` yields
    roughly TARGET_POINTS data points. Never finer than the scrape interval."""
    floor = max(1, int(round(settings.interval_seconds)))
    raw = max(floor, int((minutes * 60) // TARGET_POINTS))
    # Snap to a "nice" bucket size so axis labels look sane.
    for step in (5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400):
        if step >= raw:
            return max(step, floor)
    return raw


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "interval_ms": int(settings.interval_seconds * 1000),
            "history_minutes": settings.history_minutes_default,
            "retention_days": settings.retention_days,
        },
    )


@app.get("/healthz")
def health() -> dict:
    return {"ok": True}


@app.get("/api/containers")
def containers(
    minutes: int | None = None,
    bucket: int | None = None,
    include_historical: bool = False,
) -> dict:
    """Latest snapshot per container plus a bucketed history series.

    By default only live containers are returned (sample within ~3 scrape
    intervals). With `include_historical=true`, stopped containers whose last
    sample is within the selected `minutes` window are returned too, each
    flagged `stale: true` — useful for comparing reruns / rebuilds.
    """
    storage: Storage = app.state.storage
    minutes = minutes or settings.history_minutes_default
    if minutes <= 0 or minutes > MAX_MINUTES:
        raise HTTPException(status_code=400, detail=f"minutes out of range (1..{MAX_MINUTES})")
    bucket = bucket if (bucket and bucket > 0) else _pick_bucket(minutes)

    fresh = max(settings.interval_seconds * 3, 15.0)
    within = (minutes * 60) if include_historical else fresh
    latest = storage.latest_per_container(fresh_within_seconds=within)
    now = time.time()
    since = now - minutes * 60
    ids = [c["container_id"] for c in latest]
    history_map = storage.history_per_container(ids, since, bucket) if ids else {}

    out: list[dict] = []
    for c in latest:
        cid = c["container_id"]
        out.append({
            "container_id": cid,
            "name": c["name"],
            "image": c["image"],
            "stale": (now - c["ts"]) > fresh,
            "latest": {
                "ts": c["ts"],
                "cpu_percent": c["cpu_percent"],
                "mem_used": c["mem_used"],
                "mem_limit": c["mem_limit"],
                "mem_percent": c["mem_percent"],
                "net_rx": c["net_rx"],
                "net_tx": c["net_tx"],
                "block_read": c["block_read"],
                "block_write": c["block_write"],
                "pids": c["pids"],
            },
            "history": history_map.get(cid, []),
        })
    return {
        "containers": out,
        "now": now,
        "since": since,
        "minutes": minutes,
        "bucket": bucket,
        "include_historical": include_historical,
    }


@app.get("/container/{container_id}", response_class=HTMLResponse)
def container_detail_page(request: Request, container_id: str) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "detail.html",
        {
            "container_id": container_id,
            "interval_ms": int(settings.interval_seconds * 1000),
            "history_minutes": settings.history_minutes_default,
            "retention_days": settings.retention_days,
        },
    )


@app.get("/api/containers/{container_id}")
def container_detail(
    container_id: str,
    minutes: int | None = None,
    bucket: int | None = None,
) -> dict:
    """Detail payload for one container: metadata + latest sample + bucketed history.

    Does NOT apply the freshness filter — a stopped container can still be
    inspected as long as its samples are within the retention window.
    """
    storage: Storage = app.state.storage
    minutes = minutes or settings.history_minutes_default
    if minutes <= 0 or minutes > MAX_MINUTES:
        raise HTTPException(status_code=400, detail=f"minutes out of range (1..{MAX_MINUTES})")
    bucket = bucket if (bucket and bucket > 0) else _pick_bucket(minutes)

    now = time.time()
    since = now - minutes * 60
    latest = storage.latest_for(container_id)
    history_samples = (
        storage.history_per_container([container_id], since, bucket).get(container_id, [])
    )
    if latest is None and not history_samples:
        raise HTTPException(status_code=404, detail="container not found")

    fresh = max(settings.interval_seconds * 3, 15.0)
    is_stale = latest is None or (now - latest["ts"]) > fresh
    return {
        "container_id": container_id,
        "name": latest["name"] if latest else container_id[:12],
        "image": latest["image"] if latest else None,
        "stale": is_stale,
        "latest": latest,
        "history": history_samples,
        "since": since,
        "minutes": minutes,
        "bucket": bucket,
        "now": now,
    }


@app.get("/name/{name}", response_class=HTMLResponse)
def name_detail_page(request: Request, name: str) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "name.html",
        {
            "name": name,
            "interval_ms": int(settings.interval_seconds * 1000),
            "history_minutes": settings.history_minutes_default,
            "retention_days": settings.retention_days,
        },
    )


@app.get("/api/names/{name}")
def name_detail(name: str, minutes: int | None = None, bucket: int | None = None) -> dict:
    """All instances (container_ids) that have ever borne `name`, each with its
    own bucketed history series — for overlaid rerun comparison."""
    storage: Storage = app.state.storage
    minutes = minutes or settings.history_minutes_default
    if minutes <= 0 or minutes > MAX_MINUTES:
        raise HTTPException(status_code=400, detail=f"minutes out of range (1..{MAX_MINUTES})")
    bucket = bucket if (bucket and bucket > 0) else _pick_bucket(minutes)

    instances_meta = storage.instances_for_name(name)
    if not instances_meta:
        raise HTTPException(status_code=404, detail=f"no containers named {name!r} in retention")

    now = time.time()
    since = now - minutes * 60
    fresh = max(settings.interval_seconds * 3, 15.0)
    ids = [m["container_id"] for m in instances_meta]
    history_map = storage.history_per_container(ids, since, bucket)

    instances: list[dict] = []
    for m in instances_meta:
        cid = m["container_id"]
        latest = storage.latest_for(cid)
        instances.append({
            "container_id": cid,
            "image": m["image"],
            "first_seen": m["first_seen"],
            "last_seen": m["last_seen"],
            "stale": (now - m["last_seen"]) > fresh,
            "latest": latest,
            "history": history_map.get(cid, []),
        })

    return {
        "name": name,
        "instances": instances,
        "now": now,
        "since": since,
        "minutes": minutes,
        "bucket": bucket,
    }


@app.get("/metrics")
def metrics_endpoint() -> PlainTextResponse:
    if not settings.metrics_enabled:
        raise HTTPException(status_code=404, detail="metrics endpoint disabled")
    storage: Storage = app.state.storage
    fresh = max(settings.interval_seconds * 3, 15.0)
    samples = storage.latest_per_container(fresh_within_seconds=fresh)
    return PlainTextResponse(metrics_fmt.render(samples), media_type=metrics_fmt.CONTENT_TYPE)


@app.get("/api/containers/{container_id}/history")
def history(container_id: str, minutes: int | None = None, bucket: int | None = None) -> dict:
    """Raw or bucketed history for one container. Kept for ad-hoc queries."""
    storage: Storage = app.state.storage
    minutes = minutes or settings.history_minutes_default
    if minutes <= 0 or minutes > MAX_MINUTES:
        raise HTTPException(status_code=400, detail=f"minutes out of range (1..{MAX_MINUTES})")
    since = time.time() - minutes * 60
    if bucket and bucket > 0:
        samples = storage.history_per_container([container_id], since, bucket).get(container_id, [])
    else:
        samples = storage.history(container_id, since)
    return {
        "container_id": container_id,
        "since": since,
        "minutes": minutes,
        "bucket": bucket,
        "samples": samples,
    }
