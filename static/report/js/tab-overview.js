/* ===== Вкладка "Обзор датасета / статистика" ===== */
(function () {
  "use strict";

  let initialized = false;
  const TOP_N = 15;

  function allTableNames() {
    return Object.keys(window.EVE_META.tables);
  }

  function buildStats() {
    const tables = window.EVE_META.tables;
    const names = allTableNames();
    const totalRows = names.reduce((s, n) => s + tables[n].rows, 0);
    const totalBytes = names.reduce((s, n) => s + tables[n].bytes, 0);
    const smallCount = names.filter((n) => tables[n].rows < 100).length;
    const i18nCount = names.filter((n) => tables[n].fields.some((f) => f.types.includes("i18n"))).length;
    let largest = names[0];
    names.forEach((n) => { if (tables[n].rows > tables[largest].rows) largest = n; });

    const sde = window.EVE_META.sde || {};
    return { totalRows, totalBytes, smallCount, i18nCount, largest, count: names.length };
  }

  function tile(value, label) {
    return EveUtil.el("div", { class: "stat-tile" }, [
      EveUtil.el("div", { class: "stat-value" }, value),
      EveUtil.el("div", { class: "stat-label" }, label),
    ]);
  }

  function ensureTooltip() {
    let tip = document.getElementById("chart-tooltip");
    if (!tip) {
      tip = EveUtil.el("div", { id: "chart-tooltip", class: "chart-tooltip" });
      document.body.appendChild(tip);
    }
    return tip;
  }

  function attachTooltip(el, text) {
    const tip = ensureTooltip();
    el.addEventListener("mouseenter", () => { tip.textContent = text; tip.style.opacity = "1"; });
    el.addEventListener("mousemove", (e) => {
      tip.style.left = (e.clientX + 14) + "px";
      tip.style.top = (e.clientY + 10) + "px";
    });
    el.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
  }

  function buildBarChart(container, metricKey, metricLabel, formatFn) {
    const tables = window.EVE_META.tables;
    const names = allTableNames()
      .slice()
      .sort((a, b) => tables[b][metricKey] - tables[a][metricKey])
      .slice(0, TOP_N);
    const max = tables[names[0]][metricKey];

    const chart = EveUtil.el("div", { class: "bar-chart" });
    names.forEach((n) => {
      const meta = tables[n];
      const g = window.EVE_META.groups[meta.group];
      const pct = Math.max((meta[metricKey] / max) * 100, 1.2);
      const row = EveUtil.el("div", { class: "bar-row" }, [
        EveUtil.el("div", { class: "bar-label mono" }, n),
        EveUtil.el("div", { class: "bar-track" }, [
          EveUtil.el("div", {
            class: "bar-fill", style: `width:${pct}%; --bc:${g.color}; --bc-dark:${g.colorDark}`,
          }),
        ]),
        EveUtil.el("div", { class: "bar-value tabular" }, formatFn(meta[metricKey])),
      ]);
      attachTooltip(row, n + " — " + formatFn(meta[metricKey]) + " · " + g.label);
      chart.appendChild(row);
    });
    container.appendChild(chart);

    const legend = EveUtil.el("div", { class: "erd-legend", style: "margin-top:8px" });
    ["items", "universe", "npc", "content", "ships", "meta"].forEach((gk) => {
      const g = window.EVE_META.groups[gk];
      legend.appendChild(EveUtil.el("span", { class: "erd-legend-chip", style: `--c:${g.color};--c-dark:${g.colorDark}` }, [
        EveUtil.el("span", { class: "erd-legend-dot" }), g.label,
      ]));
    });
    container.appendChild(legend);
  }

  function buildTable(container) {
    const tables = window.EVE_META.tables;
    const relations = window.EVE_META.relations;
    const outCount = {}, inCount = {};
    relations.forEach((r) => {
      outCount[r.from] = (outCount[r.from] || 0) + 1;
      if (r.to !== r.from) inCount[r.to] = (inCount[r.to] || 0) + 1;
    });

    const toolbar = EveUtil.el("div", { class: "toolbar" });
    const search = EveUtil.el("input", { type: "search", placeholder: "Поиск по имени/описанию…", style: "width:260px" });
    toolbar.appendChild(search);
    const countHint = EveUtil.el("span", { class: "hint" }, "");
    toolbar.appendChild(countHint);
    container.appendChild(toolbar);

    const wrap = EveUtil.el("div", { class: "data-table-wrap" });
    const table = EveUtil.el("table", { class: "data-table" });
    const thead = EveUtil.el("thead", {}, EveUtil.el("tr", {}, [
      EveUtil.el("th", {}, "Домен"),
      EveUtil.el("th", {}, "Таблица"),
      EveUtil.el("th", { class: "num" }, "Строк"),
      EveUtil.el("th", { class: "num" }, "Размер"),
      EveUtil.el("th", {}, "i18n"),
      EveUtil.el("th", { class: "num" }, "Связей →"),
      EveUtil.el("th", { class: "num" }, "Связей ←"),
      EveUtil.el("th", {}, "Описание"),
      EveUtil.el("th", {}, ""),
    ]));
    const tbody = EveUtil.el("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);

    allTableNames().sort().forEach((n) => {
      const meta = tables[n];
      const g = window.EVE_META.groups[meta.group];
      const hasI18n = meta.fields.some((f) => f.types.includes("i18n"));
      const tr = EveUtil.el("tr", {}, [
        EveUtil.el("td", {}, EveUtil.el("span", { class: "pill", style: `border-color:${g.color}` }, g.label)),
        EveUtil.el("td", { class: "mono" }, n),
        (() => { const td = document.createElement("td"); td.className = "num"; td.dataset.sort = meta.rows; td.textContent = EveUtil.formatNumber(meta.rows); return td; })(),
        (() => { const td = document.createElement("td"); td.className = "num"; td.dataset.sort = meta.bytes; td.textContent = EveUtil.formatBytes(meta.bytes); return td; })(),
        EveUtil.el("td", {}, hasI18n ? "✓" : ""),
        (() => { const td = document.createElement("td"); td.className = "num"; const v = outCount[n] || 0; td.dataset.sort = v; td.textContent = String(v); return td; })(),
        (() => { const td = document.createElement("td"); td.className = "num"; const v = inCount[n] || 0; td.dataset.sort = v; td.textContent = String(v); return td; })(),
        EveUtil.el("td", { class: "truncate", title: meta.desc }, meta.desc),
        EveUtil.el("td", {}, EveUtil.el("a", { href: "#", onclick: (e) => { e.preventDefault(); window.EveApp.openInExplorer(n); } }, "открыть →")),
      ]);
      tr.dataset.search = (n + " " + meta.desc).toLowerCase();
      tbody.appendChild(tr);
    });

    EveUtil.makeSortable(table);

    function applyFilter() {
      const q = search.value.trim().toLowerCase();
      let visible = 0;
      Array.from(tbody.rows).forEach((tr) => {
        const ok = !q || tr.dataset.search.includes(q);
        tr.style.display = ok ? "" : "none";
        if (ok) visible++;
      });
      countHint.textContent = "показано " + visible + " из " + tbody.rows.length;
    }
    search.addEventListener("input", EveUtil.debounce(applyFilter, 120));
    applyFilter();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const panel = document.getElementById("tab-overview");
    const stats = buildStats();
    const tables = window.EVE_META.tables;

    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "Обзор датасета"));

    const grid = EveUtil.el("div", { class: "grid-cards" });
    grid.appendChild(tile(String(stats.count), "таблиц (.jsonl)"));
    grid.appendChild(tile(EveUtil.formatNumber(stats.totalRows), "строк суммарно"));
    grid.appendChild(tile(EveUtil.formatBytes(stats.totalBytes), "суммарный объём"));
    grid.appendChild(tile(String(stats.smallCount), "справочников < 100 строк"));
    grid.appendChild(tile(String(stats.i18nCount), "таблиц с локализацией"));
    grid.appendChild(tile(stats.largest, "самая большая (" + EveUtil.formatNumber(tables[stats.largest].rows) + " стр.)"));
    panel.appendChild(grid);

    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "Топ-" + TOP_N + " таблиц по числу строк"));
    const chartCard1 = EveUtil.el("div", { class: "card" });
    buildBarChart(chartCard1, "rows", "строк", EveUtil.formatNumber);
    panel.appendChild(chartCard1);

    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "Топ-" + TOP_N + " таблиц по размеру файла"));
    const chartCard2 = EveUtil.el("div", { class: "card" });
    buildBarChart(chartCard2, "bytes", "байт", EveUtil.formatBytes);
    panel.appendChild(chartCard2);

    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "Все таблицы"));
    buildTable(panel);
  }

  window.EveTabOverview = { init };
})();
