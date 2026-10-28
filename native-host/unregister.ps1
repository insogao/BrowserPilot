# Unregister / roll back the BrowserPilot native messaging host (HKCU only).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File native-host/unregister.ps1
#   powershell ... -File native-host/unregister.ps1 -IncludeEdge
#   powershell ... -File native-host/unregister.ps1 -BackupFile native-host\backup\<stamp>.json
#
# Rules:
#   - Only touches the host name com.browserpilot.browseragent. Other hosts such as
#     com.egolite.browseragent are never read, written or deleted.
#   - With a backup: restore each target's previous default value verbatim; keys recorded as
#     "did not exist" are removed.
#   - Without a backup: delete this host's key (Chrome; Edge too when -IncludeEdge is given).
#   - Only HKCU:\ is accepted, and every registryPath read from a backup must end with this
#     host name, so a tampered backup file cannot point the script at an unrelated key.
param(
    [switch]$IncludeEdge,
    [string]$RegistryRoot = "HKCU:\Software",
    [string]$BackupDir = "",
    [string]$BackupFile = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$HostName = "com.browserpilot.browseragent"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$Message) { throw $Message }

function Assert-HkcuOnly([string]$Root) {
    if ($Root -notmatch '^(?i)HKCU:\\') {
        Fail "Refusing non-HKCU registry root: $Root (this script never writes HKLM)"
    }
    if ($Root -match '(?i)HKLM') {
        Fail "Registry root contains HKLM; refusing: $Root"
    }
}

function Assert-OwnKeyPath([string]$KeyPath) {
    if ($KeyPath -notmatch '^(?i)HKCU:\\') {
        Fail "Backup registryPath is not under HKCU; refusing: $KeyPath"
    }
    if ($KeyPath -notmatch ('(?i)\\NativeMessagingHosts\\' + [regex]::Escape($HostName) + '$')) {
        Fail "Backup registryPath is not a NativeMessagingHosts key for $HostName; refusing: $KeyPath"
    }
}

function Get-HkcuSubPath([string]$KeyPath) {
    if ($KeyPath -notmatch '^(?i)HKCU:\\(.+)$') {
        Fail "Registry path is not under HKCU: $KeyPath"
    }
    return $Matches[1]
}

function Remove-RegistryKey([string]$KeyPath) {
    if ($DryRun) {
        if (Test-Path -LiteralPath $KeyPath) { return "would-remove-key" }
        return "absent"
    }
    if (Test-Path -LiteralPath $KeyPath) {
        $subPath = Get-HkcuSubPath $KeyPath
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($subPath, $false)
        return "removed-key"
    }
    return "absent"
}

function Remove-RegistryDefault([string]$KeyPath) {
    if (-not (Test-Path -LiteralPath $KeyPath)) { return "absent" }
    if ($DryRun) { return "would-remove-default" }
    $subPath = Get-HkcuSubPath $KeyPath
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subPath, $true)
    if (-not $key) { return "absent" }
    try {
        if (@($key.GetValueNames()) -contains "") {
            $key.DeleteValue("", $false)
            return "removed-default"
        }
        return "no-default"
    } finally {
        $key.Close()
    }
}

function Set-RegistryDefault([string]$KeyPath, [string]$Value) {
    if ($DryRun) { return "would-restore-default" }
    $subPath = Get-HkcuSubPath $KeyPath
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subPath)
    if (-not $key) { Fail "Failed to create/open registry key: $KeyPath" }
    try {
        $key.SetValue("", [string]$Value, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $key.Close()
    }
    return "restored-default"
}

try {
    Assert-HkcuOnly $RegistryRoot

    if (-not $BackupDir) { $BackupDir = Join-Path $scriptDir "backup" }
    if (-not [System.IO.Path]::IsPathRooted($BackupDir)) { $BackupDir = Join-Path $scriptDir $BackupDir }

    $backup = $null
    $resolvedBackupFile = $null
    if ($BackupFile) {
        if (-not [System.IO.Path]::IsPathRooted($BackupFile)) { $BackupFile = Join-Path $scriptDir $BackupFile }
        if (-not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
            Fail "Backup file not found: $BackupFile"
        }
        $resolvedBackupFile = (Resolve-Path -LiteralPath $BackupFile).Path
        $backup = Get-Content -Raw -LiteralPath $resolvedBackupFile | ConvertFrom-Json
        if ($backup.hostName -ne $HostName) {
            Fail "Backup belongs to another host ($($backup.hostName)); refusing: $resolvedBackupFile"
        }
    } elseif (Test-Path -LiteralPath $BackupDir) {
        $candidates = @(Get-ChildItem -LiteralPath $BackupDir -Filter "*.json" -File -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending)
        foreach ($candidate in $candidates) {
            try {
                $parsed = Get-Content -Raw -LiteralPath $candidate.FullName | ConvertFrom-Json
                if ($parsed.hostName -eq $HostName -and $parsed.targets) {
                    $backup = $parsed
                    $resolvedBackupFile = $candidate.FullName
                    break
                }
            } catch {
                # Skip damaged/unrelated backup files and keep looking for this host's newest.
            }
        }
    }

    $chromeKey = $RegistryRoot.TrimEnd('\') + '\Google\Chrome\NativeMessagingHosts\' + $HostName
    $edgeKey = $RegistryRoot.TrimEnd('\') + '\Microsoft\Edge\NativeMessagingHosts\' + $HostName

    $actions = New-Object System.Collections.ArrayList
    if ($backup) {
        if (-not $backup.targets -or @($backup.targets).Count -eq 0) {
            Fail "Backup contains no restore targets; refusing to report success: $resolvedBackupFile"
        }
        $seen = @{}
        foreach ($target in @($backup.targets)) {
            $keyPath = [string]$target.registryPath
            Assert-OwnKeyPath $keyPath
            $seen[[string]$target.browser] = $true
            $action = "skipped"
            if ([bool]$target.keyExisted) {
                if ([bool]$target.hasDefault) {
                    $action = Set-RegistryDefault $keyPath ([string]$target.previousDefault)
                } else {
                    $action = Remove-RegistryDefault $keyPath
                }
            } else {
                $action = Remove-RegistryKey $keyPath
            }
            [void]$actions.Add([ordered]@{ browser = [string]$target.browser; registryPath = $keyPath; action = $action })
        }
        # Edge explicitly requested but not covered by the backup: this is the
        # "no backup for that target -> remove our host key" branch.
        if ($IncludeEdge -and -not $seen.ContainsKey("edge")) {
            Assert-OwnKeyPath $edgeKey
            [void]$actions.Add([ordered]@{ browser = "edge"; registryPath = $edgeKey; action = (Remove-RegistryKey $edgeKey) })
        }
    } else {
        Assert-OwnKeyPath $chromeKey
        [void]$actions.Add([ordered]@{ browser = "chrome"; registryPath = $chromeKey; action = (Remove-RegistryKey $chromeKey) })
        if ($IncludeEdge) {
            Assert-OwnKeyPath $edgeKey
            [void]$actions.Add([ordered]@{ browser = "edge"; registryPath = $edgeKey; action = (Remove-RegistryKey $edgeKey) })
        }
    }

    $result = [ordered]@{
        ok         = $true
        dryRun     = [bool]$DryRun
        hostName   = $HostName
        mode       = if ($backup) { "restored-from-backup" } else { "removed" }
        backupFile = $resolvedBackupFile
        actions    = @($actions)
    }
    Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
    exit 0
} catch {
    [Console]::Error.WriteLine("[unregister] ERROR: " + $_.Exception.Message)
    exit 1
}
