PYTHON := .venv/bin/python
PIP := .venv/bin/pip

.PHONY: help run view overlay select-regions ocr-test crawl

# Цель по умолчанию — показать справку, если make вызван без аргументов
.DEFAULT_GOAL := help

RUFF ?= uvx ruff@0.17.1

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
	@echo
	@echo "Стандартные цели ~/projects:"
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

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

# --- стандартные цели ~/projects (make help) ---

.PHONY: install
install: ## окружение .venv и зависимости
	test -d .venv || uv venv --system-site-packages .venv
	uv pip install --python .venv -r requirements.txt

.PHONY: dev
dev: ## запустить
	$(PYTHON) main.py $(RESELECT_FLAG)

.PHONY: test
test: ## тесты
	@echo "тестов нет"

.PHONY: build
build: ## сборка
	@echo "сборки нет"

.PHONY: audit
audit: ## уязвимости в зависимостях
	@test -x .venv/bin/python || { echo "нет .venv — сначала make install"; exit 1; }
	uv pip freeze --python .venv/bin/python | grep -v ' @ ' > .venv/freeze.txt
	uvx pip-audit -r .venv/freeze.txt --no-deps --disable-pip

.PHONY: outdated
outdated: ## устаревшие зависимости
	@test -x .venv/bin/python || { echo "нет .venv — сначала make install"; exit 1; }
	uv pip list --outdated --python .venv/bin/python

.PHONY: check
check: ## ruff: замечания и формат (как composer check)
	$(RUFF) check .
	$(RUFF) format --check .
	npm run check

.PHONY: fix
fix: ## ruff: исправить и отформатировать (как composer fix)
	$(RUFF) check --fix . || true
	$(RUFF) format .
	npm run fix
