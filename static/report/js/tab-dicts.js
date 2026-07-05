/* ===== Вкладка "Справочники (<100 строк)" ===== */
(function () {
  "use strict";

  const SMALL_LIMIT = 100;
  let initialized = false;
  let currentTable = null;
  let rowFilter = "";

  function smallTables() {
    return Object.keys(window.EVE_META.tables)
      .filter((n) => window.EVE_META.tables[n].rows < SMALL_LIMIT)
      .sort((a, b) => window.EVE_META.tables[a].rows - window.EVE_META.tables[b].rows);
  }

  function hasI18nField(meta) {
    return meta.fields.some((f) => f.types.includes("i18n"));
  }

  function buildList(container, listFilter) {
    container.innerHTML = "";
    const q = listFilter.trim().toLowerCase();
    smallTables().forEach((name) => {
      const meta = window.EVE_META.tables[name];
      if (q && !name.toLowerCase().includes(q) && !meta.desc.toLowerCase().includes(q)) return;
      const g = window.EVE_META.groups[meta.group];
      const item = EveUtil.el(
        "div",
        {
          class: "dict-list-item" + (name === currentTable ? " active" : ""),
          style: `--c:${g.color};--c-dark:${g.colorDark}`,
          onclick: () => selectTable(name),
        },
        [
          EveUtil.el("span", { class: "dict-list-dot" }),
          EveUtil.el("span", { class: "dict-list-name" }, name),
          EveUtil.el("span", { class: "pill" }, String(meta.rows)),
        ]
      );
      container.appendChild(item);
    });
  }

  async function selectTable(name) {
    currentTable = name;
    rowFilter = "";
    buildList(document.getElementById("dict-list"), document.getElementById("dict-list-search").value);
    await renderDetail(name);
  }

  async function renderDetail(name) {
    const detail = document.getElementById("dict-detail");
    const meta = window.EVE_META.tables[name];
    const g = window.EVE_META.groups[meta.group];
    detail.innerHTML = "";

    const head = EveUtil.el("div", { class: "dict-detail-head" }, [
      EveUtil.el("span", { class: "dict-detail-title", style: `color:${g.color}` }, name),
      EveUtil.el("span", { class: "pill" }, g.label),
      EveUtil.el("span", { class: "hint" }, EveUtil.formatNumber(meta.rows) + " строк · " + EveUtil.formatBytes(meta.bytes)),
    ]);
    detail.appendChild(head);
    detail.appendChild(EveUtil.el("div", { class: "hint", style: "margin:4px 0 10px" }, meta.desc));
    if (meta.kv) {
      detail.appendChild(EveUtil.el("div", { class: "dict-kv-note" }, "Формат ключ-значение: " + meta.kv));
    }

    const toolbar = EveUtil.el("div", { class: "toolbar" });
    const filterInput = EveUtil.el("input", {
      type: "search", placeholder: "Фильтр по строкам…", style: "width:220px",
      oninput: EveUtil.debounce((e) => {
        rowFilter = e.target.value.trim().toLowerCase();
        applyRowFilter(tbody, meta.fields, lang());
      }, 150),
    });
    toolbar.appendChild(filterInput);

    let langSelect = null;
    if (hasI18nField(meta)) {
      langSelect = EveUtil.el(
        "select",
        {
          onchange: (e) => {
            EveUtil.setLang(e.target.value);
            renderRows(tbody, cache, meta.fields);
            applyRowFilter(tbody, meta.fields, lang());
          },
        },
        EveUtil.LANG_ORDER.map((l) => EveUtil.el("option", { value: l, selected: l === EveUtil.getLang() }, EveUtil.LANG_LABELS[l]))
      );
      toolbar.appendChild(EveUtil.el("span", { class: "hint" }, "язык:"));
      toolbar.appendChild(langSelect);
    }
    toolbar.appendChild(EveUtil.el("span", { class: "hint", id: "dict-count-hint" }, ""));
    detail.appendChild(toolbar);

    const wrap = EveUtil.el("div", { class: "data-table-wrap" });
    const table = EveUtil.el("table", { class: "data-table" });
    const thead = EveUtil.el("thead", {}, EveUtil.el("tr", {}, meta.fields.map((f) => {
      const numeric = f.types.some((t) => t === "int" || t === "float");
      return EveUtil.el("th", { class: numeric ? "num" : undefined }, f.name);
    })));
    const tbody = EveUtil.el("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    detail.appendChild(wrap);

    function lang() { return EveUtil.getLang(); }

    tbody.appendChild(EveUtil.el("tr", {}, EveUtil.el("td", { colspan: meta.fields.length }, "Загрузка…")));

    let cache = [];
    try {
      cache = await EveUtil.loadFull(name);
    } catch (e) {
      tbody.innerHTML = "";
      tbody.appendChild(EveUtil.el("tr", {}, EveUtil.el("td", { colspan: meta.fields.length }, "Ошибка загрузки: " + e.message)));
      return;
    }
    renderRows(tbody, cache, meta.fields);
    EveUtil.makeSortable(table);
    applyRowFilter(tbody, meta.fields, lang());
  }

  function renderRows(tbody, items, fields) {
    tbody.innerHTML = "";
    const lang = EveUtil.getLang();
    items.forEach((item) => {
      const tr = document.createElement("tr");
      fields.forEach((f) => {
        const td = document.createElement("td");
        const v = item[f.name];
        td.innerHTML = EveUtil.cellHtml(v, lang);
        if (typeof v === "number") { td.classList.add("num"); td.dataset.sort = v; }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function applyRowFilter(tbody) {
    const q = rowFilter;
    let visible = 0;
    Array.from(tbody.rows).forEach((tr) => {
      const match = !q || tr.textContent.toLowerCase().includes(q);
      tr.style.display = match ? "" : "none";
      if (match) visible++;
    });
    const hint = document.getElementById("dict-count-hint");
    if (hint) hint.textContent = "показано " + visible + " из " + tbody.rows.length;
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const panel = document.getElementById("tab-dicts");

    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "Небольшие справочники (< 100 строк)"));
    panel.appendChild(EveUtil.el("div", { class: "hint", style: "margin-bottom:10px" },
      smallTables().length + " таблиц из 79 содержат меньше 100 строк — это словари/перечисления, " +
      "которые удобно смотреть целиком одной таблицей. Выберите таблицу слева."));

    const layout = EveUtil.el("div", { class: "dict-layout" });

    const listCol = EveUtil.el("div", { class: "dict-list-col" });
    const listSearch = EveUtil.el("input", {
      id: "dict-list-search", type: "search", placeholder: "Поиск…", style: "width:100%; margin-bottom:8px",
      oninput: EveUtil.debounce((e) => buildList(document.getElementById("dict-list"), e.target.value), 120),
    });
    listCol.appendChild(listSearch);
    listCol.appendChild(EveUtil.el("div", { id: "dict-list", class: "dict-list" }));
    layout.appendChild(listCol);

    layout.appendChild(EveUtil.el("div", { id: "dict-detail", class: "dict-detail card" }, EveUtil.el("div", { class: "hint" }, "Выберите таблицу слева")));

    panel.appendChild(layout);

    buildList(document.getElementById("dict-list"), "");
    const first = smallTables()[0];
    if (first) selectTable(first);
  }

  window.EveTabDicts = { init };
})();
