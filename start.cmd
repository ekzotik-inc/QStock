@echo off
REM ============================================================
REM  QStock — запуск в production на Windows Server
REM  Отредактируйте значения ниже перед первым запуском!
REM ============================================================

REM Порт, на котором работает сайт (80 = обычный http://IP без порта).
REM Если порт 80 занят (например, IIS) — поставьте 3000.
set PORT=80

REM СЕКРЕТ для подписи токенов авторизации. ОБЯЗАТЕЛЬНО смените на свой
REM длинный случайный набор символов (можно сгенерировать командой:
REM   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
set QSTOCK_SECRET=ОБЯЗАТЕЛЬНО-СМЕНИТЕ-ЭТУ-СТРОКУ-НА-СЛУЧАЙНУЮ

REM Путь к файлу базы данных (создаётся автоматически).
set QSTOCK_DB=%~dp0data\qstock.db

cd /d "%~dp0"
node --disable-warning=ExperimentalWarning server\index.js
