# dowa

A small, self-contained dashboard for Docker container stats. Runs as one
container, mounts the Docker socket, polls every running container on an
interval, persists samples to SQLite, and serves a web UI and a Prometheus
metrics endpoint.

Built for hobby hosts and small homelabs where running Prometheus + cAdvisor +
Grafana feels like more machinery than the problem warrants.

## What you get

- **Dashboard at `/`** with one card per running container: live CPU%, memory
  used / limit, network rx/tx, block I/O, plus a rolling chart of CPU and
  memory.
- **Per-container detail page** at `/container/{id}` with larger CPU, memory,
  network rate, and block I/O rate charts.
- **Per-name compare view** at `/name/{name}` overlaying every rerun of the
  same container name on shared axes — with a "since start" alignment mode so
  you can compare the first 30 minutes of yesterday's run against today's
  rebuild even though they happened at different times.
- **Show historical** toggle on the dashboard surfaces stopped/replaced
  containers (within the selected time window) alongside live ones, sorted so
  reruns of the same name sit adjacent.
- **Selectable time window** from 5 minutes to 30 days (capped by retention).
  Long windows are server-side bucketed so charts stay responsive.
- **Prometheus `/metrics`** endpoint exposing CPU/memory/network/IO/pids per
  container with `container_id`, `name`, and `image` labels.

## Quick start

```sh
docker compose up --build
```

Dashboard at <http://localhost:8000>. Data persists in the `dowa-data` named
volume; `/var/run/docker.sock` is bind-mounted read-only.

To run locally for development (needs uv and Docker socket access):

```sh
uv sync
DOWA_DB_PATH=./dowa.db uv run dowa
```

## Configuration

All settings are read from environment variables, prefix `DOWA_`. Defaults
shown.

| Variable                       | Default          | Description                                                          |
| ------------------------------ | ---------------- | -------------------------------------------------------------------- |
| `DOWA_INTERVAL_SECONDS`        | `5`              | How often the scraper polls Docker.                                  |
| `DOWA_RETENTION_DAYS`          | `7`              | Samples older than this are pruned hourly.                           |
| `DOWA_DB_PATH`                 | `/data/dowa.db`  | SQLite database file. Mount a volume here.                           |
| `DOWA_HISTORY_MINUTES_DEFAULT` | `30`             | Default time window for the dashboard.                               |
| `DOWA_HOST`                    | `0.0.0.0`        | HTTP bind address.                                                   |
| `DOWA_PORT`                    | `8000`           | HTTP port.                                                           |
| `DOWA_SCRAPER_WORKERS`         | `8`              | Thread pool size for parallel `stats()` calls per tick.              |
| `DOWA_LOG_LEVEL`               | `INFO`           | Log level for both the app and uvicorn.                              |
| `DOWA_ACCESS_LOG`              | `true`           | Toggle uvicorn HTTP access log.                                      |
| `DOWA_METRICS_ENABLED`         | `true`           | Toggle the `/metrics` endpoint (404s when off).                      |
| `DOWA_DOCKER_BASE_URL`         | unset            | Override the Docker daemon URL. Unset uses the SDK defaults.         |

## HTTP API

| Route                                          | Returns                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /`                                        | Dashboard HTML                                                                                      |
| `GET /container/{id}`                          | Per-container detail page                                                                           |
| `GET /name/{name}`                             | Per-name rerun comparison page                                                                      |
| `GET /api/containers`                          | Latest sample + bucketed history for each live container. Query: `minutes`, `bucket`, `include_historical` |
| `GET /api/containers/{id}`                     | Latest sample + bucketed history for one container. Query: `minutes`, `bucket`                      |
| `GET /api/containers/{id}/history`             | Raw or bucketed samples for one container. Query: `minutes`, `bucket`                               |
| `GET /api/names/{name}`                        | All instances (container_ids) that have ever borne `name`, each with its own bucketed history       |
| `GET /metrics`                                 | Prometheus exposition format                                                                        |
| `GET /healthz`                                 | `{"ok": true}`                                                                                      |

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: dowa
    static_configs:
      - targets: ['dowa:8000']
```

Metrics exposed (labels `container_id`, `name`, `image` on each):

| Metric                                | Type    | Notes                                                          |
| ------------------------------------- | ------- | -------------------------------------------------------------- |
| `dowa_cpu_percent`                    | gauge   | CPU % of one core × cores online (matches `docker stats`)      |
| `dowa_memory_used_bytes`              | gauge   | Cache subtracted, like `docker stats`                          |
| `dowa_memory_limit_bytes`             | gauge   |                                                                |
| `dowa_memory_percent`                 | gauge   |                                                                |
| `dowa_pids`                           | gauge   |                                                                |
| `dowa_sample_timestamp_seconds`       | gauge   | Use to compute staleness: `time() - dowa_sample_timestamp_seconds` |
| `dowa_network_receive_bytes_total`    | counter | Sum across all networks                                        |
| `dowa_network_transmit_bytes_total`   | counter |                                                                |
| `dowa_block_read_bytes_total`         | counter |                                                                |
| `dowa_block_write_bytes_total`        | counter |                                                                |

## How it works

```
            +---------+        +-----------+
            | Docker  |<------ |  Scraper  |  (background thread, polls every
            | socket  |        |           |   DOWA_INTERVAL_SECONDS)
            +---------+        +-----+-----+
                                     |
                                     v
                              +------+------+
                              |   SQLite    |  (WAL, single samples table,
                              | dowa.db     |   hourly retention prune)
                              +------+------+
                                     |
                                     v
                          +----------+----------+
                          |     FastAPI app     |
                          |  / dashboard        |
                          |  /container/{id}    |
                          |  /name/{name}       |
                          |  /api/...           |
                          |  /metrics           |
                          +---------------------+
```

The scraper uses `container.stats(stream=False)` in a thread pool — one HTTP
round-trip per container per tick, parallelized.

Long time windows are made cheap with server-side bucketing: requests pick a
bucket size targeting ~400 points per chart (snapped to nice intervals like
5 s / 5 min / 30 min), and a single SQL `GROUP BY container_id, CAST(ts/bucket
AS INTEGER)` returns all instances' aggregated series in one query.

## Storage and persistence

One table, `samples`, keyed by `(container_id, ts)`. Indices on `ts` and
`(container_id, ts)` support both retention pruning and per-container history
queries.

The "stale container" feature uses the same table — when a container goes
away, its rows remain in the database for the retention period, so:

- the dashboard freshness filter hides stopped containers by default,
- the **show historical** toggle brings them back as muted cards,
- the **`/name/{name}` compare view** lets you overlay reruns sharing a name,
- the **`/container/{id}` detail view** still works for inspecting stopped
  containers' last hours.

Wipe data with `docker compose down -v` (removes the named volume).

## Limitations

- Single-host: dowa watches the Docker daemon it's pointed at. No cluster view.
- No authentication. Don't expose the port to the internet without putting a
  reverse proxy with auth in front of it.
- The `/metrics` endpoint reports cumulative network and block counters
  straight from Docker — those reset to zero when a container restarts.
  Prometheus tolerates this, but `rate()` over a restart returns nothing for
  that window.
- Windows containers are untested. On Windows hosts with Docker Desktop's WSL2
  backend, Linux containers work fine.
