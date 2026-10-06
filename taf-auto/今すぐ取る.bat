@echo off
chcp 65001 >nul
rem 手で今すぐ取りたいとき、または毎週の自動取得から呼ばれる。
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js が入っていません。https://nodejs.org/ja から LTS 版を入れてください。& pause & exit /b 1)

rem 部品が入っていなければ、先に入れる（「はじめに一度だけ.bat」を飛ばしても動くように）
if not exist node_modules\playwright (
  echo 必要な部品を入れています。初回だけ1〜2分かかります...
  call npm install --no-audit --no-fund
  if errorlevel 1 (echo 部品を入れられませんでした。インターネットにつながっているか確かめてください。& pause & exit /b 1)
)

rem ID・パスワードと保存先がまだなら、書いてもらう
if not exist .env (
  copy .env.example .env >nul
  echo .env に TAF の ID とパスワードを書いて保存してから、もう一度このファイルを動かしてください。
  start notepad .env
  if not exist config.json (copy config.example.json config.json >nul & start notepad config.json)
  pause & exit /b 1
)
if not exist config.json (
  copy config.example.json config.json >nul
  echo config.json の「保存先フォルダ」を書いて保存してから、もう一度このファイルを動かしてください。
  start notepad config.json
  pause & exit /b 1
)

node taf-download.mjs
if errorlevel 1 (
  echo.
  echo 取れなかったものがあります。logs フォルダの記録と写真を見てください。
  if "%1"=="" pause
  exit /b 1
)
echo.
echo 終わりました。保存先フォルダの 牛検索.html を開いてください。
if "%1"=="" pause
