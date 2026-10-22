# eve

Автоматизация EVE Online по экрану: захват экрана или окна (KDE), слежение за областями, OCR (rapidocr),
нажатия клавиш через uinput (evdev), оверлей поверх окон. Плюс:

- `crawler/` — CSV по корпорациям альянса (`make crawl ALLIANCE=…`);
- `eve-status/` — статус-страница, данные обновляет `update.php` из cron каждую минуту
  (`*/eve-status/update.php`, путь в crontab абсолютный);
- `toolchain/` — сохранённый каталог EVE-софта.

## Как устроено

- `main.py` — цикл: `capture.py` (захват) → сравнение областей из `regions.json` → `ocr.py` → нажатие.
  Пороги и паузы — константы в начале `main.py`.
- `.venv` создан с `--system-site-packages`: pycairo и PyGObject для оверлея ставятся системой.

## Грабли

- `eve-status/*.json` и `update.log` переписываются cron-ом каждую минуту — в рабочей копии они всегда
  изменены, коммитить их вместе с кодом не надо.
- При переименовании каталога: crontab и шебанги в `.venv/bin` содержат абсолютные пути.

## Команды

Цели Makefile одинаковые во всех проектах `~/projects` (`make help` — список):

- `make install` — окружение .venv и зависимости
- `make dev` — запустить
- `make test` — тесты
- `make lint` — проверка синтаксиса
- `make build` — сборка
- `make audit` — уязвимости в зависимостях
- `make outdated` — устаревшие зависимости
