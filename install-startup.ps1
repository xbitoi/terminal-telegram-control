# install-startup.ps1
# يسجل هذا السكريبت تطبيق Terminal Runner ليشتغل تلقائياً عند بداية ويندوز
# Run this as normal user (no admin needed)

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $scriptPath "server.js"
$nodeExe = (Get-Command node).Source

if (-not $nodeExe) {
    Write-Host "❌ Node.js غير مثبت. الرجاء تثبيت Node.js أولاً." -ForegroundColor Red
    exit 1
}

# Create shortcut in Windows Startup folder
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "TerminalRunner.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-WindowStyle Hidden -NoLogo -NoProfile -Command `"node '$serverPath'`""
$shortcut.WorkingDirectory = $scriptPath
$shortcut.Description = "Terminal Runner - Telegram + Web terminal launcher"
$shortcut.Save()

Write-Host "✅ تم إنشاء اختصار التشغيل التلقائي:" -ForegroundColor Green
Write-Host "   $shortcutPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "سيشتغل Terminal Runner تلقائياً عند إقلاع ويندوز." -ForegroundColor Yellow
Write-Host "لتشغيله الآن يدوياً:" -ForegroundColor White
Write-Host "   cd `"$scriptPath`"" -ForegroundColor Gray
Write-Host "   node server.js" -ForegroundColor Gray
