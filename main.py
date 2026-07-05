import time
import signal
import argparse
import logging
import cv2
import numpy as np
from evdev import UInput, ecodes as e

from capture import create_capture
from regions import load_regions, save_regions, select_regions_interactive, REGIONS_FILE

# Размер области по умолчанию в центре экрана (в пикселях), если пользователь
# не выбрал свои области через --select-regions
ROI_SIZE = 100
# Порог различия пикселя, выше которого считаем его изменившимся
PIXEL_DIFF_THRESHOLD = 25
# Доля изменившихся пикселей в области, выше которой считаем, что есть изменение
CHANGED_RATIO_THRESHOLD = 0.01
# Пауза между проверками экрана (сек). Задаёт и частоту кадров видео в режиме просмотра.
LOOP_INTERVAL = 0.1
# Минимальный интервал между автоматическими нажатиями клавиш (сек)
MIN_PRESS_INTERVAL = 0.5
# Файл, в который пишется лог
LOG_FILE = "eve_handler.log"
# Файл видео для режима просмотра
VIDEO_FILE = "eve_handler_view.mp4"
# Сколько кадров держать подпись о нажатии (~1 сек при частоте проверок 100 мс)
CAPTION_FRAMES = 10

log = logging.getLogger(__name__)


"""Настраивает логирование в консоль и, если log_to_file=True, дополнительно в файл."""
def setup_logging(log_to_file=False):
    handlers = [logging.StreamHandler()]
    if log_to_file:
        handlers.append(logging.FileHandler(LOG_FILE, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=handlers,
    )


"""Возвращает координаты (x1, y1, x2, y2) отслеживаемой области в центре кадра."""
def get_center_bbox(frame):
    h, w = frame.shape[:2]
    cy, cx = h // 2, w // 2
    half = ROI_SIZE // 2
    return cx - half, cy - half, cx + half, cy + half


"""Определяет, какие области отслеживать в этом запуске.

Если пользователь выбрал свои области через --select-regions (и они
сохранены в файле), используются они (с проверкой, что помещаются в кадр
текущего разрешения). Иначе — область ROI_SIZE x ROI_SIZE по центру экрана,
как и раньше.
"""
def resolve_regions(frame, custom_regions):
    h, w = frame.shape[:2]
    if not custom_regions:
        x1, y1, x2, y2 = get_center_bbox(frame)
        return [{"name": "center", "x1": x1, "y1": y1, "x2": x2, "y2": y2}]

    resolved = []
    for r in custom_regions:
        if r["x2"] > w or r["y2"] > h:
            log.warning(
                "Область %s (%d,%d)-(%d,%d) не помещается в кадр %dx%d — пропущена",
                r["name"], r["x1"], r["y1"], r["x2"], r["y2"], w, h,
            )
            continue
        resolved.append(r)
    if not resolved:
        raise RuntimeError(
            "Ни одна сохранённая область не подходит под текущее разрешение экрана. "
            "Перезапустите выбор областей через --select-regions."
        )
    return resolved


"""Вырезает прямоугольник bbox из кадра и переводит его в оттенки серого."""
def get_region_gray(frame, bbox):
    x1, y1, x2, y2 = bbox
    return cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGRA2GRAY)


"""Сравнивает каждую отслеживаемую область текущего кадра с предыдущей.

regions — список областей {"name","x1","y1","x2","y2"}, prev_grays — список
их изображений в оттенках серого с прошлой итерации (или None на первом кадре),
в том же порядке.

Возвращает кортеж (имена_сработавших_областей, новые_prev_grays).
"""
def check_regions(frame, regions, prev_grays):
    triggered = []
    new_grays = []
    for region, prev in zip(regions, prev_grays):
        bbox = (region["x1"], region["y1"], region["x2"], region["y2"])
        gray = get_region_gray(frame, bbox)

        if prev is not None:
            diff = cv2.absdiff(gray, prev)
            changed_pixels = np.count_nonzero(diff > PIXEL_DIFF_THRESHOLD)
            changed_ratio = changed_pixels / diff.size
            if changed_ratio > CHANGED_RATIO_THRESHOLD:
                triggered.append(region["name"])
                log.info(
                    "Изменения в области «%s»: %.2f%% пикселей (порог %.2f%%)",
                    region["name"], changed_ratio * 100, CHANGED_RATIO_THRESHOLD * 100,
                )
        new_grays.append(gray)
    return triggered, new_grays


"""Готовит кадр для записи в видео — ровно так, как его «видит» программа.

Рисует рамку вокруг каждой отслеживаемой области (красную для тех, что
изменились в этом кадре — triggered_names, иначе зелёную) и подпись о
нажатии рядом с областью caption_region, пока caption_frames > 0.
"""
def render_view_frame(frame, regions, triggered_names, caption_frames, caption_region):
    # VideoWriter ожидает BGR, кадр захвата приходит в BGRA.
    view = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)

    for region in regions:
        x1, y1, x2, y2 = region["x1"], region["y1"], region["x2"], region["y2"]
        color = (0, 0, 255) if region["name"] in triggered_names else (0, 255, 0)
        cv2.rectangle(view, (x1, y1), (x2, y2), color, 2)

    if caption_frames > 0 and caption_region is not None:
        x1, y1 = caption_region["x1"], caption_region["y1"]
        cv2.putText(
            view, "AUTO Ctrl+Q", (x1, max(y1 - 12, 20)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2, cv2.LINE_AA,
        )
    return view


"""Безопасно зажимает и отпускает комбинацию двух клавиш."""
def press_combo(ui, key1, key2):
    ui.write(e.EV_KEY, key1, 1) # Нажать key1
    ui.write(e.EV_KEY, key2, 1) # Нажать key2
    ui.syn()

    time.sleep(0.05) # Короткая задержка для регистрации игрой/программой

    ui.write(e.EV_KEY, key2, 0) # Отпустить key2
    ui.write(e.EV_KEY, key1, 0) # Отпустить key1
    ui.syn()


"""Создаёт VideoWriter под размер кадра. Частота кадров соответствует частоте проверок."""
def open_video_writer(frame):
    h, w = frame.shape[:2]
    fps = 1.0 / LOOP_INTERVAL
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(VIDEO_FILE, fourcc, fps, (w, h))
    if not writer.isOpened():
        raise RuntimeError(f"Не удалось открыть видеофайл {VIDEO_FILE} для записи")
    log.info("Режим просмотра: запись в %s (%dx%d, %.0f FPS)", VIDEO_FILE, w, h, fps)
    return writer


def main(view=False, overlay=False, regions_file=REGIONS_FILE):
    # Чтобы при завершении по SIGTERM (kill/timeout) тоже отработал finally
    # и видео корректно финализировалось — превращаем сигнал в KeyboardInterrupt.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    custom_regions = load_regions(regions_file)
    if custom_regions:
        log.info(
            "Загружено %d сохранённых област(и/ей) из %s: %s",
            len(custom_regions), regions_file, ", ".join(r["name"] for r in custom_regions),
        )
    else:
        log.info(
            "Файл областей не найден (%s) — используется область %dx%d по центру экрана. "
            "Запустите main.py --select-regions, чтобы выбрать свои области.",
            regions_file, ROI_SIZE, ROI_SIZE,
        )

    log.info("Инициализация виртуальной клавиатуры (требуются права sudo/input)...")
    ui = UInput()

    active_regions = None
    prev_grays = None
    writer = None
    screen_overlay = None
    caption_frames = 0  # сколько ещё кадров показывать подпись о нажатии
    caption_region = None  # область, рядом с которой рисовать подпись, пока caption_frames > 0
    size_logged = False
    last_press_time = 0.0  # время последнего автонажатия для ограничения частоты

    cap = create_capture()
    if any(isinstance(h, logging.FileHandler) for h in logging.getLogger().handlers):
        log.info("Лог пишется в %s. Нажмите Ctrl+C в терминале для выхода.", LOG_FILE)
    else:
        log.info("Нажмите Ctrl+C в терминале для выхода.")
    try:
        while True:
            frame = cap.grab()

            if not size_logged:
                h, w = frame.shape[:2]
                log.info("Источник кадров готов: %sx%s", w, h)
                size_logged = True

            if active_regions is None:
                active_regions = resolve_regions(frame, custom_regions)
                prev_grays = [None] * len(active_regions)
                if overlay:
                    from overlay import ScreenOverlay
                    screen_overlay = ScreenOverlay(active_regions, flash_secs=1.0)

            triggered_names, prev_grays = check_regions(frame, active_regions, prev_grays)
            triggered_set = set(triggered_names)
            action_needed = bool(triggered_names)

            pressed = False
            if action_needed:
                now = time.monotonic()
                if now - last_press_time >= MIN_PRESS_INTERVAL:
                    log.info("Нажимаем Ctrl + Q (сработали области: %s)", ", ".join(triggered_names))
                    press_combo(ui, e.KEY_LEFTCTRL, e.KEY_Q)
                    last_press_time = now
                    caption_frames = CAPTION_FRAMES
                    caption_region = next(r for r in active_regions if r["name"] == triggered_names[0])
                    pressed = True
                else:
                    log.debug(
                        "Нажатие пропущено: не прошло %.0f мс с прошлого",
                        MIN_PRESS_INTERVAL * 1000,
                    )

            if screen_overlay is not None:
                screen_overlay.update(triggered_set if pressed else set(), caption="Авто: Ctrl+Q")

            if view:
                if writer is None:
                    writer = open_video_writer(frame)
                writer.write(render_view_frame(frame, active_regions, triggered_set, caption_frames, caption_region))
                if caption_frames > 0:
                    caption_frames -= 1

            # Проверка экрана раз в LOOP_INTERVAL секунд
            time.sleep(LOOP_INTERVAL)

    except KeyboardInterrupt:
        log.info("Скрипт остановлен пользователем (Ctrl+C).")
    except Exception:
        log.exception("Непредвиденная ошибка, скрипт аварийно завершён")
        raise
    finally:
        if writer is not None:
            writer.release()
            log.info("Видео сохранено в %s", VIDEO_FILE)
        if screen_overlay is not None:
            screen_overlay.close()
        cap.close()
        ui.close()
        log.info("Виртуальная клавиатура закрыта.")


"""Режим выбора областей: снимает один кадр экрана и даёт пользователю
выделить мышью области отслеживания, затем сохраняет их в regions_file
для использования в обычном запуске."""
def run_region_selection(regions_file):
    log.info("Захват кадра для выбора областей...")
    cap = create_capture()
    try:
        frame = cap.grab()
    finally:
        cap.close()

    existing = load_regions(regions_file)
    if existing:
        log.info("Загружено %d ранее сохранённых област(и/ей) — можно дополнить или изменить их.", len(existing))

    regions = select_regions_interactive(frame, existing=existing)
    if regions is None:
        return
    save_regions(regions, regions_file)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Отслеживание изменений в заданных областях экрана и автонажатие Ctrl+Q.")
    parser.add_argument(
        "--view", action="store_true",
        help=f"Режим просмотра: записывать то, что видит программа, в {VIDEO_FILE}",
    )
    parser.add_argument(
        "--overlay", action="store_true",
        help="Режим оверлея: рисовать рамку и подпись прямо на экране поверх всех окон",
    )
    parser.add_argument(
        "--select-regions", action="store_true",
        help="Режим выбора областей: выделить мышью зоны отслеживания на снимке экрана и сохранить их для дальнейших запусков",
    )
    parser.add_argument(
        "--regions-file", default=REGIONS_FILE,
        help=f"Файл с сохранёнными областями отслеживания (по умолчанию {REGIONS_FILE})",
    )
    parser.add_argument(
        "--log-file", action="store_true",
        help=f"Дополнительно писать лог в файл {LOG_FILE} (по умолчанию только в консоль)",
    )
    args = parser.parse_args()
    setup_logging(log_to_file=args.log_file)
    if args.select_regions:
        run_region_selection(args.regions_file)
    else:
        main(view=args.view, overlay=args.overlay, regions_file=args.regions_file)
