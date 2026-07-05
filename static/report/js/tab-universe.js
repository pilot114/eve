/* ===== Вкладка "Вселенная" (Регион → Созвездие → Система) ===== */
(function () {
  "use strict";

  let initialized = false;
  let loaded = false;
  let data = null; // { regions, constellations, systems, stargates, stars, factions, byId maps }
  const celestialCache = new Map();

  function rgbToHex(rgb) { return "#" + rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join(""); }
  const SEC_RED = [227, 73, 72], SEC_MID = [220, 219, 214], SEC_BLUE = [42, 120, 214];
  function secColor(sec) {
    sec = Math.max(-1, Math.min(1, sec ?? 0));
    const t = sec <= 0 ? sec + 1 : sec;
    const from = sec <= 0 ? SEC_RED : SEC_MID;
    const to = sec <= 0 ? SEC_MID : SEC_BLUE;
    return from.map((f, i) => f + (to[i] - f) * t);
  }
  function secChipStyle(sec) {
    const rgb = secColor(sec);
    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const ink = lum > 150 ? "#111" : "#fff";
    return `background:${rgbToHex(rgb)};color:${ink}`;
  }

  function name(obj) {
    return EveUtil.pickI18n(obj.name, EveUtil.getLang()) || "(без имени)";
  }

  async function ensureLoaded(onStatus) {
    if (loaded) return;
    onStatus("Загрузка регионов…");
    const [regions, constellations, systems, stargates, stars, factions] = await Promise.all([
      EveUtil.loadFull("mapRegions"),
      (onStatus("Загрузка созвездий…"), EveUtil.loadFull("mapConstellations")),
      (onStatus("Загрузка солнечных систем (~5 МБ)…"), EveUtil.loadFull("mapSolarSystems")),
      (onStatus("Загрузка врат…"), EveUtil.loadFull("mapStargates")),
      (onStatus("Загрузка звёзд…"), EveUtil.loadFull("mapStars")),
      (onStatus("Загрузка фракций…"), EveUtil.loadFull("factions")),
    ]);
    const byId = (arr) => Object.fromEntries(arr.map((x) => [x._key, x]));
    data = {
      regions, constellations, systems, stargates, stars, factions,
      regionsById: byId(regions),
      constellationsById: byId(constellations),
      systemsById: byId(systems),
      stargatesById: byId(stargates),
      starsById: byId(stars),
      factionsById: byId(factions),
    };
    loaded = true;
  }

  function factionBadge(factionID) {
    if (!factionID || !data.factionsById[factionID]) return null;
    return EveUtil.el("span", { class: "pill uni-faction-pill" }, name(data.factionsById[factionID]));
  }

  /* ---------- lazy browse tree ---------- */

  function renderSystemRow(sys) {
    const row = EveUtil.el("div", { class: "uni-system-row", onclick: () => selectSystem(sys._key) }, [
      EveUtil.el("span", { class: "uni-sec-chip", style: secChipStyle(sys.securityStatus) }, (sys.securityStatus ?? 0).toFixed(1)),
      EveUtil.el("span", { class: "uni-sys-name" }, name(sys)),
      sys.hub ? EveUtil.el("span", { class: "pill" }, "hub") : null,
      EveUtil.el("span", { class: "hint" }, (sys.planetIDs || []).length + " планет · " + (sys.stargateIDs || []).length + " врат"),
    ]);
    row.dataset.sysId = sys._key;
    return row;
  }

  function renderConstellation(cst) {
    const det = document.createElement("details");
    det.className = "uni-constellation";
    const sysIds = cst.solarSystemIDs || [];
    const summary = EveUtil.el("summary", {}, [
      EveUtil.el("span", { class: "uni-name" }, name(cst)),
      factionBadge(cst.factionID),
      EveUtil.el("span", { class: "hint" }, sysIds.length + " систем"),
    ]);
    det.appendChild(summary);
    let rendered = false;
    det.addEventListener("toggle", () => {
      if (det.open && !rendered) {
        rendered = true;
        const list = EveUtil.el("div", { class: "uni-system-list" });
        sysIds
          .map((id) => data.systemsById[id])
          .filter(Boolean)
          .sort((a, b) => name(a).localeCompare(name(b), "ru"))
          .forEach((sys) => list.appendChild(renderSystemRow(sys)));
        det.appendChild(list);
      }
    });
    return det;
  }

  function renderRegion(reg) {
    const det = document.createElement("details");
    det.className = "uni-region";
    const cstIds = reg.constellationIDs || [];
    const sysCount = cstIds.reduce((s, id) => s + ((data.constellationsById[id] || {}).solarSystemIDs || []).length, 0);
    const summary = EveUtil.el("summary", {}, [
      EveUtil.el("span", { class: "uni-name uni-region-name" }, name(reg)),
      factionBadge(reg.factionID),
      EveUtil.el("span", { class: "hint" }, cstIds.length + " созвездий · " + sysCount + " систем"),
    ]);
    det.appendChild(summary);
    let rendered = false;
    det.addEventListener("toggle", () => {
      if (det.open && !rendered) {
        rendered = true;
        cstIds
          .map((id) => data.constellationsById[id])
          .filter(Boolean)
          .sort((a, b) => name(a).localeCompare(name(b), "ru"))
          .forEach((cst) => det.appendChild(renderConstellation(cst)));
      }
    });
    return det;
  }

  function renderTree() {
    const tree = document.getElementById("uni-tree");
    tree.innerHTML = "";
    data.regions
      .slice()
      .sort((a, b) => name(a).localeCompare(name(b), "ru"))
      .forEach((reg) => tree.appendChild(renderRegion(reg)));
  }

  /* ---------- search ---------- */

  function runSearch(q) {
    const tree = document.getElementById("uni-tree");
    const results = document.getElementById("uni-search-results");
    q = q.trim().toLowerCase();
    if (!q) {
      tree.style.display = "";
      results.style.display = "none";
      results.innerHTML = "";
      return;
    }
    tree.style.display = "none";
    results.style.display = "";
    results.innerHTML = "";
    const matches = data.systems.filter((s) => name(s).toLowerCase().includes(q)).slice(0, 300);
    results.appendChild(EveUtil.el("div", { class: "hint", style: "margin-bottom:6px" }, "Найдено систем: " + matches.length + (matches.length === 300 ? " (показаны первые 300)" : "")));
    matches.forEach((sys) => {
      const cst = data.constellationsById[sys.constellationID];
      const reg = cst ? data.regionsById[cst.regionID] : null;
      const row = EveUtil.el("div", { class: "uni-system-row", onclick: () => selectSystem(sys._key) }, [
        EveUtil.el("span", { class: "uni-sec-chip", style: secChipStyle(sys.securityStatus) }, (sys.securityStatus ?? 0).toFixed(1)),
        EveUtil.el("span", { class: "uni-sys-name" }, name(sys)),
        EveUtil.el("span", { class: "hint" }, (reg ? name(reg) : "?") + " / " + (cst ? name(cst) : "?")),
      ]);
      results.appendChild(row);
    });
  }

  /* ---------- system detail panel ---------- */

  async function selectSystem(sysId) {
    const sys = data.systemsById[sysId];
    if (!sys) return;
    const panel = document.getElementById("uni-detail");
    panel.innerHTML = "";
    const cst = data.constellationsById[sys.constellationID];
    const reg = cst ? data.regionsById[cst.regionID] : null;
    const star = data.starsById[sys.starID];

    panel.appendChild(EveUtil.el("div", { class: "uni-detail-head" }, [
      EveUtil.el("span", { class: "uni-detail-title" }, name(sys)),
      EveUtil.el("span", { class: "uni-sec-chip", style: secChipStyle(sys.securityStatus) }, (sys.securityStatus ?? 0).toFixed(3)),
    ]));
    panel.appendChild(EveUtil.el("div", { class: "hint", style: "margin-bottom:8px" },
      (reg ? name(reg) : "?") + " / " + (cst ? name(cst) : "?") + (sys.factionID && data.factionsById[sys.factionID] ? " · " + name(data.factionsById[sys.factionID]) : "")));

    const flags = ["hub", "border", "corridor", "regional", "international", "fringe"].filter((f) => sys[f]);
    if (flags.length) panel.appendChild(EveUtil.el("div", { style: "margin-bottom:8px" }, flags.map((f) => EveUtil.el("span", { class: "pill", style: "margin-right:4px" }, f))));

    if (star) {
      panel.appendChild(EveUtil.el("div", { class: "uni-kv" }, "Звезда: typeID=" + star.typeID + ", радиус=" + EveUtil.formatNumber(star.radius) + " м" +
        (star.statistics ? ", класс " + star.statistics.spectralClass : "")));
    }

    const gates = (sys.stargateIDs || []).map((id) => data.stargatesById[id]).filter(Boolean);
    if (gates.length) {
      const gwrap = EveUtil.el("div", { class: "uni-kv" }, "Врата (" + gates.length + "):");
      const list = EveUtil.el("div", { style: "margin:4px 0 8px" });
      gates.forEach((g) => {
        const destSys = g.destination && data.systemsById[g.destination.solarSystemID];
        if (destSys) {
          list.appendChild(EveUtil.el("div", {}, [
            "→ ",
            EveUtil.el("a", { href: "#", onclick: (e) => { e.preventDefault(); selectSystem(destSys._key); } }, name(destSys)),
          ]));
        }
      });
      panel.appendChild(gwrap);
      panel.appendChild(list);
    }

    panel.appendChild(EveUtil.el("div", { class: "uni-kv" }, "Планет: " + (sys.planetIDs || []).length));

    const loadBtn = EveUtil.el("button", { class: "btn primary", style: "margin-top:6px" }, "Загрузить небесные тела (планеты, луны, пояса)");
    const bodyWrap = EveUtil.el("div", { id: "uni-bodies", style: "margin-top:10px" });
    panel.appendChild(loadBtn);
    panel.appendChild(bodyWrap);

    if (celestialCache.has(sysId)) {
      renderCelestialBodies(bodyWrap, celestialCache.get(sysId));
      loadBtn.style.display = "none";
    } else {
      loadBtn.addEventListener("click", async () => {
        loadBtn.disabled = true;
        bodyWrap.innerHTML = "";
        const status = EveUtil.el("div", { class: "hint" }, "Сканирование больших файлов (mapPlanets, mapAsteroidBelts, mapMoons)… это может занять несколько секунд.");
        bodyWrap.appendChild(status);
        const progress = { planets: 0, belts: 0, moons: 0 };
        const updateStatus = () => {
          status.textContent = `Сканирование… planets ${EveUtil.formatBytes(progress.planets)}, belts ${EveUtil.formatBytes(progress.belts)}, moons ${EveUtil.formatBytes(progress.moons)}`;
        };
        const scanFor = async (table, progKey) => {
          const matches = [];
          let sinceMatch = 0;
          await EveUtil.scanFile(table, {
            onProgress: (bytes) => { progress[progKey] = bytes; updateStatus(); },
            onObject(obj) {
              if (obj.solarSystemID === sysId) { matches.push(obj); sinceMatch = 0; }
              else if (matches.length) { sinceMatch++; if (sinceMatch > 6000) return false; }
            },
          });
          return matches;
        };
        const [planets, belts, moons] = await Promise.all([
          scanFor("mapPlanets", "planets"),
          scanFor("mapAsteroidBelts", "belts"),
          scanFor("mapMoons", "moons"),
        ]);
        const result = { planets, belts, moons };
        celestialCache.set(sysId, result);
        loadBtn.style.display = "none";
        renderCelestialBodies(bodyWrap, result);
      });
    }
  }

  function renderCelestialBodies(container, { planets, belts, moons }) {
    container.innerHTML = "";
    container.appendChild(EveUtil.el("div", { class: "hint", style: "margin-bottom:6px" },
      "Планет: " + planets.length + " · Лун: " + moons.length + " · Астероидных поясов: " + belts.length));
    planets
      .slice()
      .sort((a, b) => (a.celestialIndex || 0) - (b.celestialIndex || 0))
      .forEach((p) => {
        const pMoons = moons.filter((m) => (p.moonIDs || []).includes(m._key));
        const pBelts = belts.filter((b) => (p.asteroidBeltIDs || []).includes(b._key));
        const row = EveUtil.el("details", { class: "uni-planet" }, [
          EveUtil.el("summary", {}, "Планета " + (p.celestialIndex ?? "?") + " · typeID=" + p.typeID +
            "  (" + pMoons.length + " лун, " + pBelts.length + " поясов)"),
        ]);
        if (pMoons.length || pBelts.length) {
          const inner = EveUtil.el("div", { style: "padding:4px 0 4px 16px; font-size:12px;" });
          pMoons.forEach((m) => inner.appendChild(EveUtil.el("div", {}, "🌕 луна · typeID=" + m.typeID + (m.npcStationIDs?.length ? " · станций: " + m.npcStationIDs.length : ""))));
          pBelts.forEach((b) => inner.appendChild(EveUtil.el("div", {}, "🪨 астероидный пояс · typeID=" + b.typeID)));
          row.appendChild(inner);
        }
        container.appendChild(row);
      });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const panel = document.getElementById("tab-universe");
    panel.appendChild(EveUtil.el("h2", { class: "section-title" }, "Вселенная: регионы → созвездия → системы"));
    panel.appendChild(EveUtil.el("div", { class: "hint", style: "margin-bottom:10px" },
      "Иерархия строится из mapRegions/mapConstellations/mapSolarSystems (загружаются целиком, ~10 МБ). " +
      "Планеты/луны/астероидные пояса подгружаются потоково по клику отдельно для каждой системы, " +
      "т.к. mapMoons.jsonl — самый большой файл датасета (224 МБ)."));

    const status = EveUtil.el("div", { class: "card" }, "Загрузка карты вселенной…");
    panel.appendChild(status);

    ensureLoaded((msg) => { status.textContent = msg; }).then(() => {
      status.remove();

      const layout = EveUtil.el("div", { class: "uni-layout" });
      const leftCol = EveUtil.el("div", { class: "uni-left" });
      const search = EveUtil.el("input", {
        type: "search", placeholder: "Поиск системы по имени…", style: "width:100%; margin-bottom:8px",
        oninput: EveUtil.debounce((e) => runSearch(e.target.value), 150),
      });
      leftCol.appendChild(search);
      leftCol.appendChild(EveUtil.el("div", { id: "uni-tree", class: "uni-tree" }));
      leftCol.appendChild(EveUtil.el("div", { id: "uni-search-results", class: "uni-tree", style: "display:none" }));
      layout.appendChild(leftCol);

      layout.appendChild(EveUtil.el("div", { id: "uni-detail", class: "uni-detail card" }, EveUtil.el("div", { class: "hint" }, "Выберите систему слева")));
      panel.appendChild(layout);

      renderTree();
    }).catch((e) => {
      status.textContent = "Ошибка загрузки: " + e.message;
    });
  }

  window.EveTabUniverse = { init };
})();
