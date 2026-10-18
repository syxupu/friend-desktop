$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7' }
$taskWorkspace = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskWorkspace 'package.json') -Raw | ConvertFrom-Json).version
$taskDestination = Join-Path $taskWorkspace "release\Friend-$taskVersion-source.zip"
New-Item -ItemType Directory -Path (Split-Path -Parent $taskDestination) -Force | Out-Null
# Export only the reviewed commit. Local cards, credentials and test data must
# never enter a source archive merely because they exist in the workspace.
$taskGitArgs = @('-C', $taskWorkspace, 'archive', '--format=zip', '--output', $taskDestination, 'HEAD')
& git @taskGitArgs
if ($LASTEXITCODE -ne 0) { throw '源码导出失败；请先提交需要发布的源码' }
Write-Output $taskDestination
