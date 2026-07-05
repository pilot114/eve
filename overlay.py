"""Экранный оверлей поверх всех окон (KDE Wayland, через wlr-layer-shell).

Рисует рамку вокруг отслеживаемой области и подпись при автонажатии прямо на
экране — прозрачным сквозным (click-through) окном, не перехватывая ввод.

Рамка рисуется чуть СНАРУЖИ зоны детекции (с зазором GAP), чтобы оверлей,
попадая в захват экрана, не загрязнял отслеживаемую область и не вызывал
ложных срабатываний.
"""
import time
import logging

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
from gi.repository import Gtk, GtkLayerShell  # noqa: E402
import cairo  # noqa: E402

log = logging.getLogger("eve_handler")

# Зазор между зоной детекции и рисуемой рамкой (пиксели)
GAP = 8


class ScreenOverlay:
    def __init__(self, regions, flash_secs=1.0):
        """regions — список отслеживаемых областей: {"name", "x1", "y1", "x2", "y2"}."""
        self.regions = regions
        self.flash_secs = flash_secs
        self.caption = ""
        self.active_until = {}  # name -> момент, до которого рамка этой области красная

        self.win = Gtk.Window()
        GtkLayerShell.init_for_window(self.win)
        GtkLayerShell.set_layer(self.win, GtkLayerShell.Layer.OVERLAY)
        for edge in (GtkLayerShell.Edge.LEFT, GtkLayerShell.Edge.RIGHT,
                     GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.BOTTOM):
            GtkLayerShell.set_anchor(self.win, edge, True)
        GtkLayerShell.set_exclusive_zone(self.win, -1)  # не резервировать место, перекрывать всё
        GtkLayerShell.set_keyboard_mode(self.win, GtkLayerShell.KeyboardMode.NONE)

        # Прозрачный фон
        self.win.set_app_paintable(True)
        visual = self.win.get_screen().get_rgba_visual()
        if visual is None:
            raise RuntimeError("Нет RGBA-визуала: композитор не поддерживает прозрачность")
        self.win.set_visual(visual)

        self.win.connect("draw", self._on_draw)
        self.win.connect("realize", self._on_realize)
        # После растягивания окна на весь экран входная область сбрасывается —
        # переустанавливаем её пустой на каждом size-allocate.
        self.win.connect("size-allocate", self._on_size_allocate)
        self.win.show_all()
        self._set_click_through()
        self.pump()
        log.info("Оверлей включён (слой OVERLAY, click-through)")

    def _set_click_through(self):
        # Пустая входная область -> окно не перехватывает мышь (клики проходят насквозь).
        gdk_win = self.win.get_window()
        if gdk_win is not None:
            gdk_win.input_shape_combine_region(cairo.Region(), 0, 0)

    def _on_realize(self, widget):
        self._set_click_through()

    def _on_size_allocate(self, widget, allocation):
        self._set_click_through()

    def _on_draw(self, widget, cr):
        # Очистить поверхность в прозрачный цвет
        cr.set_operator(cairo.Operator.SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.Operator.OVER)

        now = time.time()
        caption_region = None
        for region in self.regions:
            active = now < self.active_until.get(region["name"], 0.0)
            if active and caption_region is None:
                caption_region = region

            x1, y1 = region["x1"] - GAP, region["y1"] - GAP
            x2, y2 = region["x2"] + GAP, region["y2"] + GAP

            # Рамка: красная при срабатывании, иначе зелёная
            cr.set_source_rgba(1.0, 0.0, 0.0, 0.95) if active else cr.set_source_rgba(0.0, 1.0, 0.0, 0.95)
            cr.set_line_width(2)
            cr.rectangle(x1, y1, x2 - x1, y2 - y1)
            cr.stroke()

        # Подпись над рамкой области, которая сработала (вне зоны детекции)
        if caption_region is not None and self.caption:
            cx = (caption_region["x1"] + caption_region["x2"]) // 2
            ty = caption_region["y1"] - GAP - 14

            cr.select_font_face("Sans", cairo.FontSlant.NORMAL, cairo.FontWeight.BOLD)
            cr.set_font_size(26)
            ext = cr.text_extents(self.caption)
            tx = cx - ext.width / 2
            # Тёмная подложка для читаемости
            cr.set_source_rgba(0, 0, 0, 0.55)
            cr.rectangle(tx - 8, ty - ext.height - 8, ext.width + 16, ext.height + 16)
            cr.fill()
            cr.set_source_rgba(1.0, 0.2, 0.2, 1.0)
            cr.move_to(tx, ty)
            cr.show_text(self.caption)
        return False

    def update(self, triggered_names, caption=""):
        """Вызывается каждый тик. triggered_names — имена сработавших областей:
        для них на flash_secs рамка краснеет и показывается подпись."""
        if triggered_names:
            now = time.time()
            for name in triggered_names:
                self.active_until[name] = now + self.flash_secs
            if caption:
                self.caption = caption
        # Переутверждаем click-through на каждом тике — на случай, если GTK сбросил область
        self._set_click_through()
        self.win.queue_draw()
        self.pump()

    def pump(self):
        """Обрабатывает события GTK без блокирующего главного цикла."""
        while Gtk.events_pending():
            Gtk.main_iteration_do(False)

    def close(self):
        self.win.destroy()
        self.pump()
