"""Хранение и интерактивный выбор отслеживаемых областей экрана.

Каждая область — прямоугольник (x1, y1, x2, y2) с именем. Пользователь
выделяет их мышью поверх снятого кадра, после чего они сохраняются в JSON,
чтобы использовать их в дальнейших запусках вместо области по умолчанию
в центре экрана.
"""
import os
import json
import logging

# Qt-бэкенд, с которым собран opencv-python, не содержит плагин "wayland" —
# только "xcb". Под чистым Wayland (без этой переменной) cv2.namedWindow не
# создаёт окно вообще (NULL window handler). XWayland в системе есть, поэтому
# принудительно просим Qt идти через xcb. setdefault — чтобы не перебивать
# осознанный выбор пользователя, если он уже задал QT_QPA_PLATFORM сам.
os.environ.setdefault("QT_QPA_PLATFORM", "xcb")

import cv2

# Qt внутри opencv-python собран без fontconfig и ищет шрифты только в
# каталоге site-packages/cv2/qt/fonts, которого в пакете просто нет
# ("QFontDatabase: Cannot find font directory..."). Без шрифтов Qt не может
# отрисовать текст — пропадают подписи у кнопок панели инструментов и
# координаты/цвет пикселя в статусной строке. Загрузчик cv2 (config-3.py)
# сам выставляет QT_QPA_FONTDIR на этот несуществующий каталог прямо при
# импорте (перебивая любое заданное заранее значение), поэтому исправлять
# переменную можно только после import cv2 — Qt читает её позже, при
# создании первого окна. Если каталог из переменной не существует,
# указываем системный каталог со шрифтами (на Manjaro/Arch там лежит DejaVu).
if not os.path.isdir(os.environ.get("QT_QPA_FONTDIR", "")) and os.path.isdir("/usr/share/fonts/TTF"):
    os.environ["QT_QPA_FONTDIR"] = "/usr/share/fonts/TTF"

log = logging.getLogger("eve_handler")

# Файл, в котором запоминаются выбранные пользователем области отслеживания
REGIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "regions.json")

# Название окна должно быть ASCII: Qt-бэкенд OpenCV не находит окно по имени
# для setMouseCallback, если title содержит не-ASCII (кириллицу) символы.
WINDOW_NAME = "Eve Handler - Region Selector (LMB: draw, u: undo, c: clear, s: save, q/Esc: cancel)"

# Максимальная высота окна предпросмотра (пиксели). Если кадр (полноразмерный
# скриншот экрана) выше этого значения, мы сами уменьшаем его перед показом —
# иначе Qt-бэкенд OpenCV пытается вписать окно в экран сам, окно оказывается
# меньше исходного кадра, и тонкая подпись над областью при таком неконтролируемом
# масштабировании становится нечитаемой или пропадает вовсе.
MAX_DISPLAY_HEIGHT = 900


def load_regions(path=REGIONS_FILE):
    """Загружает сохранённые области из JSON-файла. Возвращает [] если файла нет."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save_regions(regions, path=REGIONS_FILE):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, indent=2)
    log.info("Сохранено %d област(и/ей) в %s", len(regions), path)


def _normalize(x1, y1, x2, y2):
    return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)


def select_regions_interactive(frame, existing=None):
    """Показывает кадр и даёт пользователю мышью выделить прямоугольники.

    ЛКМ + перетаскивание — добавить область, 'u' — отменить последнюю,
    'c' — очистить всё, 's' — сохранить и выйти, 'q'/Esc — выйти без сохранения.

    Возвращает список областей для сохранения, либо None, если пользователь
    отменил выбор (закрыл окно или нажал q/Esc).
    """
    h, w = frame.shape[:2]
    # Показываем кадр в известном нам самим масштабе, а не полагаемся на
    # автоподгонку окна под экран внутри Qt (см. MAX_DISPLAY_HEIGHT выше).
    scale = min(1.0, MAX_DISPLAY_HEIGHT / h)
    disp_w, disp_h = round(w * scale), round(h * scale)

    full_view = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
    view = cv2.resize(full_view, (disp_w, disp_h), interpolation=cv2.INTER_AREA) if scale < 1.0 else full_view
    if scale < 1.0:
        log.info("Кадр %dx%d показан с масштабом %.0f%% (окно %dx%d)", w, h, scale * 100, disp_w, disp_h)

    # Внутри выбора все координаты — в масштабе окна предпросмотра (disp_*);
    # к исходному разрешению кадра возвращаемся только на выходе, в to_original().
    def to_display(r):
        return {
            "name": r["name"],
            "x1": round(r["x1"] * scale), "y1": round(r["y1"] * scale),
            "x2": round(r["x2"] * scale), "y2": round(r["y2"] * scale),
        }

    def to_original(regions_disp):
        return [
            {
                "name": r["name"],
                "x1": round(r["x1"] / scale), "y1": round(r["y1"] / scale),
                "x2": round(r["x2"] / scale), "y2": round(r["y2"] / scale),
            }
            for r in regions_disp
        ]

    regions = [to_display(r) for r in (existing or [])]
    drawing = {"active": False, "start": (0, 0), "end": (0, 0)}

    def draw_label(canvas, text, x, y):
        # Тёмная подложка под подписью — иначе тонкий текст без фона теряется
        # на пёстром фоне скриншота.
        font, font_scale, thickness = cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2
        (tw, th), baseline = cv2.getTextSize(text, font, font_scale, thickness)
        top_left = (x, y - th - baseline - 6)
        bottom_right = (x + tw + 10, y + baseline - 2)
        cv2.rectangle(canvas, top_left, bottom_right, (0, 0, 0), cv2.FILLED)
        cv2.putText(canvas, text, (x + 5, y - baseline), font, font_scale, (0, 255, 0), thickness)

    def redraw():
        canvas = view.copy()
        for r in regions:
            cv2.rectangle(canvas, (r["x1"], r["y1"]), (r["x2"], r["y2"]), (0, 255, 0), 2)
            draw_label(canvas, r["name"], r["x1"], max(r["y1"] - 10, 40))
        if drawing["active"]:
            cv2.rectangle(canvas, drawing["start"], drawing["end"], (0, 255, 255), 2)
        cv2.imshow(WINDOW_NAME, canvas)

    def on_mouse(event, x, y, _flags, _param):
        if event == cv2.EVENT_LBUTTONDOWN:
            drawing["active"] = True
            drawing["start"] = (x, y)
            drawing["end"] = (x, y)
        elif event == cv2.EVENT_MOUSEMOVE and drawing["active"]:
            drawing["end"] = (x, y)
            redraw()
        elif event == cv2.EVENT_LBUTTONUP and drawing["active"]:
            drawing["active"] = False
            x1, y1, x2, y2 = _normalize(drawing["start"][0], drawing["start"][1], x, y)
            if x2 - x1 >= 5 and y2 - y1 >= 5:
                region = {"name": f"region_{len(regions) + 1}", "x1": x1, "y1": y1, "x2": x2, "y2": y2}
                regions.append(region)
                orig = to_original([region])[0]
                log.info(
                    "Область %s добавлена: (%d, %d)-(%d, %d)",
                    orig["name"], orig["x1"], orig["y1"], orig["x2"], orig["y2"],
                )
            redraw()

    # WINDOW_AUTOSIZE — окно ровно под размер disp_w x disp_h без собственного
    # масштабирования Qt (мы уже подобрали масштаб сами через MAX_DISPLAY_HEIGHT).
    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_AUTOSIZE)
    cv2.setMouseCallback(WINDOW_NAME, on_mouse)
    redraw()

    log.info(
        "Выделите одну или несколько областей мышью (ЛКМ + перетаскивание). "
        "Клавиши: u — отменить последнюю, c — очистить всё, s — сохранить, q/Esc — выйти без сохранения."
    )

    result = None
    try:
        while True:
            key = cv2.waitKey(30) & 0xFF
            if key in (ord("q"), 27):  # Esc
                log.info("Выбор областей отменён, изменения не сохранены.")
                break
            elif key == ord("u"):
                if regions:
                    removed = regions.pop()
                    log.info("Область %s удалена.", removed["name"])
                    redraw()
            elif key == ord("c"):
                regions.clear()
                log.info("Все области очищены.")
                redraw()
            elif key == ord("s"):
                result = to_original(regions)
                break
            try:
                # Закрытие окна крестиком уничтожает внутренний Qt-объект окна
                # (а не просто скрывает его) — getWindowProperty после этого
                # бросает cv2.error вместо возврата "не видно".
                visible = cv2.getWindowProperty(WINDOW_NAME, cv2.WND_PROP_VISIBLE) >= 1
            except cv2.error:
                visible = False
            if not visible:
                log.info("Окно выбора закрыто, изменения не сохранены.")
                break
    finally:
        cv2.destroyAllWindows()

    return result
