$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7' }
$taskWorkspace = Split-Path -Parent $PSScriptRoot
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskWorkspace 'package.json') -Raw | ConvertFrom-Json).version
$taskExecutable = Join-Path $taskWorkspace "release\$taskVersion\win-unpacked\Friend 桌宠.exe"
if (-not (Test-Path -LiteralPath $taskExecutable)) { throw '请先运行 npm run package' }
Start-Process -FilePath $taskExecutable -WorkingDirectory (Split-Path -Parent $taskExecutable) -WindowStyle Hidden
