<#
.SYNOPSIS
    Puts (or repairs, or removes) the "OpenMind Studio" shortcut on the Public Desktop of many computers, pointing at a
    shared network installation, and reports what happened on each one.

.DESCRIPTION
    For a network installation of OpenMind Studio (the setup's "Recommended for All Users" choice, installed into a shared
    folder such as \\server\apps\OpenMind Studio). Run it as an administrator of the target computers, from a computer
    that can reach them over PowerShell remoting (WinRM). It uses only your own rights: it never bypasses Active
    Directory permissions, remote-access settings or Group Policy, and a computer you may not manage is reported as
    such, not worked around.

    On each computer it writes C:\Users\Public\Desktop\OpenMind Studio.lnk (seen by every user of that computer),
    pointing at the shared program by its UNC path - never a drive letter, which may differ between computers. A
    shortcut that already points there is left alone; one that points elsewhere (an older location) is repaired; the
    result is read back and verified. With -Remove, only a shortcut that points at this installation is removed.

    No software is installed on the computers and nothing is copied to them: the shortcut runs the program from the
    share, where every computer keeps its own data on its own disk.

    Alternatives that need no remoting at all (see docs/deployment.md):
      - Group Policy Preferences > Windows Settings > Shortcuts (recommended in a domain), or
      - a user logon script: "\\server\apps\OpenMind Studio\OpenMindStudio.exe" --integration desktop-shortcut

.PARAMETER SharedExe
    The UNC path of OpenMindStudio.exe in the shared installation, e.g. "\\server\apps\OpenMind Studio\OpenMindStudio.exe".

.PARAMETER ComputerName
    The computers to deploy to.

.PARAMETER ComputerListPath
    A text file with one computer name per line (lines starting with # are ignored).

.PARAMETER FromActiveDirectory
    Take the computers from Active Directory (needs the ActiveDirectory module, RSAT). Combine with -SearchBase and
    -LdapFilter to limit them, for example to one lab's OU.

.PARAMETER Remove
    Remove the shortcut instead (only one that points at -SharedExe).

.PARAMETER ReportPath
    Where to write the CSV report (default: OpenMind-shortcuts-<date>.csv in the current folder).

.EXAMPLE
    .\Deploy-OpenMindShortcuts.ps1 -SharedExe "\\fs01\apps\OpenMind Studio\OpenMindStudio.exe" -ComputerName LAB1-PC01,LAB1-PC02

.EXAMPLE
    .\Deploy-OpenMindShortcuts.ps1 -SharedExe "\\fs01\apps\OpenMind Studio\OpenMindStudio.exe" -FromActiveDirectory -SearchBase "OU=Lab1,OU=Computers,DC=uni,DC=local" -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = "Names")]
param(
    [Parameter(Mandatory = $true)]
    [string] $SharedExe,

    [Parameter(Mandatory = $true, ParameterSetName = "Names")]
    [string[]] $ComputerName,

    [Parameter(Mandatory = $true, ParameterSetName = "File")]
    [string] $ComputerListPath,

    [Parameter(Mandatory = $true, ParameterSetName = "AD")]
    [switch] $FromActiveDirectory,

    [Parameter(ParameterSetName = "AD")]
    [string] $SearchBase,

    [Parameter(ParameterSetName = "AD")]
    [string] $LdapFilter = "(&(objectCategory=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))",

    [switch] $Remove,

    [System.Management.Automation.PSCredential] $Credential,

    [ValidateRange(1, 256)]
    [int] $ThrottleLimit = 32,

    [string] $ReportPath = (Join-Path (Get-Location) ("OpenMind-shortcuts-{0:yyyyMMdd-HHmmss}.csv" -f (Get-Date)))
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

# --- What is deployed -------------------------------------------------------------------------------------------------
if ($SharedExe -notmatch '^\\\\[^\\]+\\[^\\]+\\') {
    throw "SharedExe must be a UNC path (\\server\share\...), not a drive letter: other computers may map the share to another letter or not at all."
}
if ([System.IO.Path]::GetFileName($SharedExe) -ne "OpenMindStudio.exe") {
    throw "SharedExe must name OpenMindStudio.exe."
}
if (-not $Remove -and -not (Test-Path -LiteralPath $SharedExe -PathType Leaf)) {
    throw "$SharedExe can't be reached from this computer. Check the path and that the share is readable."
}

# --- Which computers --------------------------------------------------------------------------------------------------
switch ($PSCmdlet.ParameterSetName) {
    "File" {
        $targets = Get-Content -LiteralPath $ComputerListPath |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -ne "" -and -not $_.StartsWith("#") }
    }
    "AD" {
        if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
            throw "The ActiveDirectory module (RSAT) is not installed here. Install RSAT, or pass -ComputerName / -ComputerListPath."
        }
        Import-Module ActiveDirectory
        $query = @{ LDAPFilter = $LdapFilter }
        if ($SearchBase) { $query.SearchBase = $SearchBase }
        $targets = Get-ADComputer @query | ForEach-Object { if ($_.DNSHostName) { $_.DNSHostName } else { $_.Name } }
    }
    default { $targets = $ComputerName }
}
$targets = @($targets | Sort-Object -Unique)
if ($targets.Count -eq 0) {
    throw "No computers to deploy to."
}
$action = if ($Remove) { "Remove the OpenMind Studio shortcut" } else { "Create or repair the OpenMind Studio shortcut" }
$approved = @($targets | Where-Object { $PSCmdlet.ShouldProcess($_, $action) })
if ($approved.Count -eq 0) {
    Write-Host "Nothing to do (WhatIf, or nothing confirmed)."
    return
}

# --- On each computer ---------------------------------------------------------------------------------------------------
$work = {
    param([string] $Target, [bool] $RemoveIt)
    $ErrorActionPreference = "Stop"
    $result = [ordered]@{ Computer = $env:COMPUTERNAME; Outcome = ""; Verified = $false; Shortcut = ""; Detail = "" }
    try {
        $desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
        $lnk = Join-Path $desktop "OpenMind Studio.lnk"
        $result.Shortcut = $lnk
        $shell = New-Object -ComObject WScript.Shell
        $same = { param($a, $b) $a.TrimEnd('\').ToLowerInvariant() -eq $b.TrimEnd('\').ToLowerInvariant() }
        $current = $null
        if (Test-Path -LiteralPath $lnk -PathType Leaf) {
            $current = $shell.CreateShortcut($lnk).TargetPath
        }
        if ($RemoveIt) {
            if ($null -eq $current) {
                $result.Outcome = "NotPresent"; $result.Verified = $true
            } elseif (& $same $current $Target) {
                Remove-Item -LiteralPath $lnk -Force
                $result.Outcome = "Removed"; $result.Verified = -not (Test-Path -LiteralPath $lnk)
            } else {
                $result.Outcome = "LeftAlone"; $result.Verified = $true
                $result.Detail = "points at $current, not this installation"
            }
            return [pscustomobject]$result
        }
        if ($null -ne $current -and (& $same $current $Target)) {
            $result.Outcome = "AlreadyCorrect"
        } else {
            $link = $shell.CreateShortcut($lnk)
            $link.TargetPath = $Target
            $link.WorkingDirectory = Split-Path -Parent $Target
            $link.IconLocation = "$Target,0"
            $link.Description = "OpenMind Studio"
            $link.Save()
            $result.Outcome = if ($null -eq $current) { "Created" } else { "Repaired" }
            if ($null -ne $current) { $result.Detail = "was $current" }
        }
        $written = $shell.CreateShortcut($lnk).TargetPath
        $result.Verified = (& $same $written $Target)
        if (-not $result.Verified) { $result.Detail = "read back $written" }
    } catch {
        $result.Outcome = "Failed"
        $result.Detail = $_.Exception.Message
    }
    [pscustomobject]$result
}

$remoting = @{
    ComputerName  = $approved
    ScriptBlock   = $work
    ArgumentList  = @($SharedExe, [bool]$Remove)
    ThrottleLimit = $ThrottleLimit
    ErrorAction   = "SilentlyContinue"
    ErrorVariable = "remoteErrors"
}
if ($Credential) { $remoting.Credential = $Credential }
$remoteErrors = @()
$answers = @(Invoke-Command @remoting)

# --- Report -------------------------------------------------------------------------------------------------------------
$rows = New-Object System.Collections.Generic.List[object]
foreach ($answer in $answers) {
    $rows.Add([pscustomobject]@{
        Computer = $answer.PSComputerName
        Outcome  = $answer.Outcome
        Verified = $answer.Verified
        Shortcut = $answer.Shortcut
        Detail   = $answer.Detail
    })
}
$answered = @($rows | ForEach-Object { $_.Computer.ToLowerInvariant() })
foreach ($err in $remoteErrors) {
    $name = $null
    if ($err.TargetObject) { $name = [string]$err.TargetObject }
    if (-not $name -and $err.OriginInfo) { $name = $err.OriginInfo.PSComputerName }
    if (-not $name) { continue }
    $reason = $err.Exception.Message
    $outcome = if ($reason -match "Access is denied|access denied") { "AccessDenied" } else { "Unreachable" }
    $rows.Add([pscustomobject]@{ Computer = $name; Outcome = $outcome; Verified = $false; Shortcut = ""; Detail = $reason.Trim() })
    $answered += $name.ToLowerInvariant()
}
foreach ($name in $approved) {
    if ($answered -notcontains $name.ToLowerInvariant()) {
        $rows.Add([pscustomobject]@{ Computer = $name; Outcome = "NoAnswer"; Verified = $false; Shortcut = ""; Detail = "no result came back" })
    }
}

$rows | Sort-Object Computer | Export-Csv -LiteralPath $ReportPath -NoTypeInformation -Encoding UTF8
$rows | Sort-Object Outcome, Computer | Format-Table -AutoSize Computer, Outcome, Verified, Detail
$ok = @($rows | Where-Object { $_.Verified }).Count
Write-Host ("{0} of {1} computers verified. Report: {2}" -f $ok, $approved.Count, $ReportPath)
if ($ok -lt $approved.Count) { exit 1 }
