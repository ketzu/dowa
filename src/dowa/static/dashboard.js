(() => {
  const { intervalMs, historyMinutes, retentionDays } = window.DOWA;
  const grid = document.getElementById("grid");
  const status = document.getElementById("status");
  const bucketInfo = document.getElementById("bucket-info");
  const windowSelect = document.getElementById("window-select");
  const cards = new Map(); // container_id -> { el, chart, name }

  const PRESETS = [
    { label: "5 min",  minutes: 5 },
    { label: "15 min", minutes: 15 },
    { label: "30 min", minutes: 30 },
    { label: "1 hour", minutes: 60 },
    { label: "3 hours", minutes: 180 },
    { label: "6 hours", minutes: 360 },
    { label: "12 hours", minutes: 720 },
    { label: "24 hours", minutes: 1440 },
    { label: "3 days", minutes: 4320 },
    { label: "7 days", minutes: 10080 },
    { label: "14 days", minutes: 20160 },
    { label: "30 days", minutes: 43200 },
  ];

  const maxMinutes = (retentionDays || 7) * 1440;
  const visiblePresets = PRESETS.filter(p => p.minutes <= maxMinutes);
  for (const p of visiblePresets) {
    const opt = document.createElement("option");
    opt.value = String(p.minutes);
    opt.textContent = p.label;
    windowSelect.appendChild(opt);
  }
  windowSelect.value = String(
    visiblePresets.some(p => p.minutes === historyMinutes) ? historyMinutes : visiblePresets[2].minutes
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

  function fmtPct(p) {
    if (p == null || Number.isNaN(p)) return "—";
    return `${p.toFixed(1)}%`;
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

  function barClass(pct) {
    if (pct == null) return "";
    if (pct >= 90) return "crit";
    if (pct >= 70) return "warn";
    return "";
  }

  function makeCard(c) {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="head">
        <div>
          <a class="name" href="/container/${encodeURIComponent(c.container_id)}"></a>
          <div class="image"></div>
        </div>
        <div class="pid metric"><label>pids</label><div class="value">—</div></div>
      </div>
      <div class="metrics">
        <div class="metric cpu">
          <label>cpu</label>
          <div class="value">—</div>
          <div class="bar"><span style="width:0"></span></div>
        </div>
        <div class="metric mem">
          <label>memory</label>
          <div class="value">—</div>
          <div class="bar"><span style="width:0"></span></div>
        </div>
        <div class="metric net"><label>net rx / tx</label><div class="value">—</div></div>
        <div class="metric io"><label>blk read / write</label><div class="value">—</div></div>
      </div>
      <div class="chart-wrap"><canvas></canvas></div>
    `;
    grid.appendChild(el);

    const ctx = el.querySelector("canvas").getContext("2d");
    const chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "CPU %",
            data: [],
            borderColor: "#5eead4",
            backgroundColor: "rgba(94,234,212,0.15)",
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1.5,
            fill: true,
            yAxisID: "yCpu",
          },
          {
            label: "Mem",
            data: [],
            borderColor: "#a78bfa",
            backgroundColor: "rgba(167,139,250,0.10)",
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 1.5,
            fill: true,
            yAxisID: "yMem",
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#8a93a6", boxWidth: 10, font: { size: 10 } } },
          tooltip: {
            enabled: true,
            callbacks: {
              label: (item) => {
                const v = item.parsed.y;
                if (item.dataset.yAxisID === "yMem") return `Mem: ${fmtBytes(v)}`;
                return `CPU: ${fmtPct(v)}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: "time",
            time: { unit: pickTimeUnit(currentMinutes) },
            ticks: { color: "#8a93a6", maxRotation: 0, font: { size: 10 } },
            grid: { color: "#1f2533" },
          },
          yCpu: {
            position: "left",
            beginAtZero: true,
            suggestedMax: 100,
            ticks: { color: "#8a93a6", font: { size: 10 }, callback: (v) => `${v}%` },
            grid: { color: "#1f2533" },
          },
          yMem: {
            position: "right",
            beginAtZero: true,
            ticks: { color: "#8a93a6", font: { size: 10 }, callback: (v) => fmtBytes(v) },
            grid: { display: false },
          },
        },
      },
    });

    return { el, chart, name: c.name };
  }

  function setChartData(card, samples) {
    card.chart.data.labels = samples.map(s => new Date(s.ts * 1000));
    card.chart.data.datasets[0].data = samples.map(s => s.cpu_percent);
    card.chart.data.datasets[1].data = samples.map(s => s.mem_used);
    card.chart.options.scales.x.time.unit = pickTimeUnit(currentMinutes);
    card.chart.update("none");
  }

  function updateCardText(card, c) {
    const latest = c.latest || {};
    card.el.querySelector(".name").textContent = c.name;
    card.el.querySelector(".image").textContent = c.image || "";
    card.el.querySelector(".pid .value").textContent = latest.pids ?? "—";

    const cpu = latest.cpu_percent;
    card.el.querySelector(".cpu .value").textContent = fmtPct(cpu);
    const cpuBar = card.el.querySelector(".cpu .bar");
    cpuBar.className = `bar ${barClass(cpu)}`;
    cpuBar.firstElementChild.style.width = `${Math.min(100, cpu ?? 0)}%`;

    const memPct = latest.mem_percent;
    card.el.querySelector(".mem .value").textContent =
      `${fmtBytes(latest.mem_used)} / ${fmtBytes(latest.mem_limit)} (${fmtPct(memPct)})`;
    const memBar = card.el.querySelector(".mem .bar");
    memBar.className = `bar ${barClass(memPct)}`;
    memBar.firstElementChild.style.width = `${Math.min(100, memPct ?? 0)}%`;

    card.el.querySelector(".net .value").textContent =
      `${fmtBytes(latest.net_rx)} / ${fmtBytes(latest.net_tx)}`;
    card.el.querySelector(".io .value").textContent =
      `${fmtBytes(latest.block_read)} / ${fmtBytes(latest.block_write)}`;
  }

  let inFlight = false;
  async function refresh() {
    if (inFlight) return; // skip overlapping polls when the server is slow
    inFlight = true;
    try {
      const r = await fetch(`/api/containers?minutes=${currentMinutes}`);
      if (!r.ok) throw new Error(`http ${r.status}`);
      const data = await r.json();
      const containers = data.containers || [];
      status.textContent = `${containers.length} container${containers.length === 1 ? "" : "s"} · ${new Date().toLocaleTimeString()}`;
      bucketInfo.textContent = `bucket: ${fmtBucket(data.bucket)}`;

      if (containers.length === 0 && cards.size === 0) {
        grid.innerHTML = '<div class="empty">no container samples yet</div>';
        return;
      }
      const emptyMsg = grid.querySelector(".empty");
      if (emptyMsg) emptyMsg.remove();

      const seen = new Set();
      for (const c of containers) {
        seen.add(c.container_id);
        let card = cards.get(c.container_id);
        if (!card) {
          card = makeCard(c);
          cards.set(c.container_id, card);
        }
        updateCardText(card, c);
        setChartData(card, c.history || []);
      }
      for (const [id, card] of cards) {
        if (!seen.has(id)) {
          card.chart.destroy();
          card.el.remove();
          cards.delete(id);
        }
      }
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
