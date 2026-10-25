@echo off
chcp 65001 >nul
rem 毎週の自動取得を登録する（中身は register-weekly.ps1）。曜日や時刻はそのファイルの上の2行で変えられる。
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-weekly.ps1"
echo.
pause
