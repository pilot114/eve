/* ===== EVE SDE отчёт — общие утилиты ===== */
(function () {
  "use strict";

  const DATA_DIR = "../eve-online-static-data-3421648-jsonl/";

  const LANG_LABELS = {
    ru: "Русский", en: "English", de: "Deutsch", es: "Español",
    fr: "Français", ja: "日本語", ko: "한국어", zh: "中文",
  };
  const LANG_ORDER = ["ru", "en", "de", "es", "fr", "ja", "ko", "zh"];

  function fileUrl(table) {
    return DATA_DIR + table + ".jsonl";
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatBytes(n) {
    if (n === undefined || n === null) return "—";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + " " + units[i];
  }

  function formatNumber(n) {
    if (n === undefined || n === null) return "—";
    return n.toLocaleString("ru-RU");
  }

  function getLang() {
    return localStorage.getItem("eve_report_lang") || "ru";
  }
  function setLang(lang) {
    localStorage.setItem("eve_report_lang", lang);
  }

  function isI18nValue(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every((k) => LANG_ORDER.includes(k));
  }

  function pickI18n(value, lang) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value);
    if (isI18nValue(value)) {
      lang = lang || getLang();
      return value[lang] ?? value.ru ?? value.en ?? Object.values(value)[0] ?? "";
    }
    return null; // not an i18n value
  }

  /* ---------- DOM builder ---------- */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    attrs = attrs || {};
    for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null || attrs[k] === false) continue;
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") node.addEventListener(k.slice(2), attrs[k]);
      else if (k === "dataset") { for (const dk in attrs[k]) node.dataset[dk] = attrs[k][dk]; }
      else node.setAttribute(k, attrs[k]);
    }
    children = children || [];
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function debounce(fn, wait) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /* ---------- streaming line-by-line file reading ---------- */

  const STOP = Symbol("stop-scan");

  /**
   * Streams a .jsonl file line by line without holding the whole file in memory.
   * onObject(obj, rawLine) is called for every parsed line; returning `false`
   * stops the scan early and cancels the underlying network read.
   * onProgress(bytesRead, totalBytesOrNull) reports download progress.
   */
  async function scanFile(table, { onObject, onProgress, onError } = {}) {
    const url = fileUrl(table);
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      if (onError) onError(e);
      throw e;
    }
    if (!resp.ok) {
      const e = new Error("HTTP " + resp.status + " при загрузке " + url);
      if (onError) onError(e);
      throw e;
    }
    const total = Number(resp.headers.get("content-length")) || null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let bytesRead = 0;
    let count = 0;
    let stopped = false;

    function handleLine(line) {
      if (!line.trim()) return true;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        return true; // skip malformed line
      }
      count++;
      const res = onObject ? onObject(obj, line) : undefined;
      return res !== false;
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim()) handleLine(buffer);
          break;
        }
        bytesRead += value.length;
        if (onProgress) onProgress(bytesRead, total);
        buffer += decoder.decode(value, { stream: true });
        let idx;
        let keepGoing = true;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!handleLine(line)) { keepGoing = false; break; }
        }
        if (!keepGoing) { stopped = true; break; }
      }
    } finally {
      if (stopped) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
      }
    }
    return { count, stopped };
  }

  /** Reads at most maxLines parsed objects from the start of a .jsonl file. */
  async function previewLines(table, maxLines, onProgress) {
    const items = [];
    const { stopped } = await scanFile(table, {
      onProgress,
      onObject(obj) {
        items.push(obj);
        if (items.length >= maxLines) return false;
      },
    });
    return { items, reachedEnd: !stopped };
  }

  /* full-file cache, used for small dictionaries and moderate map tables */
  const fullCache = new Map();

  function loadFull(table) {
    if (fullCache.has(table)) return fullCache.get(table);
    const promise = (async () => {
      const items = [];
      await scanFile(table, { onObject: (obj) => { items.push(obj); } });
      return items;
    })();
    fullCache.set(table, promise);
    return promise;
  }

  /* ---------- misc ---------- */

  function tableMeta(name) {
    return window.EVE_META.tables[name];
  }
  function groupInfo(key) {
    return window.EVE_META.groups[key];
  }

  function checkFileProtocolWarning() {
    if (location.protocol === "file:") {
      const b = document.getElementById("file-protocol-warning");
      if (b) b.classList.add("show");
    }
  }

  function jsonPreviewHtml(value) {
    const json = JSON.stringify(value, null, 1);
    const short = json.length > 60 ? json.slice(0, 60) + "…" : json;
    return (
      '<details><summary>' + escapeHtml(short) + '</summary><pre>' +
      escapeHtml(JSON.stringify(value, null, 2)) + '</pre></details>'
    );
  }

  /** Renders any scalar/object cell value into a safe HTML string. */
  function cellHtml(value, lang) {
    if (value === null || value === undefined) return '<span class="hint">—</span>';
    if (isI18nValue(value)) return escapeHtml(pickI18n(value, lang));
    if (typeof value === "object") return jsonPreviewHtml(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return escapeHtml(String(value));
  }

  function makeSortable(table, opts) {
    opts = opts || {};
    const thead = table.tHead;
    if (!thead) return;
    const ths = Array.from(thead.querySelectorAll("th"));
    ths.forEach((th, colIdx) => {
      th.addEventListener("click", () => {
        const tbody = table.tBodies[0];
        const rows = Array.from(tbody.rows);
        const asc = th.dataset.sortDir !== "asc";
        ths.forEach((t) => delete t.dataset.sortDir);
        th.dataset.sortDir = asc ? "asc" : "desc";
        const numeric = th.classList.contains("num");
        rows.sort((a, b) => {
          let av = a.cells[colIdx] ? a.cells[colIdx].dataset.sort ?? a.cells[colIdx].textContent : "";
          let bv = b.cells[colIdx] ? b.cells[colIdx].dataset.sort ?? b.cells[colIdx].textContent : "";
          if (numeric) { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; return asc ? av - bv : bv - av; }
          av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
          return asc ? av.localeCompare(bv, "ru") : bv.localeCompare(av, "ru");
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  }

  window.EveUtil = {
    DATA_DIR, LANG_LABELS, LANG_ORDER,
    fileUrl, escapeHtml, formatBytes, formatNumber,
    getLang, setLang, isI18nValue, pickI18n,
    el, debounce, scanFile, previewLines, loadFull,
    tableMeta, groupInfo, checkFileProtocolWarning,
    jsonPreviewHtml, cellHtml, makeSortable,
  };
})();
