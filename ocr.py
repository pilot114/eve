"""Распознавание текста в областях кадра через RapidOCR.

Настройки подобраны под скорость на CPU (цель — меньше 100 мс на область):
  - OpenVINO-бэкенд: на этих моделях примерно вдвое быстрее onnxruntime;
  - Det.limit_type=max: не увеличивать маленькие области до 736px перед
    детекцией (стандартный limit_type=min апскейлит и делает всё в разы
    медленнее);
  - use_cls=False: текст в интерфейсе игры не бывает перевёрнутым,
    классификатор ориентации только тратит время.
"""
import logging
import time

import numpy as np
import cv2

log = logging.getLogger("eve_handler")


class RegionOCR:
    """Обёртка над RapidOCR для распознавания текста в вырезанных областях кадра."""

    def __init__(self):
        from rapidocr import RapidOCR, EngineType

        t0 = time.perf_counter()
        self._engine = RapidOCR(params={
            "Det.limit_type": "max",
            "Det.limit_side_len": 736,
            "Det.engine_type": EngineType.OPENVINO,
            "Rec.engine_type": EngineType.OPENVINO,
            "Global.log_level": "warning",
        })
        # Прогрев: первый вызов компилирует графы OpenVINO (сотни миллисекунд).
        # В прогревочной картинке должен быть текст — иначе детектор ничего не
        # найдёт, до распознавателя дело не дойдёт и его граф скомпилируется
        # только в рабочем цикле.
        warm = np.zeros((64, 256, 3), np.uint8)
        cv2.putText(warm, "warmup 123", (8, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
        self._engine(warm, use_cls=False)
        log.info("RapidOCR готов за %.1f с", time.perf_counter() - t0)

    def recognize(self, region_bgra):
        """Распознаёт текст в вырезанной области кадра (BGRA или BGR).

        Возвращает список распознанных строк (в порядке сверху вниз);
        пустой список, если текста не найдено.
        """
        if region_bgra.shape[2] == 4:
            img = cv2.cvtColor(region_bgra, cv2.COLOR_BGRA2BGR)
        else:
            img = region_bgra
        result = self._engine(img, use_cls=False)
        if result.txts is None:
            return []
        return list(result.txts)
