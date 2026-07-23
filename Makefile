PYTHON := .venv/bin/python
PIP := .venv/bin/pip

.PHONY: help run view overlay select-regions ocr-test crawl

# Цель по умолчанию — показать справку, если make вызван без аргументов
.DEFAULT_GOAL := help

# Альянс по умолчанию для краулера (переопределить: make crawl ALLIANCE=Pandemic_Horde)
ALLIANCE := Goonswarm_Federation

# RESELECT=1 — заново выбрать источник захвата (экран или окно приложения)
# в диалоге KDE вместо восстановления прошлого выбора: make run RESELECT=1
RESELECT :=
RESELECT_FLAG := $(if $(RESELECT),--reselect-source)

# Краткая справка по доступным целям
help:
	@echo "Доступные команды (make <цель>):"
	@echo "  run      — запустить main.py"
	@echo "  view     — запуск с записью видео того, что видит программа (--view)"
	@echo "  overlay  — запуск с рамкой и подписью поверх всех окон (--overlay)"
	@echo "  select-regions — выделить мышью области отслеживания и сохранить их (--select-regions)"
	@echo "  ocr-test — распознать текст в сохранённых областях и показать время распознавания (--ocr-test)"
	@echo "  (RESELECT=1 к любой из целей выше — заново выбрать источник: экран или окно приложения)"
	@echo "  crawl    — собрать CSV-отчёт по корпорациям альянса (ALLIANCE=$(ALLIANCE))"

# Запуск скрипта через Python из виртуального окружения
run:
	$(PYTHON) main.py $(RESELECT_FLAG)

# Запуск в режиме просмотра — с записью видео того, что видит программа
view:
	$(PYTHON) main.py --view $(RESELECT_FLAG)

# Запуск в режиме оверлея — рамка и подпись прямо на экране поверх всех окон
overlay:
	$(PYTHON) main.py --overlay $(RESELECT_FLAG)

# Выбор областей отслеживания мышью поверх живого изображения экрана, с сохранением в regions.json
select-regions:
	$(PYTHON) main.py --select-regions $(RESELECT_FLAG)

# Проверка OCR: распознать текст в сохранённых областях и показать время распознавания
ocr-test:
	$(PYTHON) main.py --ocr-test $(RESELECT_FLAG)

# Сбор CSV-отчёта по корпорациям альянса с DOTLAN EveMaps
crawl:
	$(PYTHON) crawler.py $(ALLIANCE) -o corporations.csv
