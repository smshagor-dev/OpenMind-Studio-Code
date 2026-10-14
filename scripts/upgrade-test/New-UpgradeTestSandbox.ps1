# usage: powershell -File scripts\upgrade-test\New-UpgradeTestSandbox.ps1 [-Version 1.0.4] [-Previous 1.0.3] [-Start]
# (defaults: -Version = this checkout's version, -Previous = the newest older release folder)
# Writes release\v<version>\validation\upgrade-test\upgrade-test.wsb: a Windows Sandbox (disposable; nothing reaches this computer)
# with the previous and the new release folders mapped READ-ONLY, a results folder mapped writable, and
# Invoke-UpgradeTest.ps1 run at logon. -Start opens it. Windows Sandbox must be enabled once (administrator, then restart):
#   Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
# After the run: release\v<version>\validation\upgrade-test\results\upgrade-test.json (and the databases before/after the update).
param([string]$Version = "", [string]$Previous = "", [switch]$Start)
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not $Version) { $Version = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version }
$new = Join-Path $root "release\v$Version"
if (-not $Previous) {
  # The newest other release folder below this version (release\v1.0.3, or release\1.0.2 for the old layout).
  $Previous = Get-ChildItem (Join-Path $root "release") -Directory | ForEach-Object { $_.Name -replace '^v', '' } |
    Where-Object { $_ -match '^\d+\.\d+\.\d+$' -and [version]$_ -lt [version]$Version } |
    Sort-Object { [version]$_ } | Select-Object -Last 1
  if (-not $Previous) { throw "No release folder older than $Version in $(Join-Path $root 'release'); pass -Previous." }
}
$old = @((Join-Path $root "release\v$Previous"), (Join-Path $root "release\$Previous")) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not (Test-Path $new)) { throw "$new does not exist." }
if (-not $old) { throw "No release folder for $Previous in $(Join-Path $root 'release')." }
$work = Join-Path $new "validation\upgrade-test"
$results = Join-Path $work "results"
New-Item -ItemType Directory -Force $results | Out-Null
Copy-Item (Join-Path $PSScriptRoot "Invoke-UpgradeTest.ps1") $work -Force
$esc = { param($s) [Security.SecurityElement]::Escape([string]$s) }
$wsb = @"
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder><HostFolder>$(& $esc $old)</HostFolder><SandboxFolder>C:\old</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(& $esc $new)</HostFolder><SandboxFolder>C:\new</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(& $esc $results)</HostFolder><SandboxFolder>C:\results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\new\validation\upgrade-test\Invoke-UpgradeTest.ps1 -OldVersion $(& $esc $Previous) -NewVersion $(& $esc $Version)</Command>
  </LogonCommand>
</Configuration>
"@
$file = Join-Path $work "upgrade-test.wsb"
Set-Content -LiteralPath $file -Value $wsb -Encoding utf8
"Wrote $file (previous: $old, new: $new, results: $results)."
if ($Start) { Start-Process $file }
