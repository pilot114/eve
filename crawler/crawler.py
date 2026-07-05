"""Краулер корпораций EVE Online с сайта DOTLAN EveMaps.

Источник данных — https://evemaps.dotlan.net

Логика обхода:
    1. По альянсу открывается страница со списком корпораций-членов
       (/alliance/<slug>/corporations) и из неё берутся ссылки на корпорации.
    2. Каждая корпорация открывается отдельно (/corp/<slug>), со страницы
       парсится инфо-таблица.
    3. Записи пишутся в CSV по мере обхода (частичный результат переживает сбой).

Поля CSV соответствуют примеру записи:
    Name, Ticker, Alliance, Faction, Ceo, Members, URL, Tax Rate, corporationID

Запуск:
    python crawler.py Goonswarm_Federation
    python crawler.py Goonswarm_Federation Pandemic_Horde -o corps.csv --delay 0.5
    python crawler.py --all                       # все альянсы со страницы /alliances
    python crawler.py --all --exclude Goonswarm_Federation --append   # дописать к готовому CSV
"""
import os
import csv
import time
import random
import argparse
import logging
from urllib.parse import urljoin, unquote

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup

BASE_URL = "https://evemaps.dotlan.net"
ALLIANCES_URL = f"{BASE_URL}/alliances"
# Колонки CSV в том же порядке, что и в примере записи.
# "Name" берётся из инфо-таблицы страницы корпорации (ключ "Name") наравне с прочими полями.
FIELDS = ["Name", "Ticker", "Alliance", "Faction", "Ceo", "Members", "URL", "Tax Rate", "corporationID"]
# User-Agent обычного браузера — без него dotlan иногда отвечает иначе
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
LOG_FILE = "eve_handler.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("crawler")


"""Создаёт HTTP-сессию с повторными попытками на сетевые сбои и 5xx-ответы."""
def make_session(user_agent=USER_AGENT):
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent})
    retry = Retry(
        total=4,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


"""Скачивает страницу и возвращает её HTML-текст (или None при ошибке)."""
def fetch(session, url, timeout=30):
    try:
        resp = session.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.text
    except requests.RequestException as exc:
        log.warning("Не удалось загрузить %s: %s", url, exc)
        return None


"""Нормализует имя/слаг альянса в URL страницы со списком корпораций.

Принимает как слаг (Goonswarm_Federation), так и человекочитаемое имя
(Goonswarm Federation) или готовый путь/URL.
"""
def alliance_corps_url(alliance):
    alliance = alliance.strip()
    if alliance.startswith("http"):
        return alliance
    if alliance.startswith("/"):
        return urljoin(BASE_URL, alliance)
    slug = alliance.replace(" ", "_")
    return f"{BASE_URL}/alliance/{slug}/corporations"


"""Возвращает слаги всех альянсов с индексной страницы /alliances.

Берёт основную таблицу альянсов (та, где есть колонка Corps), пропуская
боковые списки. Сохраняет порядок, в котором альянсы идут на странице.
"""
def get_all_alliance_slugs(session, index_url=ALLIANCES_URL):
    html = fetch(session, index_url)
    if html is None:
        return []
    soup = BeautifulSoup(html, "lxml")
    slugs = []
    seen = set()
    for table in soup.find_all("table"):
        first_row = table.find("tr")
        headers = [c.get_text(" ", strip=True).lower() for c in first_row.find_all(["th", "td"])] if first_row else []
        if "corps" not in headers:  # нужна основная таблица альянсов
            continue
        for a in table.select('a[href^="/alliance/"]'):
            cell = a.find_parent(["th", "td"])
            if cell is not None and cell.name == "th":
                continue  # ссылки сортировки в заголовке (name/systems/...), не альянсы
            slug = a["href"].split("/alliance/", 1)[1].split("/")[0]
            if slug and slug not in seen:
                seen.add(slug)
                slugs.append(slug)
    return slugs


"""Извлекает ссылки на корпорации-члены из страницы списка альянса.

На странице две таблицы со ссылками на корпорации: текущие члены
(заголовки Name/Ticker/Member/Joined) и бывшие (есть колонка Left).
Берём только таблицу текущих членов. Возвращает список (href, name).
"""
def extract_member_corps(html):
    soup = BeautifulSoup(html, "lxml")
    corps = []
    seen = set()
    for table in soup.find_all("table"):
        first_row = table.find("tr")
        if not first_row:
            continue
        headers = [c.get_text(" ", strip=True).lower() for c in first_row.find_all(["th", "td"])]
        # Нужна таблица текущих членов: есть Ticker и Joined, но нет Left
        if "ticker" not in headers or "joined" not in headers or "left" in headers:
            continue
        for a in table.select('a[href^="/corp/"]'):
            href = a["href"]
            name = a.get_text(strip=True)
            if not name:  # пропускаем ссылку-логотип без текста
                continue
            if href in seen:
                continue
            seen.add(href)
            corps.append((href, name))
    return corps


"""Парсит инфо-таблицу страницы корпорации в словарь поле->значение.

Инфо-таблица состоит из строк вида <td>Ключ</td><td>Значение</td>.
recursive=False важно, чтобы не цеплять ячейки вложенных таблиц.
"""
def parse_corp(html):
    soup = BeautifulSoup(html, "lxml")
    info = {}
    for tr in soup.find_all("tr"):
        cells = tr.find_all(["td", "th"], recursive=False)
        if len(cells) != 2:
            continue
        key = cells[0].get_text(" ", strip=True)
        value = cells[1].get_text(" ", strip=True)
        if key and key not in info:
            info[key] = value
    return {field: info.get(field, "") for field in FIELDS}


"""Загружает множество уже собранных корпораций из sidecar-файла <out>.seen.

В файле по одному href корпорации на строку. Нужен для возобновления (--append):
позволяет не перекачивать корпорации, собранные в прошлых запусках.
"""
def load_seen(seen_path):
    if not os.path.exists(seen_path):
        return set()
    with open(seen_path, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip()}


"""Обходит альянсы, собирает корпорации и пишет их в CSV.

Каждая запись пишется на диск сразу, чтобы частичный результат сохранялся.
href каждой собранной корпорации пишется в <out>.seen — это даёт
дедупликацию (корпорация, попавшая в списки двух альянсов, качается один раз)
и возобновление при append. Возвращает число собранных корпораций.
"""
def crawl(alliances, out_path, delay=0.5, limit=None, user_agent=USER_AGENT, append=False):
    session = make_session(user_agent)
    seen_path = out_path + ".seen"
    file_exists = os.path.exists(out_path)
    seen = load_seen(seen_path) if append else set()
    mode = "a" if append else "w"
    count = 0
    with open(out_path, mode, newline="", encoding="utf-8") as fh, \
         open(seen_path, "a" if append else "w", encoding="utf-8") as seen_fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        if not (append and file_exists):
            writer.writeheader()
        for alliance in alliances:
            url = alliance_corps_url(alliance)
            log.info("Альянс %s -> %s", alliance, url)
            html = fetch(session, url)
            if html is None:
                log.error("Пропускаю альянс %s: страница недоступна", alliance)
                continue
            corps = extract_member_corps(html)
            log.info("Найдено корпораций-членов: %d", len(corps))
            for i, (href, name) in enumerate(corps, 1):
                if limit is not None and count >= limit:
                    log.info("Достигнут лимит --limit=%d, останавливаюсь", limit)
                    fh.flush()
                    return count
                if href in seen:  # уже собрана (в этом или прошлом запуске)
                    continue
                seen.add(href)
                corp_url = urljoin(BASE_URL, href)
                corp_html = fetch(session, corp_url)
                if corp_html is None:
                    log.warning("Пропускаю корпорацию %s", unquote(name))
                    continue
                row = parse_corp(corp_html)
                writer.writerow(row)
                fh.flush()  # сохраняем прогресс после каждой записи
                seen_fh.write(href + "\n")
                seen_fh.flush()
                count += 1
                log.info(
                    "[%s %d/%d] %s (%s) members=%s tax=%s id=%s",
                    alliance, i, len(corps), unquote(name), row["Ticker"],
                    row["Members"], row["Tax Rate"], row["corporationID"],
                )
                # вежливая пауза между запросами + небольшой джиттер
                time.sleep(delay + random.uniform(0, delay * 0.5))
    return count


def main():
    parser = argparse.ArgumentParser(
        description="Краулер корпораций EVE Online с DOTLAN EveMaps в CSV.",
    )
    parser.add_argument(
        "alliances", nargs="*",
        help="слаг или имя альянса (напр. Goonswarm_Federation), можно несколько",
    )
    parser.add_argument(
        "--all", action="store_true", dest="all_alliances",
        help="взять все альянсы со страницы /alliances",
    )
    parser.add_argument(
        "--exclude", nargs="*", default=[], metavar="SLUG",
        help="слаги альянсов, которые пропустить (напр. уже собранный Goonswarm_Federation)",
    )
    parser.add_argument(
        "--append", action="store_true",
        help="дописывать в существующий CSV и пропускать уже собранные корпорации (по <out>.seen)",
    )
    parser.add_argument(
        "-o", "--out", default="corporations.csv",
        help="путь к выходному CSV-файлу (по умолчанию corporations.csv)",
    )
    parser.add_argument(
        "--delay", type=float, default=0.5,
        help="базовая пауза между запросами в секундах (по умолчанию 0.5)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="ограничить число корпораций (для отладки)",
    )
    parser.add_argument(
        "--user-agent", default=USER_AGENT,
        help="заголовок User-Agent для запросов",
    )
    args = parser.parse_args()

    alliances = list(args.alliances)
    if args.all_alliances:
        session = make_session(args.user_agent)
        all_slugs = get_all_alliance_slugs(session)
        log.info("Со страницы /alliances получено альянсов: %d", len(all_slugs))
        for slug in all_slugs:
            if slug not in alliances:
                alliances.append(slug)
    excluded = set(args.exclude)
    if excluded:
        alliances = [a for a in alliances if a not in excluded]
        log.info("Исключено альянсов: %d", len(excluded))
    if not alliances:
        parser.error("укажите хотя бы один альянс или флаг --all")
    log.info("К обработке альянсов: %d", len(alliances))

    started = time.time()
    count = crawl(
        alliances, args.out,
        delay=args.delay, limit=args.limit,
        user_agent=args.user_agent, append=args.append,
    )
    log.info("Готово: собрано %d корпораций в %s за %.1f c",
             count, args.out, time.time() - started)


if __name__ == "__main__":
    main()
