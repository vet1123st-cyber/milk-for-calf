# 毎週の自動取得を Windows の「タスク スケジューラ」に登録する（「毎週の自動取得を登録.bat」から呼ばれる）。
# 曜日や時刻を変えたいときは、下の2行を書き換えて、もう一度「毎週の自動取得を登録.bat」を動かす。
$Day  = 'Sunday'   # Monday Tuesday Wednesday Thursday Friday Saturday Sunday
$Time = '07:00'

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat  = Join-Path $here '今すぐ取る.bat'
$name = 'TAF牛一覧の取得'
$jp = @{ Monday='月曜'; Tuesday='火曜'; Wednesday='水曜'; Thursday='木曜'; Friday='金曜'; Saturday='土曜'; Sunday='日曜' }

try {
  $action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $bat + '" auto') -WorkingDirectory $here
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time
  # その時刻にPCが切れていたら、次に起動してサインインしたときに取りに行く（StartWhenAvailable）
  # スリープ中なら起こして取りに行く（WakeToRun）。ノートPCで電池のときも止めない
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  # 前に登録した分（月曜7時など）は、同じ名前なので上書きされる
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
} catch {
  Write-Host ''
  Write-Host ('登録できませんでした: ' + $_.Exception.Message)
  exit 1
}

# デスクトップに「牛検索」を置く。みんなで見る牛検索（いつも同じ名前で上書きされるもの）を開く
try {
  $cfg  = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'config.json') | ConvertFrom-Json
  $save = $cfg.'保存先フォルダ'
  $dest = $cfg.'共有先フォルダ'
  if (-not $dest) { $dest = Split-Path -Parent $save }
  $file = $cfg.'共有ファイル名'
  if (-not $file) { $file = '牛検索.html' }
  $target = Join-Path $dest $file
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\牛検索.lnk')
  $lnk.TargetPath = $target
  $lnk.Save()
  Write-Host ('デスクトップの「牛検索」: ' + $target)
} catch {
  Write-Host ('デスクトップの「牛検索」は作れませんでした（取得の登録はできています）: ' + $_.Exception.Message)
}

Write-Host ''
Write-Host ('登録しました。毎週 ' + $jp[$Day] + ' ' + $Time + ' に TAF から取りに行きます。')
Write-Host 'その時刻にPCが切れていたときは、次にPCを起動して Windows にサインインしたときに取りに行きます。'
