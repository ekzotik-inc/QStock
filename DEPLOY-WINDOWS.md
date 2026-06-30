# Развёртывание QStock на Windows Server 2022

Инструкция: установить приложение и запустить его как **службу Windows**, чтобы
оно работало постоянно и автоматически стартовало при перезагрузке сервера.

Все команды выполняются в **PowerShell от имени администратора**
(ПКМ по «Пуск» → «Windows PowerShell (администратор)»).

---

## 1. Установить Node.js 22 LTS

Скачайте установщик **Node.js 22 LTS** (не 24) с https://nodejs.org →
«LTS». Установите со стандартными настройками.

> Нужен именно 22.5+ — в нём есть встроенный модуль `node:sqlite`,
> поэтому Visual Studio / компилятор C++ **не требуются**.

Проверка:
```powershell
node -v    # должно показать v22.x.x
```

## 2. Скачать приложение

```powershell
cd C:\
git clone https://github.com/ekzotik-inc/QStock.git qstock
cd C:\qstock
git checkout claude/crm-inventory-sales-system-1m050r
npm install
```

Если `git` не установлен — поставьте https://git-scm.com/download/win
или просто скачайте ZIP репозитория и распакуйте в `C:\qstock`.

## 3. Настроить параметры

Откройте файл `C:\qstock\start.cmd` в Блокноте и обязательно поменяйте:

- `QSTOCK_SECRET` — длинная случайная строка. Сгенерировать:
  ```powershell
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
  Скопируйте вывод и вставьте в `start.cmd`.
- `PORT` — `80` (сайт будет на `http://АДРЕС-СЕРВЕРА`) или `3000`, если 80 занят.

## 4. Создать демо-данные (один раз)

```powershell
cd C:\qstock
npm run seed
```

Создаст пользователей: `admin/admin123`, `bre/bre123`, `se/se123`, `se2/se123`.
**После первого входа смените пароли** (раздел «Пользователи» под админом).

## 5. Проверить, что запускается

```powershell
cd C:\qstock
.\start.cmd
```

Откройте в браузере на сервере `http://localhost` (или `http://localhost:3000`).
Если открылась страница входа — всё работает. Остановите: **Ctrl + C**.

## 6. Открыть порт в брандмауэре

Чтобы сайт был доступен снаружи (замените 80 на свой порт, если меняли):
```powershell
New-NetFirewallRule -DisplayName "QStock" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
```

> Также убедитесь, что этот порт открыт в панели управления вашего VPS
> (security group / firewall провайдера).

## 7. Запустить как службу Windows (автозапуск)

Используем **NSSM** — надёжный менеджер служб.

```powershell
# скачать и распаковать NSSM
cd C:\qstock
Invoke-WebRequest https://nssm.cc/release/nssm-2.24.zip -OutFile nssm.zip
Expand-Archive nssm.zip -DestinationPath C:\nssm -Force
$nssm = "C:\nssm\nssm-2.24\win64\nssm.exe"

# создать службу (node.exe обычно лежит здесь; проверьте путь командой: where.exe node)
& $nssm install QStock "C:\Program Files\nodejs\node.exe"
& $nssm set QStock AppParameters "--disable-warning=ExperimentalWarning server\index.js"
& $nssm set QStock AppDirectory "C:\qstock"
& $nssm set QStock AppEnvironmentExtra PORT=80 "QSTOCK_SECRET=ВАШ-СЕКРЕТ" "QSTOCK_DB=C:\qstock\data\qstock.db"
& $nssm set QStock Start SERVICE_AUTO_START

# запустить
& $nssm start QStock
```

Замените `ВАШ-СЕКРЕТ` на ту же случайную строку, что и в `start.cmd`
(и `PORT=80` на свой порт, если меняли).

Теперь сайт работает постоянно и сам поднимется после перезагрузки сервера.

### Управление службой
```powershell
& $nssm restart QStock     # перезапустить (например, после обновления)
& $nssm stop QStock        # остановить
& $nssm status QStock      # статус
& $nssm remove QStock confirm   # удалить службу
```

---

## Доступ к сайту

- На сервере: `http://localhost` (или `:3000`)
- Снаружи: `http://ПУБЛИЧНЫЙ-IP-СЕРВЕРА`

Узнать публичный IP: `(Invoke-WebRequest ifconfig.me/ip).Content`

---

## Обновление приложения

```powershell
cd C:\qstock
& "C:\nssm\nssm-2.24\win64\nssm.exe" stop QStock
git pull
npm install
& "C:\nssm\nssm-2.24\win64\nssm.exe" start QStock
```

База данных (`C:\qstock\data\`) при обновлении **не трогается** — все данные сохраняются.

---

## Резервное копирование

Вся база — это папка `C:\qstock\data\`. Достаточно периодически копировать её
(например, в облако или на другой диск). Копировать можно при остановленной службе
для гарантированной целостности.

---

## HTTPS и домен (по желанию, позже)

Для домена и https проще всего поставить **IIS** с ролью обратного прокси
(URL Rewrite + ARR) или **Caddy для Windows** (он сам получает бесплатный
сертификат Let's Encrypt). Напишите — дам отдельную инструкцию.
