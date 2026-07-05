"""Источник кадров экрана.

Под Wayland mss отдаёт чёрный кадр, поэтому захват идёт через портал
xdg-desktop-portal (интерфейс ScreenCast) + PipeWire, кадры читаются
GStreamer-конвейером.

Интерфейс:
    cap.grab()  -> numpy-массив кадра (H, W, 4), порядок каналов BGRx/BGRA
    cap.close()
    cap.width / cap.height  (известны после первого grab)
"""
import os
import logging

import numpy as np

log = logging.getLogger("eve_handler")

# Файл, где KDE-портал запоминает разрешение на захват (чтобы не спрашивать каждый раз)
RESTORE_TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".screencast_restore_token")


class PipeWireCapture:
    """Захват экрана под Wayland через xdg-desktop-portal (ScreenCast) + PipeWire/GStreamer."""

    def __init__(self):
        import gi
        gi.require_version("Gst", "1.0")
        gi.require_version("GstApp", "1.0")
        # GstApp нужен, чтобы у appsink появились методы вроде try_pull_sample.
        from gi.repository import Gst, GstApp, GLib, Gio  # noqa: F401

        self._Gst, self._GLib, self._Gio = Gst, GLib, Gio
        self.width = None
        self.height = None
        self._token_counter = 0

        Gst.init(None)
        fd, node_id = self._portal_setup()
        self._build_pipeline(fd, node_id)

    # ---------- handshake с порталом ----------

    def _next_token(self):
        self._token_counter += 1
        return f"eve{self._token_counter}"

    def _call(self, method, build_params):
        """Вызывает метод портала и ждёт асинхронный сигнал Response."""
        Gio, GLib = self._Gio, self._GLib
        tok = self._next_token()
        stok = self._next_token()
        request_path = f"/org/freedesktop/portal/desktop/request/{self._sender}/{tok}"
        captured = {}

        def on_response(_conn, _sender, _path, _iface, _signal, params):
            code, res = params.unpack()
            captured["code"], captured["res"] = code, res
            self._loop.quit()

        sub = self._bus.signal_subscribe(
            "org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request",
            "Response", request_path, None, Gio.DBusSignalFlags.NONE, on_response,
        )
        try:
            self._screencast.call_sync(
                method, build_params(tok, stok), Gio.DBusCallFlags.NONE, -1, None,
            )
            self._loop.run()
        finally:
            self._bus.signal_unsubscribe(sub)

        if captured.get("code") != 0:
            raise RuntimeError(f"Портал отклонил {method} (код {captured.get('code')})")
        return captured["res"]

    def _read_restore_token(self):
        try:
            with open(RESTORE_TOKEN_FILE, encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""

    def _save_restore_token(self, token):
        if not token:
            return
        try:
            with open(RESTORE_TOKEN_FILE, "w", encoding="utf-8") as f:
                f.write(token)
        except OSError as exc:
            log.warning("Не удалось сохранить restore_token: %s", exc)

    def _portal_setup(self):
        Gio, GLib = self._Gio, self._GLib
        self._bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self._sender = self._bus.get_unique_name()[1:].replace(".", "_")
        self._loop = GLib.MainLoop()
        self._screencast = Gio.DBusProxy.new_sync(
            self._bus, Gio.DBusProxyFlags.NONE, None,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast", None,
        )

        # 1. Создать сессию
        res = self._call("CreateSession", lambda tok, stok: GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", tok),
            "session_handle_token": GLib.Variant("s", stok),
        },)))
        self._session = res["session_handle"]
        log.info("Портал: сессия ScreenCast создана")

        # 2. Выбрать источник — монитор, курсор скрыт (чтобы движение мыши не давало ложных срабатываний)
        self._call("SelectSources", lambda tok, _stok: GLib.Variant("(oa{sv})", (self._session, {
            "handle_token": GLib.Variant("s", tok),
            "types": GLib.Variant("u", 1),        # 1 = монитор
            "multiple": GLib.Variant("b", False),
            "cursor_mode": GLib.Variant("u", 1),  # 1 = курсор скрыт
        })))

        # 3. Старт. Если есть сохранённый restore_token — KDE не покажет диалог.
        restore = self._read_restore_token()
        if restore:
            log.info("Портал: пробуем восстановить прошлое разрешение (без диалога)")
        else:
            log.info("Портал: подтвердите выбор экрана в диалоге KDE...")

        def start_params(tok, _stok):
            opts = {
                "handle_token": GLib.Variant("s", tok),
                "persist_mode": GLib.Variant("u", 2),  # 2 = помнить, пока не отозвано
            }
            if restore:
                opts["restore_token"] = GLib.Variant("s", restore)
            return GLib.Variant("(osa{sv})", (self._session, "", opts))

        res = self._call("Start", start_params)
        self._save_restore_token(res.get("restore_token", ""))

        streams = res["streams"]
        if not streams:
            raise RuntimeError("Портал не вернул ни одного потока для захвата")
        node_id = streams[0][0]
        log.info("Портал: захват разрешён, node id = %s", node_id)

        # 4. Получить файловый дескриптор соединения с PipeWire
        ret, fdlist = self._screencast.call_with_unix_fd_list_sync(
            "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (self._session, {})),
            Gio.DBusCallFlags.NONE, -1, None, None,
        )
        fd = fdlist.get(ret.unpack()[0])
        return fd, node_id

    # ---------- конвейер GStreamer ----------

    def _build_pipeline(self, fd, node_id):
        Gst = self._Gst
        desc = (
            f"pipewiresrc fd={fd} path={node_id} ! "
            "videoconvert ! video/x-raw,format=BGRx ! "
            "appsink name=sink max-buffers=1 drop=true sync=false"
        )
        self._pipeline = Gst.parse_launch(desc)
        self._appsink = self._pipeline.get_by_name("sink")
        self._pipeline.set_state(Gst.State.PLAYING)
        self._pipeline.get_state(5 * Gst.SECOND)  # дождаться выхода в PLAYING

    def grab(self):
        Gst = self._Gst
        sample = self._appsink.try_pull_sample(5 * Gst.SECOND)
        if sample is None:
            raise RuntimeError("PipeWire: кадр не получен (таймаут)")

        buf = sample.get_buffer()
        s = sample.get_caps().get_structure(0)
        w, h = s.get_value("width"), s.get_value("height")

        ok, mapinfo = buf.map(Gst.MapFlags.READ)
        if not ok:
            raise RuntimeError("PipeWire: не удалось прочитать буфер кадра")
        try:
            arr = np.frombuffer(mapinfo.data, dtype=np.uint8)
            # Строка кадра может быть выровнена с запасом — учитываем реальный stride.
            stride_px = (arr.size // h) // 4
            frame = arr.reshape(h, stride_px, 4)[:, :w, :].copy()
        finally:
            buf.unmap(mapinfo)

        self.width, self.height = w, h
        return frame  # BGRx ≈ BGRA

    def close(self):
        self._pipeline.set_state(self._Gst.State.NULL)


def create_capture():
    """Создаёт источник кадров (захват через PipeWire-портал)."""
    log.info("Источник кадров: PipeWire-портал")
    return PipeWireCapture()
