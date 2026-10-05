@echo off
chcp 65001 >nul
rem はじめに1回だけ動かす。必要な部品を入れて、設定ファイルのひな形を置く。
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js が入っていません。https://nodejs.org/ja から LTS 版を入れてから、もう一度動かしてください。& pause & exit /b 1)
call npm install --no-audit --no-fund
if not exist .env copy .env.example .env >nul
if not exist config.json copy config.example.json config.json >nul
echo.
echo できました。次に .env（IDとパスワード）と config.json（保存先フォルダ）をメモ帳で開いて書き換えてください。
echo そのあと「今すぐ取る.bat」で1回試し、うまくいったら「毎週の自動取得を登録.bat」を動かします。
start notepad .env
start notepad config.json
pause
