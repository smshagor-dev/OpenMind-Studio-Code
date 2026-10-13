# Runs INSIDE Windows Sandbox (started by New-UpgradeTestSandbox.ps1): installs the previous release, uses it once,
# upgrades it with the new release, and records what changed. Never run it on a real computer: it installs and starts
# OpenMind Studio for the sandbox's user. Results: C:\results\upgrade-test.json (+ copies of each database) — the host
# folder release\v<version>\upgrade-test\results.
param(
  [string]$Old = "C:\old",          # release\<previous version> (read-only)
  [string]$New = "C:\new",          # release\v<version> (read-only)
  [string]$Out = "C:\results"
)
$ErrorActionPreference = "Stop"
$results = [ordered]@{ started = (Get-Date).ToString("o"); cases = @() }
function Save { $results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Out "upgrade-test.json") -Encoding utf8 }
function Case($name, [scriptblock]$body) {
  $case = [ordered]@{ name = $name; ok = $false; checks = [ordered]@{}; error = $null }
  try { & $body $case; $case.ok = -not ($case.checks.Values -contains $false) } catch { $case.error = "$_" }
  $results.cases += $case; Save
}
function Setup($dir, $pattern) { Get-ChildItem $dir -Recurse -File | Where-Object Name -match $pattern | Select-Object -First 1 -ExpandProperty FullName }
function RunSetup($exe, [string[]]$arguments) { (Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru).ExitCode }
function Launch($exe, $seconds = 25) {
  $p = Start-Process -FilePath $exe -PassThru; Start-Sleep $seconds
  if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null; if (-not $p.WaitForExit(15000)) { Stop-Process -Id $p.Id -Force } }
}
function Uninstall($name) {
  Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object DisplayName -eq $name
}
function Snapshot($label) {
  reg export "HKCU\Software" (Join-Path $Out "hkcu-software-$label.reg") /y | Out-Null
  reg export "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall" (Join-Path $Out "hklm-uninstall-$label.reg") /y | Out-Null
}

foreach ($arch in "x64", "x86") {
  Case "nsis-${arch}: 1.0.2 -> 1.0.3 in place, data kept" {
    param($c)
    $old = Setup $Old "Setup-1\.0\.2-$arch\.exe$"; $new = Setup $New "_windows_$($arch)_setup\.exe$"
    $c.checks.oldSetupFound = [bool]$old; $c.checks.newSetupFound = [bool]$new
    Snapshot "$arch-before"
    $c.checks.oldInstalled = (RunSetup $old @("/S")) -eq 0
    $dir = Join-Path $env:LOCALAPPDATA "Programs\OpenMind Studio"
    $exe = Join-Path $dir "OpenMindStudio.exe"
    Launch $exe
    $db = Get-ChildItem $dir -Recurse -Filter "openmind-studio.db" -ErrorAction SilentlyContinue | Select-Object -First 1
    $c.checks.oldCreatedDatabase = [bool]$db
    if ($db) { Copy-Item $db.FullName (Join-Path $Out "db-$arch-1.0.2.db") }
    New-Item -ItemType Directory -Force (Join-Path $dir "runtimes\marker") | Out-Null
    Set-Content (Join-Path $dir "runtimes\marker\kept.txt") "runtime marker"
    Set-Content (Join-Path $dir "settings\marker.json") '{"kept": true}'
    $code = RunSetup $new @("/S")
    $c.newSetupExitCode = $code
    $c.checks.newSetupSucceeded = $code -eq 0
    $c.checks.sameFolder = (Test-Path $exe) -and ((Get-Item $exe).VersionInfo.ProductVersion -eq "1.0.3")
    $c.checks.noSecondInstall = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs") -Directory | Where-Object Name -like "OpenMind*").Count -eq 1
    $c.checks.runtimeKept = (Get-Content (Join-Path $dir "runtimes\marker\kept.txt") -ErrorAction SilentlyContinue) -eq "runtime marker"
    $c.checks.settingsKept = Test-Path (Join-Path $dir "settings\marker.json")
    $c.checks.databaseKept = $db -and (Test-Path $db.FullName)
    $entry = Uninstall "OpenMind Studio"
    $c.uninstallVersions = @($entry.DisplayVersion)
    $c.checks.oneUninstallEntry = @($entry).Count -eq 1 -and $entry.DisplayVersion -eq "1.0.3"
    Launch $exe
    if ($db) { Copy-Item $db.FullName (Join-Path $Out "db-$arch-1.0.3.db") }
    $c.checks.repairSucceeds = (RunSetup $new @("/S")) -eq 0
    $c.checks.stillOneInstall = @(Uninstall "OpenMind Studio").Count -eq 1
    Snapshot "$arch-after"
    # Leave the sandbox clean for the next architecture.
    $c.uninstalledForNextCase = (RunSetup (Join-Path $dir "uninstall.exe") @("/S")) -eq 0
    Start-Sleep 5
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Case "nsis-x64: network installation keeps its layout on update" {
  param($c)
  $new = Setup $New "_windows_x64_setup\.exe$"
  $share = "C:\share\OpenMind Studio"
  $c.checks.installed = (RunSetup $new @("/S", "/NETWORK", "/D=$share")) -eq 0
  $layout = { (Get-Content (Join-Path $share "install.json") -Raw | ConvertFrom-Json).layout }
  $c.checks.networkLayout = (& $layout) -eq "network"
  $c.checks.repairSucceeds = (RunSetup $new @("/S")) -eq 0
  $c.checks.stillNetwork = (& $layout) -eq "network"
  $c.checks.noDataInShare = -not (Test-Path (Join-Path $share "data\openmind-studio.db"))
  RunSetup (Join-Path $share "uninstall.exe") @("/S") | Out-Null
}

Case "msi-x64: 1.0.2 -> 1.0.3 (per machine)" {
  param($c)
  $old = Setup $Old "1\.0\.2-x64\.msi$"; $new = Setup $New "_windows_x64\.msi$"
  $c.checks.oldInstalled = (Start-Process msiexec -ArgumentList "/i `"$old`" /qn /l*v `"$Out\msi-old.log`"" -Wait -PassThru).ExitCode -eq 0
  $code = (Start-Process msiexec -ArgumentList "/i `"$new`" /qn /l*v `"$Out\msi-new.log`"" -Wait -PassThru).ExitCode
  $c.newMsiExitCode = $code
  $c.checks.newInstalled = $code -eq 0
  $exe = Join-Path $env:ProgramFiles "OpenMind Studio\OpenMindStudio.exe"
  $c.checks.version = (Test-Path $exe) -and ((Get-Item $exe).VersionInfo.ProductVersion -eq "1.0.3")
  $c.checks.oneEntry = @(Uninstall "OpenMind Studio").Count -eq 1
  $c.checks.perMachineLayout = ((Get-Content (Join-Path (Split-Path $exe) "install.json") -Raw | ConvertFrom-Json).layout) -eq "perMachine"
}

$results.finished = (Get-Date).ToString("o")
Save
"done" | Set-Content (Join-Path $Out "DONE")
