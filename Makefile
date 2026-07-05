PYTHON := .venv/bin/python
PIP := .venv/bin/pip

.PHONY: help run view overlay select-regions crawl venv install clean

# Цель по умолчанию — показать справку, если make вызван без аргументов
.DEFAULT_GOAL := help

# Альянс по умолчанию для краулера (переопределить: make crawl ALLIANCE=Pandemic_Horde)
ALLIANCE := Goonswarm_Federation

# Краткая справка по доступным целям
help:
	@echo "Доступные команды (make <цель>):"
	@echo "  run      — запустить main.py"
	@echo "  view     — запуск с записью видео того, что видит программа (--view)"
	@echo "  overlay  — запуск с рамкой и подписью поверх всех окон (--overlay)"
	@echo "  select-regions — выделить мышью области отслеживания и сохранить их (--select-regions)"
	@echo "  crawl    — собрать CSV-отчёт по корпорациям альянса (ALLIANCE=$(ALLIANCE))"
	@echo "  venv     — создать виртуальное окружение .venv"
	@echo "  install  — создать окружение и установить зависимости"
	@echo "  clean    — удалить виртуальное окружение"
	@echo "  help     — показать эту справку"

# Запуск скрипта через Python из виртуального окружения
run:
	$(PYTHON) main.py

# Запуск в режиме просмотра — с записью видео того, что видит программа
view:
	$(PYTHON) main.py --view

# Запуск в режиме оверлея — рамка и подпись прямо на экране поверх всех окон
overlay:
	$(PYTHON) main.py --overlay

# Выбор областей отслеживания мышью поверх снимка экрана, с сохранением в regions.json
select-regions:
	$(PYTHON) main.py --select-regions

# Сбор CSV-отчёта по корпорациям альянса с DOTLAN EveMaps
crawl:
	$(PYTHON) crawler.py $(ALLIANCE) -o corporations.csv

# Создание виртуального окружения.
# --system-site-packages нужен, чтобы был доступен системный gi/PyGObject
# (захват экрана под Wayland через PipeWire-портал).
venv:
	python -m venv --system-site-packages .venv

# Создание окружения и установка зависимостей
install: venv
	$(PIP) install --upgrade pip
	$(PIP) install numpy opencv-python evdev
	$(PIP) install requests beautifulsoup4 lxml

# Удаление виртуального окружения
clean:
	rm -rf .venv
