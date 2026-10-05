@echo off
chcp 65001 >nul
rem 手で今すぐ取りたいとき、または毎週の自動取得から呼ばれる。
cd /d "%~dp0"
node taf-download.mjs
if errorlevel 1 (
  echo.
  echo 取れなかったものがあります。logs フォルダの記録と写真を見てください。
  if "%1"=="" pause
)
