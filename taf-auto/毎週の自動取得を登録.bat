@echo off
chcp 65001 >nul
rem Windows の「タスク スケジューラ」に、毎週月曜の朝7時に取りに行く仕事を登録する。
rem 曜日や時刻を変えたいときは、下の /d MON と /st 07:00 を書き換えてもう一度動かす。
cd /d "%~dp0"
schtasks /create /tn "TAF牛一覧の取得" /tr "\"%~dp0今すぐ取る.bat\" auto" /sc weekly /d MON /st 07:00 /f
if errorlevel 1 (echo 登録できませんでした。& pause & exit /b 1)

rem デスクトップに「牛検索」のショートカットを置く
for /f "usebackq delims=" %%p in (`node -e "console.log(require('./config.json')['保存先フォルダ'])"`) do set SAVEDIR=%%p
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\牛検索.lnk'); $s.TargetPath='%SAVEDIR%\牛検索.html'; $s.Save()"
echo.
echo 登録しました。毎週月曜 7:00 に取りに行きます（そのときPCが起動していてサインインしている必要があります）。
echo デスクトップに「牛検索」を置きました。
pause
