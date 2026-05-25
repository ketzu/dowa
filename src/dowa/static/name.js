(() => {
  const { name, intervalMs, historyMinutes, retentionDays } = window.DOWA;
  const status = document.getElementById("status");
  const bucketInfo = document.getElementById("bucket-info");
  const windowSelect = document.getElementById("window-select");
  const alignSelect = document.getElementById("align-select");
  const instanceCountEl = document.getElementById("instance-count");
  const firstSeenEl = document.getElementById("first-seen");
  const lastSeenEl = document.getElementById("last-seen");
  const instanceTbody = document.querySelector("#instance-table tbody");

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
  for (const p of PRESETS.filter(p => p.minutes <= maxMinutes)) {
    const opt = document.createElement("option");
    opt.value = String(p.minutes);
    opt.textContent = p.label;
    windowSelect.appendChild(opt);
  }
  windowSelect.value = String(
    [...windowSelect.options].some(o => Number(o.value) === historyMinutes)
      ? historyMinutes
      : 1440
  );
  // Default to since_start: that's the comparison mode users want for reruns.
  alignSelect.value = localStorage.getItem("dowa.nameAlign") || "since_start";
  let currentMinutes = Number(windowSelect.value);
  let align = alignSelect.value;

  const PALETTE = [
    "#5eead4", "#a78bfa", "#f59e0b", "#ef4444", "#22d3ee",
    "#fb7185", "#84cc16", "#eab308", "#06b6d4", "#d946ef",
    "#94a3b8", "#fda4af", "#a3e635",
  ];

  function fmtBytes(n) {
    if (n == null) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
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
  function fmtElapsed(ms) {
    if (ms == null) return "";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) {
      const rem = m % 60;
      return rem ? `${h}h ${rem}m` : `${h}h`;
    }
    const d = Math.floor(h / 24);
    const rem = h % 24;
    return rem ? `${d}d ${rem}h` : `${d}d`;
  }
  function fmtTime(ts) {
    if (ts == null) return "—";
    return new Date(ts * 1000).toLocaleString();
  }
  function fmtX(value) {
    return align === "since_start" ? fmtElapsed(value) : new Date(value).toLocaleString();
  }

  function makeChart(canvasId, yTickFmt, tooltipPrefix, yMin0 = true, ySuggMax) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    return new Chart(ctx, {
      type: "line",
      data: { datasets: [] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false, // datasets supply {x, y} directly
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: { labels: { color: "#8a93a6", boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            enabled: true,
            callbacks: {
              title: (items) => fmtX(items[0]?.parsed.x),
              label: (item) => `${item.dataset.label}: ${tooltipPrefix(item.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            ticks: {
              color: "#8a93a6", maxRotation: 0, font: { size: 10 },
              callback: (v) => fmtX(v),
            },
            grid: { color: "#1f2533" },
          },
          y: {
            beginAtZero: yMin0,
            suggestedMax: ySuggMax,
            ticks: { color: "#8a93a6", font: { size: 10 }, callback: yTickFmt },
            grid: { color: "#1f2533" },
          },
        },
      },
    });
  }

  const cpuChart = makeChart("cpu-chart", (v) => `${v}%`, fmtPct, true, 100);
  const memChart = makeChart("mem-chart", (v) => fmtBytes(v), fmtBytes, true);

  function shortId(id) { return (id || "").slice(0, 12); }
  function datasetLabel(inst) {
    const t = new Date((inst.last_seen || inst.first_seen) * 1000).toLocaleString();
    return `${shortId(inst.container_id)} · ${t}`;
  }

  function buildSeries(instances, field) {
    return instances.map((inst, idx) => {
      const color = PALETTE[idx % PALETTE.length];
      const base = align === "since_start" ? inst.first_seen : 0;
      const data = (inst.history || [])
        .map(s => ({ x: (s.ts - base) * 1000, y: s[field] }))
        .filter(p => p.y != null);
      return {
        label: datasetLabel(inst),
        data,
        borderColor: color,
        backgroundColor: color + "22",
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 1.5,
        fill: false,
        spanGaps: false,
      };
    });
  }

  function renderInstanceTable(instances) {
    instanceTbody.innerHTML = "";
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const color = PALETTE[i % PALETTE.length];
      const tr = document.createElement("tr");
      if (inst.stale) tr.classList.add("stale");
      tr.innerHTML = `
        <td><span class="swatch" style="background:${color}"></span></td>
        <td><a class="id-chip" href="/container/${encodeURIComponent(inst.container_id)}">${shortId(inst.container_id)}</a></td>
        <td>${inst.image || "—"}</td>
        <td>${fmtTime(inst.first_seen)}</td>
        <td>${fmtTime(inst.last_seen)}</td>
        <td>${inst.stale ? '<span class="stale-badge">stopped</span>' : '<span class="live-badge">live</span>'}</td>
        <td><a class="detail-link" href="/container/${encodeURIComponent(inst.container_id)}">detail →</a></td>
      `;
      instanceTbody.appendChild(tr);
    }
  }

  let inFlight = false;
  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await fetch(`/api/names/${encodeURIComponent(name)}?minutes=${currentMinutes}`);
      if (!r.ok) {
        if (r.status === 404) status.textContent = "no instances for this name in retention";
        else status.textContent = `error: http ${r.status}`;
        return;
      }
      const data = await r.json();
      const instances = data.instances || [];
      const live = instances.filter(i => !i.stale).length;
      const stale = instances.length - live;
      instanceCountEl.textContent = `${instances.length} (${live} live${stale ? `, ${stale} stale` : ""})`;
      if (instances.length) {
        firstSeenEl.textContent = fmtTime(Math.min(...instances.map(i => i.first_seen)));
        lastSeenEl.textContent = fmtTime(Math.max(...instances.map(i => i.last_seen)));
      }
      bucketInfo.textContent = `bucket: ${fmtBucket(data.bucket)}`;
      const points = instances.reduce((s, i) => s + (i.history?.length || 0), 0);
      status.textContent = `${points} point${points === 1 ? "" : "s"} · ${new Date().toLocaleTimeString()}`;

      cpuChart.data.datasets = buildSeries(instances, "cpu_percent");
      memChart.data.datasets = buildSeries(instances, "mem_used");
      cpuChart.update("none");
      memChart.update("none");

      renderInstanceTable(instances);
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
  alignSelect.addEventListener("change", () => {
    align = alignSelect.value;
    localStorage.setItem("dowa.nameAlign", align);
    refresh();
  });

  refresh();
  setInterval(refresh, intervalMs);
})();
