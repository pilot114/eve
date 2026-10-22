// Минимальный загрузчик дашборда: читает data.json и заполняет страницу.
// Без зависимостей — только нативный fetch и DOM.

const $ = (id) => document.getElementById(id);
let serverStart = null; // время старта сервера, чтобы тикал аптайм

const STATUS = {
  online: { text: "Сервер онлайн", cls: "badge--ok" },
  vip: { text: "Режим VIP", cls: "badge--warn" },
  offline: { text: "Сервер недоступен", cls: "badge--err" },
};

const fmtNum = (n) => (n == null ? "—" : n.toLocaleString("ru-RU"));

const fmtIsk = (n) => (n == null ? "—" : Math.round(n).toLocaleString("ru-RU") + " ISK");

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
}

function ago(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return s + " сек назад";
  if (s < 3600) return Math.floor(s / 60) + " мин назад";
  return Math.floor(s / 3600) + " ч назад";
}

function fmtUptime(startIso) {
  const start = new Date(startIso);
  if (isNaN(start)) return "—";
  let s = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${h}ч ${String(m).padStart(2, "0")}м ${String(s).padStart(2, "0")}с`;
}

function renderNews(items) {
  const ul = $("news-list");
  ul.innerHTML = "";
  if (!items || !items.length) {
    ul.innerHTML = '<li class="news-empty">Новостей пока нет.</li>';
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "news-item";

    const a = document.createElement("a");
    a.href = it.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = it.title;

    const date = document.createElement("span");
    date.className = "news-date";
    date.textContent = fmtDate(it.date);

    li.append(a, date);
    ul.appendChild(li);
  }
}

// --- Графики истории -------------------------------------------------------

// Метрики, для которых рисуем график. fmt — формат подписей по оси Y.
const CHARTS = [
  {
    key: "players",
    id: "chart-players",
    color: "#4ea1ff",
    label: "Игроки онлайн",
    fmt: (v) => Math.round(v).toLocaleString("ru-RU"),
  },
  {
    key: "plex",
    id: "chart-plex",
    color: "#d29922",
    label: "Цена PLEX",
    fmt: (v) => (v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " млн",
  },
  {
    key: "incursions",
    id: "chart-incursions",
    color: "#3fb950",
    label: "Инкурсии",
    fmt: (v) => Math.round(v).toLocaleString("ru-RU"),
  },
  {
    key: "sov",
    id: "chart-sov",
    color: "#a371f7",
    label: "Sov-кампании",
    fmt: (v) => Math.round(v).toLocaleString("ru-RU"),
  },
];

const hhmm = (t) => new Date(t * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

// Строит inline-SVG линейный график из массива точек. Без библиотек.
// Возвращает { html, attach(container) }: attach навешивает интерактив
// (наведение курсора показывает значение в точке) уже после вставки в DOM.
function buildChart(points, cfg) {
  const pts = points.filter((p) => p[cfg.key] != null);
  if (!pts.length) {
    return { html: '<div class="chart-empty">Пока нет данных — график появится по мере сбора.</div>', attach() {} };
  }

  const W = 640,
    H = 206,
    padL = 52,
    padR = 14,
    padT = 14,
    padB = 32;
  const plotW = W - padL - padR,
    plotH = H - padT - padB,
    baseY = H - padB;

  const ys = pts.map((p) => Number(p[cfg.key]));
  let min = Math.min(...ys),
    max = Math.max(...ys);
  if (min === max) {
    min -= 1;
    max += 1;
  } // плоский ряд — раздвигаем, чтобы была шкала
  const t0 = pts[0].t,
    t1 = pts[pts.length - 1].t,
    spanT = t1 - t0 || 1;
  const avg = ys.reduce((a, b) => a + b, 0) / ys.length;

  const X = (t) => padL + plotW * ((t - t0) / spanT);
  const Y = (v) => padT + plotH * (1 - (v - min) / (max - min));

  const line = pts.map((p, i) => (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p[cfg.key]).toFixed(1)).join(" ");
  const area =
    "M" +
    X(t0).toFixed(1) +
    " " +
    baseY +
    " " +
    pts.map((p) => "L" + X(p.t).toFixed(1) + " " + Y(p[cfg.key]).toFixed(1)).join(" ") +
    " L" +
    X(t1).toFixed(1) +
    " " +
    baseY +
    " Z";

  const last = pts[pts.length - 1];

  // Подпись текущего значения прямо у последней точки.
  const lx = X(last.t),
    ly = Y(last[cfg.key]);
  const rightSide = lx > W * 0.6;
  let nowY = ly - 10;
  if (nowY < padT + 11) nowY = ly + 18; // не уезжать за верх
  if (nowY > baseY - 4) nowY = baseY - 4; // и за низ
  const nowLabel =
    `<text class="now" x="${(rightSide ? lx - 8 : lx + 8).toFixed(1)}" y="${nowY.toFixed(1)}" ` +
    `text-anchor="${rightSide ? "end" : "start"}" fill="${cfg.color}">${cfg.fmt(last[cfg.key])}</text>`;

  const grid = [min, max]
    .map((v) => `<line class="grid" x1="${padL}" y1="${Y(v).toFixed(1)}" x2="${W - padR}" y2="${Y(v).toFixed(1)}"/>`)
    .join("");

  // Горизонтальная пунктирная линия среднего значения + подпись.
  const ay = Y(avg);
  let avgLy = ay - 5;
  if (avgLy < padT + 9) avgLy = ay + 13;
  const avgMark =
    `<line class="avg" x1="${padL}" y1="${ay.toFixed(1)}" x2="${W - padR}" y2="${ay.toFixed(1)}"/>` +
    `<text class="avg-l" x="${padL + 5}" y="${avgLy.toFixed(1)}">ср. ${cfg.fmt(avg)}</text>`;

  // Вертикальные засечки по каждому целому часу (UTC). Подписи прорежены,
  // чтобы не накладывались; последний час подписан всегда.
  const hourStep = 3600;
  const hours = [];
  for (let t = Math.ceil(t0 / hourStep) * hourStep; t <= t1; t += hourStep) hours.push(t);
  let xAxis = "";
  if (hours.length) {
    const labelEvery = Math.max(1, Math.ceil(hours.length / Math.max(2, Math.floor(plotW / 52))));
    xAxis = hours
      .map((t, i) => {
        const x = X(t).toFixed(1);
        const showLabel = (hours.length - 1 - i) % labelEvery === 0; // считаем от последнего часа
        return (
          `<line class="vgrid" x1="${x}" y1="${padT}" x2="${x}" y2="${baseY}"/>` +
          (showLabel ? `<text class="axis ahx" x="${x}" y="${H - 9}">${hhmm(t)}</text>` : "")
        );
      })
      .join("");
  } else {
    xAxis =
      `<text class="axis" x="${padL}" y="${H - 9}">${hhmm(t0)}</text>` +
      `<text class="axis ax-end" x="${W - padR}" y="${H - 9}">${hhmm(t1)}</text>`;
  }

  const yLabels =
    `<text class="axis ay" x="${padL - 8}" y="${(Y(max) + 4).toFixed(1)}">${cfg.fmt(max)}</text>` +
    `<text class="axis ay" x="${padL - 8}" y="${(Y(min) + 4).toFixed(1)}">${cfg.fmt(min)}</text>`;

  // Слой наведения (скрыт до hover) + прозрачный оверлей, ловящий курсор.
  const hoverLayer =
    `<g class="hover" style="display:none">` +
    `<line class="cross" x1="0" y1="${padT}" x2="0" y2="${baseY}"/>` +
    `<circle class="focus" r="4" fill="${cfg.color}"/>` +
    `<g class="tipbox">` +
    `<rect class="tipbg" rx="6"/>` +
    `<text class="tiptime"></text>` +
    `<text class="tipval" fill="${cfg.color}"></text>` +
    `</g>` +
    `</g>` +
    `<rect class="overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>`;

  const gid = "grad-" + cfg.key;
  const html =
    `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${cfg.label}">` +
    `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">` +
    `<stop offset="0" stop-color="${cfg.color}" stop-opacity="0.35"/>` +
    `<stop offset="1" stop-color="${cfg.color}" stop-opacity="0"/></linearGradient></defs>` +
    grid +
    avgMark +
    xAxis +
    `<path d="${area}" fill="url(#${gid})"/>` +
    `<path d="${line}" fill="none" stroke="${cfg.color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="${cfg.color}"/>` +
    yLabels +
    nowLabel +
    hoverLayer +
    `</svg>`;

  // Интерактив: ищем ближайшую по времени точку под курсором и показываем
  // перекрестие, точку на линии и плашку с временем/значением.
  function attach(container) {
    const svg = container.querySelector("svg");
    if (!svg) return;
    const hov = svg.querySelector(".hover");
    const cross = svg.querySelector(".cross");
    const focus = svg.querySelector(".focus");
    const tbox = svg.querySelector(".tipbox");
    const tbg = svg.querySelector(".tipbg");
    const ttime = svg.querySelector(".tiptime");
    const tval = svg.querySelector(".tipval");
    const overlay = svg.querySelector(".overlay");

    const nearest = (svgX) => {
      const t = t0 + ((svgX - padL) / plotW) * spanT;
      let lo = 0,
        hi = pts.length - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (pts[m].t < t) lo = m + 1;
        else hi = m;
      }
      if (lo > 0 && Math.abs(pts[lo - 1].t - t) <= Math.abs(pts[lo].t - t)) lo--;
      return pts[lo];
    };

    const show = (evt) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const cx = evt.touches && evt.touches[0] ? evt.touches[0].clientX : evt.clientX;
      const svgX = ((cx - r.left) / r.width) * W;
      const p = nearest(svgX);
      const px = X(p.t),
        py = Y(p[cfg.key]);

      hov.style.display = ""; // показать ДО замера текста, иначе длина = 0
      cross.setAttribute("x1", px.toFixed(1));
      cross.setAttribute("x2", px.toFixed(1));
      focus.setAttribute("cx", px.toFixed(1));
      focus.setAttribute("cy", py.toFixed(1));
      ttime.textContent = hhmm(p.t);
      tval.textContent = cfg.fmt(p[cfg.key]);

      const padX = 9,
        padY = 7,
        lh = 15;
      ttime.setAttribute("x", padX);
      ttime.setAttribute("y", padY + 11);
      tval.setAttribute("x", padX);
      tval.setAttribute("y", padY + 11 + lh);
      const w = Math.ceil(Math.max(ttime.getComputedTextLength(), tval.getComputedTextLength())) + padX * 2;
      const h = padY * 2 + lh * 2;
      tbg.setAttribute("x", 0);
      tbg.setAttribute("y", 0);
      tbg.setAttribute("width", w);
      tbg.setAttribute("height", h);

      let gx = px + 12;
      if (gx + w > W - 2) gx = px - 12 - w;
      if (gx < 2) gx = 2;
      let gy = py - h - 10;
      if (gy < padT) gy = py + 12;
      if (gy + h > baseY) gy = baseY - h;
      tbox.setAttribute("transform", `translate(${gx.toFixed(1)},${gy.toFixed(1)})`);
    };
    const hide = () => {
      hov.style.display = "none";
    };

    overlay.addEventListener("mousemove", show);
    overlay.addEventListener("mouseenter", show);
    overlay.addEventListener("mouseleave", hide);
    overlay.addEventListener("touchstart", show, { passive: true });
    overlay.addEventListener("touchmove", show, { passive: true });
    overlay.addEventListener("touchend", hide);
  }

  return { html, attach };
}

function caption(points, cfg) {
  const pts = points.filter((p) => p[cfg.key] != null);
  if (!pts.length) return "";
  const ys = pts.map((p) => Number(p[cfg.key]));
  const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
  const span = pts[pts.length - 1].t - pts[0].t;
  const period = span >= 3600 ? Math.round(span / 3600) + " ч" : Math.max(1, Math.round(span / 60)) + " мин";
  return `<figcaption class="cap">за ${period} · мин ${cfg.fmt(Math.min(...ys))} · макс ${cfg.fmt(Math.max(...ys))} · среднее ${cfg.fmt(avg)} · сейчас ${cfg.fmt(ys[ys.length - 1])}</figcaption>`;
}

function renderCharts(history) {
  const points = (history && history.points) || [];
  for (const cfg of CHARTS) {
    const el = $(cfg.id);
    if (!el) continue;
    const chart = buildChart(points, cfg);
    el.innerHTML = chart.html + caption(points, cfg);
    chart.attach(el);
  }
}

async function loadHistory() {
  try {
    const res = await fetch("history.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    renderCharts(await res.json());
  } catch (e) {
    renderCharts(null);
  }
}

// --- Исследователю: опасность/трафик, Thera, инкурсии, лут -----------------

const SEC_CLASS = { high: "sec-high", low: "sec-low", null: "sec-null" };
const SEC_TIP = {
  high: "Хайсек (high-sec, 0.5–1.0) — безопасный космос: за атаку игрока карает полиция CONCORD.",
  low: "Лоусек (low-sec, 0.1–0.4) — слабоохраняемый космос: PvP почти без последствий.",
  null: "Нулсек (null-sec, ≤0.0) — космос без охраны: территория альянсов, свободный PvP.",
};
const SIZE_LABEL = { small: "S", medium: "M", large: "L", xlarge: "XL", capital: "Cap" };
const SIZE_TIP = {
  small: "Макс. размер корабля: S — только фрегаты, эсминцы и подобные мелкие корпуса.",
  medium: "Макс. размер корабля: M — до крейсеров / линейных крейсеров.",
  large: "Макс. размер корабля: L — до линкоров (battleship).",
  xlarge: "Макс. размер корабля: XL — пропускает фрейтеры и крупные корпуса.",
  capital: "Макс. размер корабля: Cap — проходят капитальные корабли.",
};
// state → [подпись, css-класс, поясняющая подсказка]
const INC_STATE = {
  established: [
    "развёрнута",
    "st-red",
    "Инкурсия полностью развёрнута: максимальное влияние Сансы и максимальные награды.",
  ],
  mobilizing: ["мобилизация", "st-yellow", "Инкурсия мобилизуется: скоро завершится, награды снижены."],
  withdrawing: ["отступление", "st-green", "Инкурсия отступает — финальная стадия перед исчезновением."],
};

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const dotlan = (name) => "https://evemaps.dotlan.net/system/" + encodeURIComponent(String(name).replace(/ /g, "_"));

function fmtIskShort(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " млрд";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " млн";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " тыс";
  return Math.round(n).toString();
}

const secChip = (s) => {
  const tip = SEC_TIP[s.band];
  return `<i class="sec ${SEC_CLASS[s.band] || ""}"${tip ? ` title="${esc(tip)}"` : ""}>${s.sec != null ? s.sec.toFixed(1) : "?"}</i>`;
};

function classChip(cls) {
  if (!cls) return "";
  const m = /^c(\d)$/i.exec(cls);
  if (m)
    return `<i class="cls cls-wh" title="Класс вормхола C${m[1]}: чем выше класс (C1–C6), тем опаснее обитатели и ценнее добыча.">C${m[1]}</i>`;
  const k = {
    hs: ["Hi", "cls-hi", SEC_TIP.high],
    ls: ["Low", "cls-low", SEC_TIP.low],
    ns: ["Null", "cls-null", SEC_TIP.null],
  }[String(cls).toLowerCase()];
  return k ? `<i class="cls ${k[1]}" title="${esc(k[2])}">${k[0]}</i>` : `<i class="cls">${esc(cls)}</i>`;
}

function renderRank(id, items) {
  const el = $(id);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<li class="muted-row">нет данных</li>';
    return;
  }
  el.innerHTML = items
    .map(
      (s) =>
        `<li><span class="sys">${secChip(s)}<a href="${dotlan(s.name)}" target="_blank" rel="noopener">${esc(s.name)}</a></span>` +
        `<span class="val">${Number(s.value).toLocaleString("ru-RU")}</span></li>`,
    )
    .join("");
}

function renderThera(items) {
  const el = $("list-thera");
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<li class="muted-row">сейчас нет коннекшенов</li>';
    return;
  }
  el.innerHTML = items
    .map((w) => {
      const size = SIZE_LABEL[w.size] || esc(w.size);
      const sizeTip = SIZE_TIP[w.size] || "Максимальный размер корабля, проходящего через вормхол.";
      const hrs = w.hours != null ? `~${w.hours} ч` : "";
      return (
        `<li><span class="from">${esc(w.from)}</span><span class="arrow">→</span>` +
        `<a class="to" href="${dotlan(w.to)}" target="_blank" rel="noopener">${esc(w.to)}</a>` +
        `${classChip(w.class)}<span class="reg">${esc(w.region)}</span>` +
        `<span class="spacer"></span>` +
        `<span class="size" title="${esc(sizeTip)}">${size}</span>` +
        `<span class="hrs" title="Примерное оставшееся время жизни вормхола.">${hrs}</span></li>`
      );
    })
    .join("");
}

function renderIncursions(items) {
  const el = $("list-incursions");
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<li class="muted-row">активных инкурсий нет</li>';
    return;
  }
  el.innerHTML = items
    .map((i) => {
      const st = INC_STATE[i.state] || [esc(i.state) || "—", "", ""];
      const boss = i.has_boss
        ? '<span class="boss" title="Босс-флот заспавнен — главный приз инкурсии (Sansha Kuvakei) доступен.">BOSS</span>'
        : "";
      const loc = [i.constellation, i.staging ? "штаб " + i.staging : null].filter(Boolean).map(esc).join(" · ");
      const stTitle = st[2] ? ` title="${esc(st[2])}"` : "";
      return (
        `<li><span class="inc-loc">${loc || "—"}</span><span class="spacer"></span>${boss}` +
        `<span class="inc-sys" title="Число систем в созвездии, охваченных инкурсией.">${i.systems != null ? i.systems + " сист." : ""}</span>` +
        `<span class="inc-inf" title="Влияние Сансы в созвездии: чем выше, тем сильнее штрафы защитникам и опаснее враги.">${i.influence != null ? i.influence + "%" : ""}</span>` +
        `<span class="st ${st[1]}"${stTitle}>${st[0]}</span></li>`
      );
    })
    .join("");
}

function renderLoot(items) {
  const el = $("list-loot");
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<li class="muted-row">нет данных</li>';
    return;
  }
  el.innerHTML = items
    .map(
      (l) =>
        `<li><span class="loot-name">${esc(l.name)}</span><span class="loot-price">${fmtIskShort(l.price)}</span></li>`,
    )
    .join("");
}

function renderExplore(ex) {
  ex = ex || {};
  renderRank("list-danger", ex.danger);
  renderRank("list-ratting", ex.ratting);
  renderRank("list-traffic", ex.traffic);
  renderThera(ex.thera);
  renderLoot(ex.loot);
}

// EVE-время (UTC) и обратный отсчёт до ежедневного даунтайма в 11:00 UTC.
function tickTime() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const et = $("eve-time");
  if (et) et.textContent = `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}`;

  const dt = new Date(now);
  dt.setUTCHours(11, 0, 0, 0);
  if (dt <= now) dt.setUTCDate(dt.getUTCDate() + 1);
  let s = Math.floor((dt - now) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const cd = $("dt-countdown");
  if (cd) cd.textContent = `${p(h)}:${p(m)}:${p(s)}`;
}

// --- Текущие показатели ----------------------------------------------------

async function load() {
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();

    const st = STATUS[d.server.status] || { text: "Статус неизвестен", cls: "badge--unknown" };
    const badge = $("status-badge");
    badge.textContent = st.text;
    badge.className = "badge " + st.cls;

    $("players").textContent = fmtNum(d.server.players);
    $("version").textContent = d.server.version || "—";
    $("plex").textContent = fmtIsk(d.stats.plex_price);
    $("incursions").textContent = fmtNum(d.stats.incursions);
    $("sov").textContent = fmtNum(d.stats.sov_campaigns);

    serverStart = d.server.start_time || null;
    $("updated").textContent = ago(d.generated_at);

    renderNews(d.news);
    renderExplore(d.explore);
    renderIncursions(d.incursions);
  } catch (e) {
    const badge = $("status-badge");
    badge.textContent = "Нет данных";
    badge.className = "badge badge--err";
  }
}

// Аптайм и EVE-время тикают каждую секунду локально.
setInterval(() => {
  $("uptime").textContent = serverStart ? fmtUptime(serverStart) : "—";
  tickTime();
}, 1000);
tickTime();

// Данные и история перечитываются раз в минуту.
load();
loadHistory();
setInterval(() => {
  load();
  loadHistory();
}, 60000);
