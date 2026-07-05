<?php
/**
 * Обновление data.json для дашборда EVE Online.
 *
 * Скрипт тянет данные из ESI (статус сервера, инкурсии, sov-кампании, цена PLEX)
 * и из RSS официальных новостей форума, складывает всё в data.json.
 * Сам сайт (index.html) только читает этот JSON — никакой логики на бэкенде там нет.
 *
 * Запуск вручную:   php update.php
 * Через cron (раз в минуту):
 *   * * * * * /usr/bin/php /путь/к/eve-status/update.php >/dev/null 2>&1
 */

declare(strict_types=1);

// --- Настройки -------------------------------------------------------------

// ESI просит указывать в User-Agent контакт разработчика. Поменяйте на свой.
const USER_AGENT   = 'eve-status-board/1.0 (contact: you@example.com)';

const ESI          = 'https://esi.evetech.net/latest';
const DATASOURCE   = 'tranquility';
const NEWS_RSS     = 'https://forums.eveonline.com/c/eve-information-portal/80.rss';
const NEWS_LIMIT   = 8;       // сколько новостей сохранять
const PLEX_TYPE_ID = 44992;   // type_id PLEX в базе EVE
const HTTP_TIMEOUT = 15;      // секунд на запрос
const OUT_FILE     = __DIR__ . '/data.json';
const HIST_FILE    = __DIR__ . '/history.json';
const HIST_MAX     = 1440;    // точек истории (~24 ч при запуске раз в минуту)
const SYS_CACHE_FILE = __DIR__ . '/systems_cache.json'; // имя+sec систем (статика, копится)
const EVE_SCOUT_URL  = 'https://api.eve-scout.com/v2/public/signatures';
const TOP_N          = 8;     // длина топов «опасность/трафик»

// Курируемый лут сканинг-сайтов (type_id => имя) для тикера цен.
const LOOT = [
    25624 => 'Intact Armor Plates',
    30746 => 'Ancient Coordinates Database',
    30745 => 'Sleeper Data Library',
    30744 => 'Neural Network Analyzer',
    25600 => 'Burned Logic Circuit',
    25602 => 'Thruster Console',
    25603 => 'Melted Capacitor Console',
    25598 => 'Tripped Power Circuit',
];

// --- HTTP-помощник ---------------------------------------------------------

/** GET-запрос. Возвращает [http_code, тело|null]. */
function http_get(string $url): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => HTTP_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => HTTP_TIMEOUT,
        CURLOPT_USERAGENT      => USER_AGENT,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, $body === false ? null : $body];
}

/** Запрос к ESI с добавлением datasource, разбор JSON. */
function esi_json(string $path): ?array {
    $sep = str_contains($path, '?') ? '&' : '?';
    [$code, $body] = http_get(ESI . $path . $sep . 'datasource=' . DATASOURCE);
    if ($code !== 200 || $body === null) {
        return null;
    }
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

/** POST с JSON-телом к ESI. Возвращает разобранный массив или null. */
function esi_post(string $path, array $payload): ?array {
    $sep = str_contains($path, '?') ? '&' : '?';
    $ch = curl_init(ESI . $path . $sep . 'datasource=' . DATASOURCE);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_TIMEOUT        => HTTP_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => HTTP_TIMEOUT,
        CURLOPT_USERAGENT      => USER_AGENT,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200 || $body === false) {
        return null;
    }
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

/** Резолв id -> имя одним запросом (системы, созвездия, фракции и т.п.). */
function resolve_names(array $ids): array {
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) {
        return [];
    }
    $data = esi_post('/universe/names/', $ids);
    $map = [];
    if (is_array($data)) {
        foreach ($data as $r) {
            $map[(int) $r['id']] = $r['name'];
        }
    }
    return $map;
}

/** Имя/security системы со статическим кэшем на диске (эти данные не меняются). */
function sys_info(int $id, array &$cache): ?array {
    if (isset($cache[$id])) {
        return $cache[$id];
    }
    $s = esi_json('/universe/systems/' . $id . '/');
    if ($s === null || !isset($s['name'])) {
        return null;
    }
    $sec  = round((float) ($s['security_status'] ?? 0), 1);
    $band = $sec >= 0.5 ? 'high' : ($sec >= 0.1 ? 'low' : 'null');
    $cache[$id] = ['id' => $id, 'name' => $s['name'], 'sec' => $sec, 'band' => $band];
    return $cache[$id];
}

/** Топ-N систем по числовому значению из массива почасовой активности. */
function top_systems(array $rows, callable $val, int $n, array &$cache): array {
    usort($rows, fn($a, $b) => $val($b) <=> $val($a));
    $out = [];
    foreach ($rows as $r) {
        if ($val($r) <= 0) {
            break; // дальше после сортировки только нули
        }
        $info = sys_info((int) $r['system_id'], $cache);
        if ($info === null) {
            continue;
        }
        $out[] = $info + ['value' => $val($r)];
        if (count($out) >= $n) {
            break;
        }
    }
    return $out;
}

// --- Статус сервера --------------------------------------------------------

$status = esi_json('/status/');
$server = [
    'status'     => 'offline',   // online | vip | offline
    'players'    => null,
    'version'    => null,
    'start_time' => null,
];
if ($status !== null && isset($status['players'])) {
    $server['status']     = !empty($status['vip']) ? 'vip' : 'online';
    $server['players']    = (int) $status['players'];
    $server['version']    = $status['server_version'] ?? null;
    $server['start_time'] = $status['start_time'] ?? null;
}

// --- Реалтайм-статистика ---------------------------------------------------

$incursions = esi_json('/incursions/');
$campaigns  = esi_json('/sovereignty/campaigns/');

// Один общий прайс-лист ESI -> карта type_id => средняя цена.
$pmap   = [];
$prices = esi_json('/markets/prices/');
if (is_array($prices)) {
    foreach ($prices as $p) {
        if (isset($p['type_id'], $p['average_price'])) {
            $pmap[(int) $p['type_id']] = (float) $p['average_price'];
        }
    }
}
$plex = $pmap[PLEX_TYPE_ID] ?? null;

// Тикер цен лута сканинг-сайтов (из того же прайс-листа), от дорогого к дешёвому.
$loot = [];
foreach (LOOT as $tid => $name) {
    if (isset($pmap[$tid])) {
        $loot[] = ['name' => $name, 'price' => $pmap[$tid]];
    }
}
usort($loot, fn($a, $b) => $b['price'] <=> $a['price']);

// --- Карта опасности/трафика: почасовая активность по системам -------------
$sysCache = [];
if (is_file(SYS_CACHE_FILE)) {
    $c = json_decode((string) file_get_contents(SYS_CACHE_FILE), true);
    if (is_array($c)) {
        $sysCache = $c;
    }
}
$sysKills = esi_json('/universe/system_kills/');
$sysJumps = esi_json('/universe/system_jumps/');

$danger  = is_array($sysKills) ? top_systems($sysKills, fn($r) => ($r['ship_kills'] ?? 0) + ($r['pod_kills'] ?? 0), TOP_N, $sysCache) : [];
$ratting = is_array($sysKills) ? top_systems($sysKills, fn($r) => $r['npc_kills'] ?? 0, TOP_N, $sysCache) : [];
$traffic = is_array($sysJumps) ? top_systems($sysJumps, fn($r) => $r['ship_jumps'] ?? 0, TOP_N, $sysCache) : [];

// Кэш систем (имя/sec статичны) — дописываем то, что подтянули.
file_put_contents(SYS_CACHE_FILE, json_encode($sysCache, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);

// --- Инкурсии: детали с именами локаций ------------------------------------
$incList = [];
if (is_array($incursions) && $incursions) {
    $ids = [];
    foreach ($incursions as $inc) {
        $ids[] = $inc['constellation_id'] ?? null;
        $ids[] = $inc['staging_solar_system_id'] ?? null;
    }
    $names = resolve_names($ids);
    foreach ($incursions as $inc) {
        $incList[] = [
            'constellation' => $names[$inc['constellation_id'] ?? 0] ?? null,
            'staging'       => $names[$inc['staging_solar_system_id'] ?? 0] ?? null,
            'state'         => $inc['state'] ?? null,                                  // established|mobilizing|withdrawing
            'influence'     => isset($inc['influence']) ? (int) round($inc['influence'] * 100) : null,
            'has_boss'      => !empty($inc['has_boss']),
            'systems'       => isset($inc['infested_solar_systems']) ? count($inc['infested_solar_systems']) : null,
        ];
    }
    $order = ['established' => 0, 'mobilizing' => 1, 'withdrawing' => 2];
    usort($incList, fn($a, $b) => ($order[$a['state']] ?? 9) <=> ($order[$b['state']] ?? 9));
}

// --- Thera / Turnur: живые вормхол-коннекшены (EVE-Scout) -------------------
$thera = [];
[$code, $body] = http_get(EVE_SCOUT_URL);
if ($code === 200 && $body !== null) {
    $sigs = json_decode($body, true);
    if (is_array($sigs)) {
        foreach ($sigs as $s) {
            if (($s['signature_type'] ?? '') !== 'wormhole') {
                continue;
            }
            $thera[] = [
                'from'   => $s['out_system_name'] ?? null,   // Thera / Turnur
                'to'     => $s['in_system_name'] ?? null,
                'class'  => $s['in_system_class'] ?? null,   // c1..c6 / hs/ls/ns
                'region' => $s['in_region_name'] ?? null,
                'size'   => $s['max_ship_size'] ?? null,     // small|medium|large|xlarge
                'hours'  => $s['remaining_hours'] ?? null,
            ];
        }
        usort($thera, fn($a, $b) => ($b['hours'] ?? 0) <=> ($a['hours'] ?? 0));
        $thera = array_slice($thera, 0, 14);
    }
}

// --- Новости (RSS форума EVE Online) --------------------------------------

$news = [];
[$code, $rss] = http_get(NEWS_RSS);
if ($code === 200 && $rss !== null) {
    $xml = @simplexml_load_string($rss);
    if ($xml !== false && isset($xml->channel->item)) {
        foreach ($xml->channel->item as $item) {
            $ts = strtotime((string) $item->pubDate);
            $news[] = [
                'title' => trim((string) $item->title),
                'link'  => trim((string) $item->link),
                'date'  => $ts ? gmdate('c', $ts) : null,
            ];
            if (count($news) >= NEWS_LIMIT) {
                break;
            }
        }
    }
}

// --- Сборка и атомарная запись ---------------------------------------------

$out = [
    'generated_at' => gmdate('c'),
    'server'       => $server,
    'stats'        => [
        'incursions'    => is_array($incursions) ? count($incursions) : null,
        'sov_campaigns' => is_array($campaigns)  ? count($campaigns)  : null,
        'plex_price'    => $plex,
    ],
    'incursions' => $incList,
    'explore' => [
        'danger'  => $danger,   // топ систем по убийствам кораблей+подов за час
        'ratting' => $ratting,  // топ по NPC-килам (активный раттинг)
        'traffic' => $traffic,  // топ по прыжкам (трафик/кемпы)
        'thera'   => $thera,    // коннекшены Thera/Turnur
        'loot'    => $loot,     // цены лута сканинг-сайтов
    ],
    'news' => $news,
];

$json = json_encode(
    $out,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
);

// Пишем во временный файл и переименовываем — чтобы сайт не прочитал половину.
$tmp = OUT_FILE . '.tmp';
file_put_contents($tmp, $json, LOCK_EX);
rename($tmp, OUT_FILE);

// --- История (для графиков) ------------------------------------------------
// Дописываем одну точку и держим не больше HIST_MAX последних.
$points = [];
if (is_file(HIST_FILE)) {
    $prev = json_decode((string) file_get_contents(HIST_FILE), true);
    if (isset($prev['points']) && is_array($prev['points'])) {
        $points = $prev['points'];
    }
}
$points[] = [
    't'          => time(),
    'players'    => $server['players'],
    'plex'       => $plex,
    'incursions' => $out['stats']['incursions'],
    'sov'        => $out['stats']['sov_campaigns'],
];
if (count($points) > HIST_MAX) {
    $points = array_slice($points, -HIST_MAX);
}
$tmpH = HIST_FILE . '.tmp';
file_put_contents($tmpH, json_encode(['points' => $points], JSON_UNESCAPED_SLASHES), LOCK_EX);
rename($tmpH, HIST_FILE);

if (PHP_SAPI === 'cli') {
    fwrite(STDOUT, sprintf(
        "data.json обновлён: server=%s players=%s news=%d история=%d точек | опасных=%d thera=%d инкурсий=%d\n",
        $server['status'],
        $server['players'] ?? '?',
        count($news),
        count($points),
        count($danger),
        count($thera),
        count($incList)
    ));
}
