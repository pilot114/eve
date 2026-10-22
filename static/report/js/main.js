/* ===== Управление вкладками и общая инициализация ===== */
(function () {
  "use strict";

  const TAB_MODULES = {
    erd: () => window.EveTabErd.init(),
    dicts: () => window.EveTabDicts.init(),
    overview: () => window.EveTabOverview.init(),
    universe: () => window.EveTabUniverse.init(),
    explorer: () => window.EveTabExplorer.init(),
  };

  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tabPanel === name));
    location.hash = name;
    const initFn = TAB_MODULES[name];
    if (initFn) initFn();
  }

  function openInExplorer(tableName) {
    switchTab("explorer");
    window.EveTabExplorer.openTable(tableName);
  }

  function initThemeToggle() {
    const btn = document.getElementById("theme-toggle");
    const stored = localStorage.getItem("eve_report_theme");
    if (stored) document.documentElement.setAttribute("data-theme", stored);
    btn.addEventListener("click", () => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const current = document.documentElement.getAttribute("data-theme") || (prefersDark ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("eve_report_theme", next);
    });
  }

  async function initSdeSubtitle() {
    const el = document.getElementById("sde-subtitle");
    try {
      const rows = await EveUtil.loadFull("_sde");
      const sde = rows[0] || {};
      el.textContent =
        "сборка " +
        sde.buildNumber +
        " · релиз " +
        (sde.releaseDate || "").slice(0, 10) +
        " · 79 таблиц · " +
        EveUtil.formatBytes(Object.values(window.EVE_META.tables).reduce((s, t) => s + t.bytes, 0));
    } catch (e) {
      el.textContent = "не удалось загрузить _sde.jsonl (см. предупреждение выше)";
    }
  }

  function init() {
    EveUtil.checkFileProtocolWarning();
    initThemeToggle();
    initSdeSubtitle();

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    const initial = (location.hash || "").replace("#", "");
    switchTab(TAB_MODULES[initial] ? initial : "erd");
  }

  window.EveApp = { switchTab, openInExplorer };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
