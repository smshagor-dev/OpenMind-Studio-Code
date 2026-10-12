<#
.SYNOPSIS
    Collects the evidence of one OpenMind Studio pilot computer into a ZIP (docs/pilot/multi-pc-pilot.md).

.DESCRIPTION
    Run it on each pilot computer, as the Windows user who ran OpenMind Studio, after each test case (or at the end).
    Needs no administrator rights and changes nothing: it only reads.

    Collected: this computer's name and Windows version, the shared installation's install.json and runtime folders
    (names only), this user's local OpenMind folder for that installation (file names, sizes and dates — never the
    database contents), install-state.json, the last lines of the OpenMind logs, running OpenMind processes, and
    whether the share answers. Not collected: the database itself, settings values, API keys or passwords, project
    files.

.PARAMETER SharedExe
    The UNC path of the shared OpenMindStudio.exe, e.g. "\\fs01\apps\OpenMind Studio\OpenMindStudio.exe".

.PARAMETER CaseId
    The test case being recorded (e.g. "05-python-detected"), used in the file name.

.PARAMETER OutDir
    Where to write the ZIP (default: the current folder).

.EXAMPLE
    .\Collect-PilotEvidence.ps1 -SharedExe "\\fs01\apps\OpenMind Studio\OpenMindStudio.exe" -CaseId 05-python
#>
param(
    [Parameter(Mandatory = $true)] [string] $SharedExe,
    [string] $CaseId = "all",
    [string] $OutDir = (Get-Location).Path
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Continue"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$work = Join-Path $env:TEMP "openmind-pilot-$stamp"
New-Item -ItemType Directory -Force $work | Out-Null
$report = New-Object System.Collections.Generic.List[string]
function Add([string] $line) { $report.Add($line) }

$shareDir = Split-Path -Parent $SharedExe
Add "case: $CaseId"
Add "time: $(Get-Date -Format o)"
Add "computer: $env:COMPUTERNAME  user: $env:USERNAME"
Add "windows: $([Environment]::OSVersion.VersionString)  64-bit: $([Environment]::Is64BitOperatingSystem)"
Add "admin: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
Add "share reachable: $(Test-Path -LiteralPath $SharedExe)"
if (Test-Path -LiteralPath $SharedExe) {
    $item = Get-Item -LiteralPath $SharedExe
    Add "program: $($item.VersionInfo.ProductVersion)  size $($item.Length)  modified $($item.LastWriteTimeUtc.ToString('o'))"
    $sig = Get-AuthenticodeSignature -LiteralPath $SharedExe
    Add "signature: $($sig.Status) $($sig.SignerCertificate.Subject)"
}

$installJson = Join-Path $shareDir "install.json"
if (Test-Path -LiteralPath $installJson) { Copy-Item -LiteralPath $installJson (Join-Path $work "install.json") }
Add "install.json present: $(Test-Path -LiteralPath $installJson)"

# The shared runtimes: names only.
$runtimes = Join-Path $shareDir "runtimes"
if (Test-Path -LiteralPath $runtimes) {
    Get-ChildItem -LiteralPath $runtimes -Directory | ForEach-Object {
        $versions = Get-ChildItem -LiteralPath (Join-Path $_.FullName "versions") -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Name }
        Add "runtime $($_.Name): $($versions -join ', ')"
    }
}

# This user's local folder(s) for OpenMind installations: names, sizes and dates only.
$installations = Join-Path $env:LOCALAPPDATA "OpenMind\Studio\Installations"
if (Test-Path -LiteralPath $installations) {
    Get-ChildItem -LiteralPath $installations -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\state\\webview\\' } |
        Select-Object FullName, Length, LastWriteTimeUtc |
        Export-Csv (Join-Path $work "local-files.csv") -NoTypeInformation -Encoding UTF8
    Get-ChildItem -LiteralPath $installations -Recurse -Filter "install-state.json" -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName (Join-Path $work ("install-state-" + $_.Directory.Name + ".json")) }
    Get-ChildItem -LiteralPath $installations -Recurse -Filter "openmind-studio.log" -ErrorAction SilentlyContinue |
        ForEach-Object {
            Get-Content -LiteralPath $_.FullName -Tail 400 |
                Set-Content (Join-Path $work ("openmind-studio-" + $_.Directory.Parent.Name + ".log")) -Encoding UTF8
        }
    Add "local databases: $((Get-ChildItem -LiteralPath $installations -Recurse -Filter 'openmind-studio.db' -ErrorAction SilentlyContinue | ForEach-Object FullName) -join '; ')"
} else {
    Add "no local OpenMind folder for this user yet"
}

Get-CimInstance Win32_Process -Filter "Name='OpenMindStudio.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { Add "running: pid $($_.ProcessId) $($_.ExecutablePath)" }

$report | Set-Content (Join-Path $work "summary.txt") -Encoding UTF8
$zip = Join-Path $OutDir ("openmind-pilot-{0}-{1}-{2}.zip" -f $env:COMPUTERNAME, $CaseId, $stamp)
Compress-Archive -Path (Join-Path $work "*") -DestinationPath $zip -Force
Remove-Item -LiteralPath $work -Recurse -Force
Write-Host "Evidence: $zip"
