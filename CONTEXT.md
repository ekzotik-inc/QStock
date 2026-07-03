# QStock — контекст проекта

Внутренняя CRM для учёта остатков SKU и продаж по розничным точкам
(товары формата IQOS/TEREA) в Узбекистане. Документ описывает, **зачем**
существует проект, **как он устроен** и **как с ним работать** — чтобы новый
разработчик (или новая сессия ассистента) мог быстро войти в контекст.

---

## 1. Что решает для бизнеса

Сеть розничных точек продаёт устройства и стики. Раньше остатки и продажи вели
в разрозненных таблицах — не было единой картины «сколько чего осталось на точке
прямо сейчас», продавцы (SE) путались в пересменках, а закупщик (BRE) не понимал,
что и куда везти срочно.

QStock даёт:

- **Единый учёт смены** — продавец в начале смены фиксирует остатки, в течение дня
  отмечает продажи/поступления/списания, в конце закрывает смену. Остаток вечером
  считается автоматически: `остаток = утро + приход − продано − списание ± корректировки`.
- **Живую картину по всем точкам** — BRE и админ видят онлайн-монитор остатков,
  критические позиции подсвечиваются «везти срочно».
- **Расчёт закупа** — с учётом страхового запаса (%) и срока поставки (lead time)
  по каждому SKU, по одной точке или по всем сразу.
- **Дисциплину процессов** — инвентаризации (в т.ч. по расписанию), апрув
  списаний/возвратов (SE → BRE), задачи на точку с комментариями и уведомлениями,
  заметки, полная история движений и закрытых смен, выгрузка в Excel.

Роли: **ADMIN** (управление системой, SKU/цены, пользователи, вкладки),
**BRE** (закупщик/супервайзер — видит все точки, дашборды, закуп, апрувы, задачи),
**SE** (продавец — работает со сменой на своей точке). До ~100 пользователей.

UI полностью на русском, валюта — **сум**.

---

## 2. Технологический стек

| Слой | Технология | Примечание |
|------|-----------|-----------|
| Runtime | Node.js ≥ 22.16 (закреплён 22.22.2 в `.node-version`) | нужен **непомеченный** `node:sqlite` |
| БД | `node:sqlite` (`DatabaseSync`, встроен в Node) | без нативной сборки, файл на диске |
| Сервер | Express 4 | REST API под `/api/*` |
| Реалтайм | Socket.IO 4 | комнаты `point:${id}`, `monitor`, `user:${id}` |
| Auth | JWT в cookie `qstoken` + `bcryptjs` | роль-гейты ADMIN/BRE/SE |
| Фронтенд | Vanilla JS SPA (`public/app.js`, один файл) | без сборки, без фреймворков |
| Excel | собственный писатель `server/xlsx.js` | CRC32 + stored-ZIP + OpenXML, без зависимостей |
| Деплой | Render.com (free), blueprint `render.yaml` | есть и инструкция под Windows/NSSM |

Осознанные решения:
- **`node:sqlite` вместо `better-sqlite3`** — на Windows/Node 24 нативная сборка
  падала; встроенный модуль не требует компиляции. В `server/db.js` есть
  compat-хелпер `db.transaction()`.
- **Свой xlsx-writer** — чтобы не тянуть зависимости на free-хостинг.
- **SPA в одном файле** — простота деплоя статики, no-cache заголовки от stale-кэша.

---

## 3. Структура репозитория

```
server/
  index.js         точка входа: Express + Socket.IO, монтирование роутов, статика, /api/health
  db.js            схема БД (CREATE TABLE ...), миграции через addColumn()
  auth.js          hashPassword, authRequired, requireRole, выдача/проверка JWT
  access.js        canSeePoint, seConnected, visiblePointIds — видимость по ролям
  util.js          audit(), currentStock(), today()
  stock.js         recordMovement(), checkLowStock(), emitStockLine()
  realtime.js      rt.emitPoint / emitUser / emitAll — обёртки над Socket.IO
  xlsx.js          sendXlsx() + генерация .xlsx без зависимостей
  bootstrap.js     seed() + демо-точка Compass (14 дней) + seedCategories()
  seed.js          CLI-обёртка `npm run seed`
  scheduler.js     плановые инвентаризации (по расписанию)
  routes/
    users.js       CRUD пользователей (ADMIN)
    skus.js        справочник SKU, цены, импорт CSV, категории (порядок + вкладки)
    points.js      точки, connect/disconnect SE, pointSummary
    shifts.js      смены: open/close/force-close/reopen, продажи/приход/списание, Excel, история
    inventory.js   инвентаризации, расписания, /history
    analytics.js   дашборд, KPI, графики
    requests.js    заявки на списание/возврат (апрув SE → BRE)
    notes.js       заметки на точку (важность/статус/закрепление)
    tasks.js       задачи на точку + комментарии + уведомления
    misc.js        закуп (procurement), логи точки, движения SKU
public/
  index.html       каркас SPA
  app.js           весь фронтенд (~2100 строк): роутинг, view-функции, realtime
  styles.css       дизайн-система (светлая + тёмная тема, бирюза #00d1d2, шрифт Manrope)
tests/
  run.js           API-тесты (76 сценариев по user story)
  ui.js            Playwright E2E (34, chromium из /opt/pw-browsers/chromium)
  scheduler.js     тесты планировщика (2)
docs/
  feature-tracker.csv   ~130 user stories со статусом Verified/PASS
render.yaml        blueprint для Render
DEPLOY-WINDOWS.md  инструкция под Windows Server + NSSM
README.md          быстрый старт
```

---

## 4. Модель данных (ключевые таблицы)

- **users** — full_name, login (COLLATE NOCASE), password_hash, role.
- **points** — name, address, bre_id, max_se, sale_mode, shift_end_time.
- **point_se** — связь точка↔подключённый SE (point_id, se_id, connected_at).
  *Подключённых SE максимум `max_se`. При закрытии смены строки точки очищаются.*
- **skus** — name, article, category, price, min_stock, **safety_pct**, **lead_days**, active.
- **price_history** — история изменений цены.
- **shifts** — point_id, status(open/closed), business_date, needs_inventory,
  opened_by/opened_at, closed_by/closed_at.
- **shift_stock** — снапшот смены по SKU: opening, income, sales_qty, writeoff, **adjust**.
  Текущий остаток = `opening + income − sales_qty − writeoff + adjust`.
- **movements** — журнал движений (opening/carryover/income/sale/writeoff/adjustment).
- **sales** — фиксация продаж (для аналитики/цены на момент продажи).
- **inventories / inventory_items / inventory_schedules** — инвентаризации и расписания.
- **stock_requests** — заявки на списание/возврат с апрувом (pending/approved/rejected).
- **notes** — заметки: text, importance, status, pinned.
- **sku_categories** — name UNIQUE, sort_order, **as_tab** (категория-вкладка на главной SE).
- **point_tasks / task_comments** — задачи на точку и комментарии к ним.
- **audit_log**, **notifications** — аудит и уведомления.

Миграции — идемпотентные, через `addColumn()` в `server/db.js` (новые колонки
добавляются на старте без потери данных).

---

## 5. Доменная логика, о которой важно помнить

- **Глобальные SKU.** Импорт/цена/включение-выключение SKU админом отражается у всех
  мгновенно. `shiftDetail()` для **открытой** смены строит строки как
  `skus LEFT JOIN shift_stock` (новый активный SKU появляется сразу, выключенный без
  операций — исчезает); для **закрытой** смены — замороженный снапшот
  `shift_stock JOIN skus`. Фронт по событию `sku:changed` обновляет все SKU-зависимые
  экраны (кроме случая, когда пользователь печатает — фокус в `.sold-input`/`.arr-input`).
- **Закрытие смены освобождает SE.** При `POST /api/shifts/:id/close` (обычное) и
  `/:id/force-close` (админ) вызывается `disconnectAllSE(pointId)`: удаляются строки
  `point_se` точки и шлётся `point:changed`, счётчик подключённых обнуляется в реальном
  времени. Чтобы открыть новую смену, SE должен заново подключиться к точке.
- **Порядок категорий.** Устройства → Стики → Аксессуары → прочие (по `sort_order`).
  Категории с `as_tab=1` («Девайсы для замены», «Тест-драйв 14 дней») выводятся
  отдельными вкладками на главной SE. Порядок и признак-вкладку задаёт админ.
- **Апрув списаний/возвратов.** SE создаёт заявку → BRE принимает/отклоняет; при апруве
  корректируется `shift_stock.adjust` и пишется движение.
- **Реалтайм.** `rt.emitPoint(pointId, event, data)` → комнаты `point:${id}` и `monitor`;
  `rt.emitUser(userId, ...)` для персональных уведомлений. Фронт — `handleRealtime()`
  вызывает `App._refresh` для актуального экрана.

---

## 6. Запуск и разработка

```bash
npm install
npm run seed        # заполнить демо-данными (админ/BRE/SE, точки, SKU, Compass)
npm start           # http://localhost:3000  (PORT переопределяется env)
npm run dev         # то же с --watch
```

Демо-логины (пароли из `bootstrap.js`): `admin/admin123`, `bre/bre123`,
`se/se123`, а также команда точки Compass: `nikita`, `georgiy`, `anna`, `milana` (все `se123`).

Переменные окружения: `PORT`, `JWT_SECRET`, `QSTOCK_DB` (путь к файлу БД;
на Render — `/opt/render/project/src/data`, т.к. на free-тарифе нет диска).

`GET /api/health` — версия и состояние для диагностики деплоя (видно и на экране логина).

---

## 7. Тесты

Все прогоны идут на **отдельной временной БД** (`QSTOCK_DB`) и временном порту.
Важно: фоновые серверы между вызовами Bash пересоздаются — **запускать сервер и
тесты в одном вызове**.

```bash
# API (76 сценариев)
rm -f /tmp/qs-test.db && QSTOCK_DB=/tmp/qs-test.db PORT=3010 JWT_SECRET=test \
  node server/index.js & sleep 2 && BASE=http://localhost:3010 node tests/run.js

npm run test:ui     # Playwright, 34 (chromium: /opt/pw-browsers/chromium)
npm run test:sched  # планировщик, 2
```

`docs/feature-tracker.csv` — трекер user story (~130 пунктов, все Verified/PASS).

---

## 8. Деплой

- **Render.com** — blueprint `render.yaml`, Node закреплён `.node-version` = 22.22.2
  (в 22.11 `node:sqlite` был под флагом). Статика отдаётся с no-cache заголовками,
  чтобы браузер не держал stale-версию SPA.
- **Windows Server + NSSM** — см. `DEPLOY-WINDOWS.md` и `start.cmd`.

Замеченные грабли (для истории):
- Кириллица в `Content-Disposition` ломала HTTP-заголовок → имена файлов латиницей
  (`order-point-${pid}.xlsx`).
- `requireRole` без `authRequired` → `req.user` undefined; auth монтируется на уровне роутов.
- 401 «не заходит» в проде — почти всегда автозаполнение браузером неверного пароля;
  логин тримится, регистронезависим (COLLATE NOCASE), ошибка показывается под формой.

---

## 9. Соглашения

- Ветка разработки: `claude/crm-inventory-sales-system-1m050r`.
- PR не создавать без явной просьбы пользователя.
- Трейлер коммита:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017ALsttRJyyfzytVkQtdT9p
  ```
- Идентификатор модели в коммиты/код/PR не добавлять.
- Валюта — «сум» (не «сўм»), имена сотрудников подсвечиваются бирюзовым в UI.
