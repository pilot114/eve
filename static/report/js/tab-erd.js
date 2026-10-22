/* ===== Вкладка "ERD-диаграмма" ===== */
(function () {
  "use strict";

  const GROUP_ORDER = ["items", "universe", "npc", "content", "ships", "meta"];
  let initialized = false;
  let focusedTable = null;
  let compactMode = true;
  let hiddenGroups = new Set();
  let searchQuery = "";

  function relPos(el, root) {
    let x = 0,
      y = 0,
      node = el;
    while (node && node !== root) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function topLevelField(fieldPath) {
    return fieldPath.split(/[.\[]/)[0];
  }

  function buildFieldRelIndex(tableName, relations) {
    const idx = {};
    relations.forEach((r) => {
      if (r.from !== tableName) return;
      const top = topLevelField(r.field);
      (idx[top] = idx[top] || []).push(r);
    });
    return idx;
  }

  function typeLabel(types) {
    return types.join("/");
  }

  function typePillClass(types) {
    if (types.includes("i18n")) return "type-i18n";
    if (types.some((t) => t.startsWith("list"))) return "type-list";
    if (types.includes("obj")) return "type-obj";
    if (types.includes("int") || types.includes("float")) return "type-num";
    if (types.includes("bool")) return "type-bool";
    return "type-str";
  }

  function renderCard(name, meta, relations, incoming) {
    const g = window.EVE_META.groups[meta.group];
    const fieldRelIdx = buildFieldRelIndex(name, relations);
    const outgoing = relations.filter((r) => r.from === name);
    const card = document.createElement("div");
    card.className = "erd-card";
    card.id = "erd-card-" + name;
    card.style.setProperty("--accent-c", g.color);
    card.style.setProperty("--accent-c-dark", g.colorDark);
    card.dataset.table = name;
    card.dataset.group = meta.group;

    const header = document.createElement("div");
    header.className = "erd-card-header";
    header.innerHTML =
      '<span class="erd-card-name">' +
      name +
      "</span>" +
      '<span class="pill">' +
      EveUtil.formatNumber(meta.rows) +
      " стр." +
      "</span>";
    card.appendChild(header);

    if (meta.kv) {
      const kv = document.createElement("div");
      kv.className = "erd-card-kv";
      kv.textContent = meta.kv;
      card.appendChild(kv);
    }

    const fieldsWrap = document.createElement("div");
    fieldsWrap.className = "erd-card-fields";
    const allFields = meta.fields;
    const shown = compactMode ? allFields.slice(0, 8) : allFields;
    shown.forEach((f) => fieldsWrap.appendChild(renderFieldRow(name, f, fieldRelIdx)));
    card.appendChild(fieldsWrap);

    if (compactMode && allFields.length > 8) {
      const more = document.createElement("button");
      more.className = "erd-more-btn";
      more.textContent = "+" + (allFields.length - 8) + " ещё поле(й)";
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        allFields.slice(8).forEach((f) => fieldsWrap.appendChild(renderFieldRow(name, f, fieldRelIdx)));
        more.remove();
        layoutEdges();
      });
      card.appendChild(more);
    }

    const desc = document.createElement("div");
    desc.className = "erd-card-desc";
    desc.textContent = meta.desc;
    card.appendChild(desc);

    const relCount = document.createElement("div");
    relCount.className = "erd-card-relcount";
    relCount.textContent = "связей: исходящих " + outgoing.length + ", входящих " + incoming.length;
    card.appendChild(relCount);

    card.addEventListener("click", () => {
      setFocus(focusedTable === name ? null : name);
    });

    return card;
  }

  function renderFieldRow(tableName, field, fieldRelIdx) {
    const row = document.createElement("div");
    row.className = "erd-field-row";
    const isPk = field.name === "_key" || field.name === "_value";
    const rels = fieldRelIdx[field.name] || [];

    const nameEl = document.createElement("span");
    nameEl.className = "erd-field-name" + (isPk ? " is-pk" : "");
    nameEl.textContent = field.name;
    row.appendChild(nameEl);

    if (isPk) {
      const pk = document.createElement("span");
      pk.className = "badge badge-pk";
      pk.textContent = "PK";
      row.appendChild(pk);
    }

    const type = document.createElement("span");
    type.className = "erd-type-pill " + typePillClass(field.types);
    type.textContent = typeLabel(field.types);
    row.appendChild(type);

    rels.forEach((r) => {
      const chip = document.createElement("span");
      chip.className = "erd-fk-chip";
      chip.textContent = "→ " + r.to + (r.to === tableName ? " (self)" : "");
      chip.title = r.field + " → " + r.to + (r.note ? "  [" + r.note + "]" : "");
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (r.to !== tableName) setFocus(r.to);
      });
      row.appendChild(chip);
    });

    return row;
  }

  function edgeAnchor(sBox, tBox) {
    const sc = { x: sBox.x + sBox.w / 2, y: sBox.y + sBox.h / 2 };
    const tc = { x: tBox.x + tBox.w / 2, y: tBox.y + tBox.h / 2 };
    const dx = tc.x - sc.x,
      dy = tc.y - sc.y;
    let sx, sy, tx, ty, c1x, c1y, c2x, c2y;
    if (Math.abs(dy) >= Math.abs(dx)) {
      sx = sc.x;
      sy = dy > 0 ? sBox.y + sBox.h : sBox.y;
      tx = tc.x;
      ty = dy > 0 ? tBox.y : tBox.y + tBox.h;
      c1x = sx;
      c1y = sy + dy * 0.4;
      c2x = tx;
      c2y = ty - dy * 0.4;
    } else {
      sy = sc.y;
      sx = dx > 0 ? sBox.x + sBox.w : sBox.x;
      ty = tc.y;
      tx = dx > 0 ? tBox.x : tBox.x + tBox.w;
      c1x = sx + dx * 0.4;
      c1y = sy;
      c2x = tx - dx * 0.4;
      c2y = ty;
    }
    return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
  }

  let svgEl,
    rootEl,
    edgesData = [];

  function layoutEdges() {
    if (!svgEl || !rootEl) return;
    rootEl.style.height = "";
    const w = rootEl.scrollWidth,
      h = rootEl.scrollHeight;
    svgEl.setAttribute("width", w);
    svgEl.setAttribute("height", h);
    svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
    while (svgEl.lastChild) svgEl.removeChild(svgEl.lastChild);

    edgesData.forEach((edge) => {
      const sEl = document.getElementById("erd-card-" + edge.from);
      const tEl = document.getElementById("erd-card-" + edge.to);
      if (!sEl || !tEl || sEl.classList.contains("erd-hidden") || tEl.classList.contains("erd-hidden")) return;
      const sBox = relPos(sEl, rootEl);
      const tBox = relPos(tEl, rootEl);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", edgeAnchor(sBox, tBox));
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      const isActive = focusedTable && (edge.from === focusedTable || edge.to === focusedTable);
      path.setAttribute("class", "erd-edge" + (isActive ? " erd-edge-active" : focusedTable ? " erd-edge-dim" : ""));
      svgEl.appendChild(path);
    });
  }

  function setFocus(table) {
    focusedTable = table;
    const cards = rootEl.querySelectorAll(".erd-card");
    cards.forEach((c) => {
      c.classList.remove("erd-focused", "erd-neighbor", "erd-dimmed");
    });
    if (table) {
      const neighbors = new Set();
      edgesData.forEach((e) => {
        if (e.from === table) neighbors.add(e.to);
        if (e.to === table) neighbors.add(e.from);
      });
      cards.forEach((c) => {
        const n = c.dataset.table;
        if (n === table) c.classList.add("erd-focused");
        else if (neighbors.has(n)) c.classList.add("erd-neighbor");
        else c.classList.add("erd-dimmed");
      });
      renderDetailPanel(table);
      const el = document.getElementById("erd-card-" + table);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      document.getElementById("erd-detail").innerHTML = "";
    }
    layoutEdges();
  }

  function renderDetailPanel(table) {
    const meta = EveUtil.tableMeta(table);
    const relations = window.EVE_META.relations;
    const outgoing = relations.filter((r) => r.from === table);
    const incoming = relations.filter((r) => r.to === table && r.from !== table);
    const panel = document.getElementById("erd-detail");
    panel.innerHTML = "";
    const g = window.EVE_META.groups[meta.group];

    const head = EveUtil.el("div", { class: "erd-detail-head" }, [
      EveUtil.el("span", { class: "erd-detail-title", style: `color:${g.color}` }, table),
      EveUtil.el(
        "span",
        { class: "hint" },
        " · " + g.label + " · " + EveUtil.formatNumber(meta.rows) + " строк · " + EveUtil.formatBytes(meta.bytes),
      ),
      EveUtil.el(
        "button",
        { class: "icon-btn", style: "margin-left:auto", onclick: () => setFocus(null) },
        "✕ закрыть",
      ),
    ]);
    panel.appendChild(head);
    panel.appendChild(EveUtil.el("div", { class: "hint", style: "margin:4px 0 8px" }, meta.desc));

    const cols = EveUtil.el("div", { class: "erd-detail-cols" });
    const outCol = EveUtil.el("div", { class: "erd-detail-col" }, [
      EveUtil.el("h4", {}, "Исходящие связи (" + outgoing.length + ")"),
    ]);
    if (!outgoing.length) outCol.appendChild(EveUtil.el("div", { class: "hint" }, "нет"));
    outgoing.forEach((r) => {
      outCol.appendChild(
        EveUtil.el("div", { class: "erd-detail-row" }, [
          EveUtil.el("code", {}, r.field),
          " → ",
          EveUtil.el(
            "a",
            {
              href: "#",
              onclick: (e) => {
                e.preventDefault();
                setFocus(r.to);
              },
            },
            r.to,
          ),
          r.note ? EveUtil.el("span", { class: "hint" }, "  " + r.note) : null,
        ]),
      );
    });
    const inCol = EveUtil.el("div", { class: "erd-detail-col" }, [
      EveUtil.el("h4", {}, "Входящие связи (" + incoming.length + ")"),
    ]);
    if (!incoming.length) inCol.appendChild(EveUtil.el("div", { class: "hint" }, "нет"));
    incoming.forEach((r) => {
      inCol.appendChild(
        EveUtil.el("div", { class: "erd-detail-row" }, [
          EveUtil.el(
            "a",
            {
              href: "#",
              onclick: (e) => {
                e.preventDefault();
                setFocus(r.from);
              },
            },
            r.from,
          ),
          EveUtil.el("code", {}, r.field),
          " → эта таблица",
          r.note ? EveUtil.el("span", { class: "hint" }, "  " + r.note) : null,
        ]),
      );
    });
    cols.appendChild(outCol);
    cols.appendChild(inCol);
    panel.appendChild(cols);
  }

  function applyFilters() {
    const q = searchQuery.trim().toLowerCase();
    rootEl.querySelectorAll(".erd-card").forEach((c) => {
      const name = c.dataset.table;
      const group = c.dataset.group;
      const matchesSearch = !q || name.toLowerCase().includes(q);
      const groupVisible = !hiddenGroups.has(group);
      c.classList.toggle("erd-hidden", !(matchesSearch && groupVisible));
      c.classList.toggle("erd-search-dim", !!q && !matchesSearch);
    });
    rootEl.querySelectorAll(".erd-domain-section").forEach((sec) => {
      const anyVisible = sec.querySelectorAll(".erd-card:not(.erd-hidden)").length > 0;
      sec.style.display = anyVisible ? "" : "none";
    });
    layoutEdges();
  }

  function buildToolbar(container) {
    const bar = EveUtil.el("div", { class: "toolbar" });
    const search = EveUtil.el("input", {
      type: "search",
      placeholder: "Поиск таблицы…",
      style: "width:220px",
      oninput: EveUtil.debounce((e) => {
        searchQuery = e.target.value;
        applyFilters();
      }, 150),
    });
    bar.appendChild(search);

    const compactBtn = EveUtil.el("button", { class: "btn" }, "Свернуть/развернуть поля");
    compactBtn.addEventListener("click", () => {
      compactMode = !compactMode;
      rebuild();
    });
    bar.appendChild(compactBtn);

    const legend = EveUtil.el("div", { class: "erd-legend" });
    GROUP_ORDER.forEach((gk) => {
      const g = window.EVE_META.groups[gk];
      const count = Object.values(window.EVE_META.tables).filter((t) => t.group === gk).length;
      const chip = EveUtil.el("label", { class: "erd-legend-chip", style: `--c:${g.color};--c-dark:${g.colorDark}` }, [
        EveUtil.el("input", {
          type: "checkbox",
          checked: true,
          onchange: (e) => {
            if (e.target.checked) hiddenGroups.delete(gk);
            else hiddenGroups.add(gk);
            applyFilters();
          },
        }),
        EveUtil.el("span", { class: "erd-legend-dot" }),
        g.label + " (" + count + ")",
      ]);
      legend.appendChild(chip);
    });
    bar.appendChild(legend);
    container.appendChild(bar);
  }

  function rebuild() {
    const nodesWrap = document.getElementById("erd-nodes");
    nodesWrap.innerHTML = "";
    const relations = window.EVE_META.relations;
    const incomingCount = {};
    relations.forEach((r) => {
      incomingCount[r.to] = (incomingCount[r.to] || 0) + 1;
    });

    GROUP_ORDER.forEach((gk) => {
      const g = window.EVE_META.groups[gk];
      const names = Object.keys(window.EVE_META.tables)
        .filter((n) => window.EVE_META.tables[n].group === gk)
        .sort();
      const section = EveUtil.el("div", { class: "erd-domain-section" });
      section.appendChild(
        EveUtil.el(
          "h3",
          { class: "erd-domain-title", style: `color:${g.color}` },
          g.label + " · " + names.length + " табл.",
        ),
      );
      const grid = EveUtil.el("div", { class: "erd-domain-grid" });
      names.forEach((n) => {
        const incoming = relations.filter((r) => r.to === n && r.from !== n);
        grid.appendChild(renderCard(n, window.EVE_META.tables[n], relations, incoming));
      });
      section.appendChild(grid);
      nodesWrap.appendChild(section);
    });

    edgesData = [];
    const seen = new Set();
    relations.forEach((r) => {
      if (r.from === r.to) return;
      const key = r.from + "->" + r.to;
      if (seen.has(key)) return;
      seen.add(key);
      edgesData.push({ from: r.from, to: r.to });
    });

    applyFilters();
    setFocus(focusedTable);
    requestAnimationFrame(layoutEdges);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const panel = document.getElementById("tab-erd");

    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "ERD-диаграмма: сущности, поля и связи"));
    panel.appendChild(
      EveUtil.el(
        "div",
        { class: "hint", style: "margin-bottom:10px" },
        "79 таблиц датасета сгруппированы по смысловым доменам. Клик по карточке подсвечивает её связи и открывает панель с точными путями полей. " +
          "Фиолетовая метка PK — первичный ключ (_key), синие бейджи «→ таблица» — внешние ссылки.",
      ),
    );

    buildToolbar(panel);
    panel.appendChild(EveUtil.el("div", { id: "erd-detail", class: "erd-detail card" }));

    rootEl = EveUtil.el("div", { id: "erd-root" });
    svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute("id", "erd-edges");
    rootEl.appendChild(svgEl);
    const nodesWrap = EveUtil.el("div", { id: "erd-nodes" });
    rootEl.appendChild(nodesWrap);
    panel.appendChild(rootEl);

    rebuild();

    window.addEventListener("resize", EveUtil.debounce(layoutEdges, 200));
    new ResizeObserver(EveUtil.debounce(layoutEdges, 120)).observe(rootEl);
  }

  window.EveTabErd = { init };
})();
