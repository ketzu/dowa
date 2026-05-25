(() => {
  const { containerId, intervalMs, historyMinutes, retentionDays } = window.DOWA;
  const status = document.getElementById("status");
  const bucketInfo = document.getElementById("bucket-info");
  const windowSelect = document.getElementById("window-select");
  const nameEl = document.getElementById("container-name");
  const imageEl = document.getElementById("image");
  const pidsEl = document.getElementById("pids");
  const lastEl = document.getElementById("last-sample");
  document.title = `dowa — ${containerId.slice(0, 12)}`;

  const PRESETS = [
    { label: "5 min",   minutes: 5 },
    { label: "15 min",  minutes: 15 },
    { label: "30 min",  minutes: 30 },
    { label: "1 hour",  minutes: 60 },
    { label: "3 hours", minutes: 180 },
    { label: "6 hours", minutes: 360 },
    { label: "12 hours", minutes: 720 },
    { label: "24 hours", minutes: 1440 },
    { label: "3 days",  minutes: 4320 },
    { label: "7 days",  minutes: 10080 },
    { label: "14 days", minutes: 20160 },
    { label: "30 days", minutes: 43200 },
  ];
  const maxMinutes = (retentionDays || 7) * 1440;
  const visible = PRESETS.filter(p => p.minutes <= maxMinutes);
  for (const p of visible) {
    const opt = document.createElement("option");
    opt.value = String(p.minutes);
    opt.textContent = p.label;
    windowSelect.appendChild(opt);
  }
  windowSelect.value = String(
    visible.some(p => p.minutes === historyMinutes) ? historyMinutes : visible[2].minutes
  );
  let currentMinutes = Number(windowSelect.value);

  function fmtBytes(n) {
    if (n == null) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    let v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
  }
  function fmtBytesPerSec(n) {
    return n == null ? "—" : `${fmtBytes(n)}/s`;
  }
  function fmtPct(p) {
    if (p == null || Number.isNaN(p)) return "—";
    return `${p.toFixed(2)}%`;
  }
  function fmtBucket(seconds) {
    if (!seconds) return "";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  }
  function pickTimeUnit(minutes) {
    if (minutes <= 60) return "minute";
    if (minutes <= 60 * 24) return "hour";
    return "day";
  }

  const baseScales = () => ({
    x: {
      type: "time",
      time: { unit: pickTimeUnit(currentMinutes) },
      ticks: { color: "#8a93a6", maxRotation: 0, font: { size: 10 } },
      grid: { color: "#1f2533" },
    },
  });

  const baseOptions = (extraScales, tooltipLabel) => ({
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#8a93a6", boxWidth: 10, font: { size: 11 } } },
      tooltip: { enabled: true, callbacks: { label: tooltipLabel } },
    },
    scales: { ...baseScales(), ...extraScales },
  });

  function makeChart(canvasId, datasets, scales, tooltipLabel) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    return new Chart(ctx, {
      type: "line",
      data: { labels: [], datasets },
      options: baseOptions(scales, tooltipLabel),
    });
  }

  const cpuChart = makeChart(
    "cpu-chart",
    [{
      label: "CPU %", data: [],
      borderColor: "#5eead4", backgroundColor: "rgba(94,234,212,0.15)",
      tension: 0.25, pointRadius: 0, borderWidth: 1.5, fill: true, yAxisID: "y",
    }],
    {
      y: {
        beginAtZero: true, suggestedMax: 100,
        ticks: { color: "#8a93a6", font: { size: 10 }, callback: v => `${v}%` },
        grid: { color: "#1f2533" },
      },
    },
    (item) => `CPU: ${fmtPct(item.parsed.y)}`
  );

  const memChart = makeChart(
    "mem-chart",
    [
      {
        label: "Used", data: [],
        borderColor: "#a78bfa", backgroundColor: "rgba(167,139,250,0.15)",
        tension: 0.25, pointRadius: 0, borderWidth: 1.5, fill: true, yAxisID: "y",
      },
      {
        label: "Limit", data: [],
        borderColor: "#475569", borderDash: [4, 4],
        tension: 0, pointRadius: 0, borderWidth: 1, fill: false, yAxisID: "y",
      },
    ],
    {
      y: {
        beginAtZero: true,
        ticks: { color: "#8a93a6", font: { size: 10 }, callback: v => fmtBytes(v) },
        grid: { color: "#1f2533" },
      },
    },
    (item) => `${item.dataset.label}: ${fmtBytes(item.parsed.y)}`
  );

  const netChart = makeChart(
    "net-chart",
    [
      {
        label: "RX", data: [],
        borderColor: "#5eead4", backgroundColor: "rgba(94,234,212,0.10)",
        tension: 0.25, pointRadius: 0, borderWidth: 1.5, fill: true, yAxisID: "y",
      },
      {
        label: "TX", data: [],
        borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,0.10)",
        tension: 0.25, pointRadius: 0, borderWidth: 1.5, fill: true, yAxisID: "y",
      },
    ],
    {
      y: {
        beginAtZero: true,
        ticks: { color: "#8a93a6", font: { size: 10 }, callback: v => fmtBytesPerSec(v) },
        grid: { color: "#1f2533" },
      },
    },
    (item) => `${item.dataset.label}: ${fmtBytesPerSec(item.parsed.y)}`
  );

  const ioChart = makeChart(
    "io-chart",
    [
      {
        label: "Read", data: [],
        borderColor: "#5eead4", backgroundColor: "rgba(94,234,212,0.10)",
        tension: 0.25, pointRadius: 0, borderWidth: 1.5, fill: true, yAxisID: "y",
      },
      {
        label: "Write", data: [],
        borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.10)",
        tension: 0.25, pointRadius: 0, borderWidth: 1.5, fill: true, yAxisID: "y",
      },
    ],
    {
      y: {
        beginAtZero: true,
        ticks: { color: "#8a93a6", font: { size: 10 }, callback: v => fmtBytesPerSec(v) },
        grid: { color: "#1f2533" },
      },
    },
    (item) => `${item.dataset.label}: ${fmtBytesPerSec(item.parsed.y)}`
  );

  function rateSeries(samples, field) {
    // First point has no predecessor; null leaves a gap so labels align.
    const out = [null];
    for (let i = 1; i < samples.length; i++) {
      const dt = samples[i].ts - samples[i - 1].ts;
      const dv = samples[i][field] - samples[i - 1][field];
      out.push(dt > 0 && dv >= 0 ? dv / dt : null);
    }
    return out;
  }

  function updateUnits() {
    const unit = pickTimeUnit(currentMinutes);
    for (const c of [cpuChart, memChart, netChart, ioChart]) {
      c.options.scales.x.time.unit = unit;
    }
  }

  let inFlight = false;
  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await fetch(`/api/containers/${encodeURIComponent(containerId)}?minutes=${currentMinutes}`);
      if (!r.ok) {
        if (r.status === 404) status.textContent = "container not found";
        else status.textContent = `error: http ${r.status}`;
        return;
      }
      const data = await r.json();
      nameEl.textContent = data.name;
      imageEl.textContent = data.image || "—";
      pidsEl.textContent = data.latest?.pids ?? "—";
      lastEl.textContent = data.latest
        ? new Date(data.latest.ts * 1000).toLocaleString()
        : "—";
      bucketInfo.textContent = `bucket: ${fmtBucket(data.bucket)}`;
      const samples = data.history || [];
      status.textContent =
        `${samples.length} point${samples.length === 1 ? "" : "s"} · ${new Date().toLocaleTimeString()}`
        + (data.stale ? " · stale" : "");

      const labels = samples.map(s => new Date(s.ts * 1000));
      updateUnits();

      cpuChart.data.labels = labels;
      cpuChart.data.datasets[0].data = samples.map(s => s.cpu_percent);
      cpuChart.update("none");

      memChart.data.labels = labels;
      memChart.data.datasets[0].data = samples.map(s => s.mem_used);
      memChart.data.datasets[1].data = samples.map(s => s.mem_limit);
      memChart.update("none");

      netChart.data.labels = labels;
      netChart.data.datasets[0].data = rateSeries(samples, "net_rx");
      netChart.data.datasets[1].data = rateSeries(samples, "net_tx");
      netChart.update("none");

      ioChart.data.labels = labels;
      ioChart.data.datasets[0].data = rateSeries(samples, "block_read");
      ioChart.data.datasets[1].data = rateSeries(samples, "block_write");
      ioChart.update("none");
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    } finally {
      inFlight = false;
    }
  }

  windowSelect.addEventListener("change", () => {
    currentMinutes = Number(windowSelect.value);
    refresh();
  });

  refresh();
  setInterval(refresh, intervalMs);
})();
