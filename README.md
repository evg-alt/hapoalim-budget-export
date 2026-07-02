# Hapoalim PFM parsing

Проект для автоматического сбора данных из раздела **ניהול תקציב** (управление бюджетом) в банке Hapoalim через Playwright.

Цель — для выбранных месяцев собрать все **расходы** и **доходы** по категориям (с раскрытием подтаблиц) и сохранить результат в `output/`.

## Структура репозитория

```text
lib/                    Общие хелперы Playwright (iframe, readiness, mode switch)
scripts/
  scrape.js             Основной сбор данных
  explore/              Интерактивное исследование UI
    keep-open.js        Долгоживущий браузер + CDP
    snapshot.js         Снимок экрана без закрытия браузера
    switch-mode.js      Переключение расходы / доходы
docs/                   Документация и best practices
output/                 Результаты scrape (JSON/CSV) — не коммитится
explore/                Локальные снимки при исследовании — не коммитится
.browser-profile/       Сессия Chromium — не коммитится
```

## Требования

- Node.js
- Playwright глобально (`npm root -g` → `playwright`)

## Команды

```bash
npm run scrape                      # текущий месяц
npm run scrape -- --months 3
npm run scrape -- --month "יוני 26"

npm run keep-open                   # браузер остаётся открытым
npm run snapshot                    # снимок (пока keep-open запущен)
npm run switch-mode -- income       # режим доходов
npm run switch-mode -- expenses     # режим расходов
```

Короткие обёртки: `./run.sh`, `./keep-open.sh`, `./snapshot.sh`, `./switch-mode.sh`

## Для агентов

`AGENTS.md` · `SNAPSHOT.md` · `BACKLOG.md` · **`docs/hapoalim-pfm-parsing.md`**
