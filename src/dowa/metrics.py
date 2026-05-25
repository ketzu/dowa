"""Prometheus text-format renderer for the latest per-container sample.

Hand-rolled so we don't pull in `prometheus_client` for a few dozen lines.
Format reference: https://prometheus.io/docs/instrumenting/exposition_formats/
"""
from __future__ import annotations

from typing import Iterable

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

GAUGES: list[tuple[str, str, str]] = [
    ("dowa_cpu_percent",
     "Container CPU usage as percent of one CPU core multiplied by online cores.",
     "cpu_percent"),
    ("dowa_memory_used_bytes",
     "Container memory usage in bytes (cache subtracted to match `docker stats`).",
     "mem_used"),
    ("dowa_memory_limit_bytes",
     "Container memory limit in bytes.",
     "mem_limit"),
    ("dowa_memory_percent",
     "Container memory usage as percent of its limit.",
     "mem_percent"),
    ("dowa_pids",
     "Number of processes in the container's PID namespace.",
     "pids"),
    ("dowa_sample_timestamp_seconds",
     "Unix timestamp of the latest sample for this container — use to detect staleness.",
     "ts"),
]

COUNTERS: list[tuple[str, str, str]] = [
    ("dowa_network_receive_bytes_total",
     "Cumulative bytes received across all of the container's networks.",
     "net_rx"),
    ("dowa_network_transmit_bytes_total",
     "Cumulative bytes transmitted across all of the container's networks.",
     "net_tx"),
    ("dowa_block_read_bytes_total",
     "Cumulative bytes read from block devices by the container.",
     "block_read"),
    ("dowa_block_write_bytes_total",
     "Cumulative bytes written to block devices by the container.",
     "block_write"),
]


def _escape_label(v: str | None) -> str:
    if v is None:
        return ""
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _labels(s: dict) -> str:
    parts = [
        f'container_id="{_escape_label(s.get("container_id"))}"',
        f'name="{_escape_label(s.get("name"))}"',
    ]
    image = s.get("image")
    if image:
        parts.append(f'image="{_escape_label(image)}"')
    return "{" + ",".join(parts) + "}"


def render(samples: Iterable[dict]) -> str:
    samples = list(samples)
    out: list[str] = []
    for metric, help_text, field in GAUGES:
        out.append(f"# HELP {metric} {help_text}")
        out.append(f"# TYPE {metric} gauge")
        for s in samples:
            v = s.get(field)
            if v is None:
                continue
            out.append(f"{metric}{_labels(s)} {v}")
    for metric, help_text, field in COUNTERS:
        out.append(f"# HELP {metric} {help_text}")
        out.append(f"# TYPE {metric} counter")
        for s in samples:
            v = s.get(field)
            if v is None:
                continue
            out.append(f"{metric}{_labels(s)} {v}")
    out.append("")  # trailing newline
    return "\n".join(out)
