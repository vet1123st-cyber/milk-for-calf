@echo off
chcp 65001 >nul
rem TAF には行かず、もう取ってあるCSVから牛検索を作り直して、取得日つきで共有の場所に置く。
cd /d "%~dp0"
node taf-download.mjs --viewer-only
echo.
pause
