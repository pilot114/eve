/* ===== Вкладка "Просмотр данных" (генерик-эксплорер по всем 79 таблицам) ===== */
(function () {
  "use strict";

  let initialized = false;
  let reader = null;
  let currentTable = null;
  let loadedItems = [];
  let rowFilter = "";

  function makeLineReader(table) {
    const url = EveUtil.fileUrl(table);
    let netReader = null,
      decoder = new TextDecoder("utf-8"),
      buffer = "",
      done = false,
      started = false;
    let bytesRead = 0,
      totalBytes = null;
    async function start() {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status + " при загрузке " + url);
      totalBytes = Number(resp.headers.get("content-length")) || null;
      netReader = resp.body.getReader();
      started = true;
    }
    async function next(count) {
      if (!started) await start();
      const lines = [];
      while (lines.length < count) {
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1 && lines.length < count) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.trim()) lines.push(line);
        }
        if (lines.length >= count) break;
        if (done) break;
        const { value, done: d } = await netReader.read();
        if (d) {
          done = true;
          if (buffer.trim()) {
            lines.push(buffer);
            buffer = "";
          }
          break;
        }
        bytesRead += value.length;
        buffer += decoder.decode(value, { stream: true });
      }
      return { lines, finished: done && buffer.length === 0, bytesRead, totalBytes };
    }
    function cancel() {
      if (netReader) netReader.cancel().catch(() => {});
    }
    return { next, cancel };
  }

  function buildSelect() {
    const select = document.createElement("select");
    select.id = "exp-table-select";
    const groups = ["items", "universe", "npc", "content", "ships", "meta"];
    groups.forEach((gk) => {
      const g = window.EVE_META.groups[gk];
      const og = document.createElement("optgroup");
      og.label = g.label;
      Object.keys(window.EVE_META.tables)
        .filter((n) => window.EVE_META.tables[n].group === gk)
        .sort()
        .forEach((n) => {
          const meta = window.EVE_META.tables[n];
          const opt = document.createElement("option");
          opt.value = n;
          opt.textContent =
            n + "  (" + EveUtil.formatNumber(meta.rows) + " стр., " + EveUtil.formatBytes(meta.bytes) + ")";
          og.appendChild(opt);
        });
      select.appendChild(og);
    });
    return select;
  }

  function columnsFor(items) {
    const meta = window.EVE_META.tables[currentTable];
    const ordered = meta.fields.map((f) => f.name);
    const seen = new Set(ordered);
    items.forEach((it) =>
      Object.keys(it).forEach((k) => {
        if (!seen.has(k)) {
          seen.add(k);
          ordered.push(k);
        }
      }),
    );
    return ordered;
  }

  function renderTable() {
    const wrap = document.getElementById("exp-table-wrap");
    wrap.innerHTML = "";
    if (!loadedItems.length) {
      wrap.appendChild(EveUtil.el("div", { class: "hint" }, "Нет данных для отображения."));
      return;
    }
    const cols = columnsFor(loadedItems);
    const table = EveUtil.el("table", { class: "data-table" });
    const thead = EveUtil.el(
      "thead",
      {},
      EveUtil.el("tr", {}, [EveUtil.el("th", {}, "#"), ...cols.map((c) => EveUtil.el("th", {}, c))]),
    );
    const tbody = document.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    const lang = EveUtil.getLang();
    loadedItems.forEach((item, i) => {
      const tr = document.createElement("tr");
      tr.dataset.search = JSON.stringify(item).toLowerCase();
      const idxTd = document.createElement("td");
      idxTd.innerHTML =
        i +
        1 +
        " <details><summary>JSON</summary><pre>" +
        EveUtil.escapeHtml(JSON.stringify(item, null, 2)) +
        "</pre></details>";
      tr.appendChild(idxTd);
      cols.forEach((c) => {
        const td = document.createElement("td");
        td.innerHTML = EveUtil.cellHtml(item[c], lang);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    wrap.appendChild(table);
    EveUtil.makeSortable(table);
    applyRowFilter();
  }

  function applyRowFilter() {
    const q = rowFilter.trim().toLowerCase();
    const tbody = document.querySelector("#exp-table-wrap tbody");
    if (!tbody) return;
    let visible = 0;
    Array.from(tbody.rows).forEach((tr) => {
      const ok = !q || tr.dataset.search.includes(q);
      tr.style.display = ok ? "" : "none";
      if (ok) visible++;
    });
    const hint = document.getElementById("exp-count-hint");
    if (hint) hint.textContent = "показано " + visible + " из " + loadedItems.length + " загруженных строк";
  }

  async function loadTable(table, count) {
    if (reader) {
      reader.cancel();
      reader = null;
    }
    currentTable = table;
    loadedItems = [];
    rowFilter = "";
    document.getElementById("exp-row-filter").value = "";
    const meta = window.EVE_META.tables[table];
    document.getElementById("exp-meta-hint").innerHTML =
      "<b>" +
      table +
      "</b> · " +
      meta.desc +
      "<br>" +
      EveUtil.formatNumber(meta.rows) +
      " строк всего, файл " +
      EveUtil.formatBytes(meta.bytes) +
      (meta.bytes > 5 * 1024 * 1024 ? " — файл большой, загружается только начало потоково." : "");
    document.getElementById("exp-table-wrap").innerHTML = '<div class="hint">Загрузка…</div>';
    reader = makeLineReader(table);
    await loadMore(count);
  }

  async function loadMore(count) {
    if (!reader) return;
    const loadMoreBtn = document.getElementById("exp-load-more");
    loadMoreBtn.disabled = true;
    const { lines, finished } = await reader.next(count);
    lines.forEach((line) => {
      try {
        loadedItems.push(JSON.parse(line));
      } catch (e) {
        /* skip malformed */
      }
    });
    renderTable();
    loadMoreBtn.disabled = finished;
    loadMoreBtn.textContent = finished ? "Файл прочитан полностью" : "Загрузить ещё " + count;
    document.getElementById("exp-count-hint").textContent =
      "загружено " + loadedItems.length + " строк" + (finished ? " (весь файл)" : "");
  }

  function openTable(name) {
    const select = document.getElementById("exp-table-select");
    if (!select) return;
    select.value = name;
    const count = parseInt(document.getElementById("exp-count-input").value, 10) || 50;
    loadTable(name, count);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const panel = document.getElementById("tab-explorer");
    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "Просмотр данных: любая из 79 таблиц"));
    panel.appendChild(
      EveUtil.el(
        "div",
        { class: "hint", style: "margin-bottom:10px" },
        "Файлы читаются потоково (fetch + ReadableStream): загружается только запрошенное число строк, " +
          "даже если файл весит сотни мегабайт (mapMoons.jsonl — 224 МБ). Кнопка «Загрузить ещё» продолжает чтение с того же места.",
      ),
    );

    const toolbar = EveUtil.el("div", { class: "toolbar" });
    const select = buildSelect();
    toolbar.appendChild(select);
    toolbar.appendChild(EveUtil.el("span", { class: "hint" }, "строк:"));
    const countInput = EveUtil.el("input", {
      id: "exp-count-input",
      type: "number",
      min: "1",
      max: "5000",
      value: "50",
      style: "width:80px",
    });
    toolbar.appendChild(countInput);
    const loadBtn = EveUtil.el("button", { class: "btn primary" }, "Загрузить");
    loadBtn.addEventListener("click", () => loadTable(select.value, parseInt(countInput.value, 10) || 50));
    toolbar.appendChild(loadBtn);
    const loadMoreBtn = EveUtil.el("button", { id: "exp-load-more", class: "btn", disabled: true }, "Загрузить ещё");
    loadMoreBtn.addEventListener("click", () => loadMore(parseInt(countInput.value, 10) || 50));
    toolbar.appendChild(loadMoreBtn);
    panel.appendChild(toolbar);

    const toolbar2 = EveUtil.el("div", { class: "toolbar" });
    const rowFilterInput = EveUtil.el("input", {
      id: "exp-row-filter",
      type: "search",
      placeholder: "Фильтр по загруженным строкам…",
      style: "width:260px",
      oninput: EveUtil.debounce((e) => {
        rowFilter = e.target.value;
        applyRowFilter();
      }, 150),
    });
    toolbar2.appendChild(rowFilterInput);
    let langSelect = EveUtil.el(
      "select",
      {
        onchange: (e) => {
          EveUtil.setLang(e.target.value);
          renderTable();
        },
      },
      EveUtil.LANG_ORDER.map((l) =>
        EveUtil.el("option", { value: l, selected: l === EveUtil.getLang() }, EveUtil.LANG_LABELS[l]),
      ),
    );
    toolbar2.appendChild(EveUtil.el("span", { class: "hint" }, "язык i18n:"));
    toolbar2.appendChild(langSelect);
    toolbar2.appendChild(EveUtil.el("span", { class: "hint", id: "exp-count-hint" }, ""));
    panel.appendChild(toolbar2);

    panel.appendChild(
      EveUtil.el("div", { id: "exp-meta-hint", class: "card", style: "margin-bottom:10px; font-size:12.5px" }),
    );
    panel.appendChild(
      EveUtil.el(
        "div",
        { id: "exp-table-wrap", class: "data-table-wrap" },
        EveUtil.el("div", { class: "hint" }, "Выберите таблицу и нажмите «Загрузить»."),
      ),
    );

    loadTable(select.value, 50);
  }

  window.EveTabExplorer = { init, openTable };
})();
