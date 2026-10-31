# Register BrowserPilot native messaging host on Windows (HKCU only).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File native-host/register.ps1
#   powershell ... -File native-host/register.ps1 -IncludeEdge
#   powershell ... -File native-host/register.ps1 -HostPath <abs exe> -DryRun
#
# Fail-closed rules:
#   - Only writes HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserpilot.browseragent.
#     Edge is opt-in via -IncludeEdge. HKLM is never written (the registry root must start with HKCU:\).
#   - Before changing anything, backs up every target key's previous default value to
#     native-host/backup/<timestamp>.json. native-host/unregister.ps1 restores it.
#   - The manifest is regenerated on every run from host.manifest.template.json plus the
#     actual built exe path (UTF-8 without BOM); no machine-specific absolute path is tracked.
#   - Refuses to register when the exe is missing, the template is invalid, or allowed_origins
#     would not match the extension ID derived from manifest.json's key.
param(
    [string]$HostPath = "",
    [string]$ExtensionId = "",
    [string]$ManifestPath = "",
    [string]$TemplatePath = "",
    [switch]$IncludeEdge,
    [string]$RegistryRoot = "HKCU:\Software",
    [string]$BackupDir = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$HostName = "com.browserpilot.browseragent"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$Message) {
    throw $Message
}

function Assert-HkcuOnly([string]$Root) {
    # Hard gate: the registry root must be HKCU. This is what keeps the script from ever
    # writing HKLM, even if a caller passes a crafted -RegistryRoot.
    if ($Root -notmatch '^(?i)HKCU:\\') {
        Fail "Refusing non-HKCU registry root: $Root (this script never writes HKLM)"
    }
    if ($Root -match '(?i)HKLM') {
        Fail "Registry root contains HKLM; refusing: $Root"
    }
}

function Get-ExtensionIdFromRepoManifest([string]$ManifestFile) {
    if (-not (Test-Path -LiteralPath $ManifestFile -PathType Leaf)) {
        Fail "Extension manifest.json not found: $ManifestFile"
    }
    $manifest = Get-Content -Raw -LiteralPath $ManifestFile | ConvertFrom-Json
    if (-not $manifest.key) {
        Fail "manifest.json has no key; a stable extension ID cannot be derived: $ManifestFile"
    }
    $der = [Convert]::FromBase64String([string]$manifest.key)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($der)
    } finally {
        $sha.Dispose()
    }
    # sha256(DER SPKI) first 32 hex chars, each nibble 0-9a-f mapped to a-p.
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt 16; $i++) {
        $byte = [int]$hash[$i]
        foreach ($nibble in @([int][math]::Floor($byte / 16), [int]($byte % 16))) {
            $code = if ($nibble -lt 10) { 97 + $nibble } else { 107 + ($nibble - 10) }
            [void]$sb.Append([char]$code)
        }
    }
    return $sb.ToString()
}

function Read-RegistryDefault([string]$KeyPath) {
    $exists = Test-Path -LiteralPath $KeyPath
    if (-not $exists) {
        return [pscustomobject]@{ keyExisted = $false; hasDefault = $false; value = $null }
    }
    $item = Get-Item -LiteralPath $KeyPath
    $hasDefault = (@($item.GetValueNames()) -contains "")
    $value = $null
    if ($hasDefault) { $value = $item.GetValue("", $null) }
    return [pscustomobject]@{ keyExisted = $true; hasDefault = $hasDefault; value = $value }
}

function Get-HkcuSubPath([string]$KeyPath) {
    if ($KeyPath -notmatch '^(?i)HKCU:\\(.+)$') {
        Fail "Registry path is not under HKCU: $KeyPath"
    }
    return $Matches[1]
}

function Set-RegistryDefault([string]$KeyPath, [string]$Value) {
    # Use the Registry API directly: a RegistryKey obtained from Get-Item can be read-only,
    # which makes SetValue fail with "Cannot write to the registry key".
    $subPath = Get-HkcuSubPath $KeyPath
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subPath)
    if (-not $key) { Fail "Failed to create/open registry key: $KeyPath" }
    try {
        $key.SetValue("", [string]$Value, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $key.Close()
    }
}

function Get-ManifestSummary([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $parsed = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
        return [ordered]@{
            name            = $parsed.name
            path            = $parsed.path
            allowed_origins = @($parsed.allowed_origins)
        }
    } catch {
        return [ordered]@{ parseError = $_.Exception.Message }
    }
}

function Write-Utf8NoBom([string]$File, [string]$Text) {
    $parent = Split-Path -Parent $File
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $tmp = $File + ".tmp-" + [guid]::NewGuid().ToString("N")
    [System.IO.File]::WriteAllText($tmp, $Text, $utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $File -Force
    $bytes = [System.IO.File]::ReadAllBytes($File)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Fail "Manifest still contains a UTF-8 BOM after writing: $File"
    }
}

try {
    Assert-HkcuOnly $RegistryRoot

    $repoManifest = Join-Path $repoRoot "manifest.json"
    $derivedId = Get-ExtensionIdFromRepoManifest $repoManifest
    if ($ExtensionId -and $ExtensionId -ne $derivedId) {
        Fail "Explicit -ExtensionId=$ExtensionId does not match the ID derived from manifest.json key ($derivedId)"
    }
    $resolvedExtensionId = if ($ExtensionId) { $ExtensionId } else { $derivedId }

    if (-not $TemplatePath) { $TemplatePath = Join-Path $scriptDir "host.manifest.template.json" }
    if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
        Fail "Host manifest template not found: $TemplatePath"
    }
    $template = Get-Content -Raw -LiteralPath $TemplatePath | ConvertFrom-Json
    if ($template.name -ne $HostName) {
        Fail "Template name must be $HostName, got $($template.name)"
    }
    if ($template.type -ne "stdio") {
        Fail "Template type must be stdio, got $($template.type)"
    }
    $templateOrigins = @($template.allowed_origins)
    if ($templateOrigins.Count -ne 1 -or $templateOrigins[0] -ne "chrome-extension://__EXTENSION_ID__/") {
        Fail "Template allowed_origins must be a single chrome-extension://__EXTENSION_ID__/ entry, got: $($templateOrigins -join ', ')"
    }

    if (-not $ManifestPath) { $ManifestPath = Join-Path $scriptDir "host.manifest.json" }
    if (-not [System.IO.Path]::IsPathRooted($ManifestPath)) { $ManifestPath = Join-Path $scriptDir $ManifestPath }
    $ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)

    if (-not $HostPath) {
        $distDir = Join-Path $scriptDir "dist"
        $newest = Get-ChildItem -LiteralPath $distDir -Filter "browserpilot-host*.exe" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newest) { $HostPath = $newest.FullName }
    }
    if (-not $HostPath) {
        Fail "No -HostPath and no browserpilot-host*.exe under native-host/dist; run node scripts/build-host.mjs first"
    }
    if (-not [System.IO.Path]::IsPathRooted($HostPath)) { $HostPath = Join-Path $scriptDir $HostPath }
    if (-not (Test-Path -LiteralPath $HostPath -PathType Leaf)) {
        Fail "Host exe does not exist; refusing to register: $HostPath (run node scripts/build-host.mjs)"
    }
    $HostPath = (Resolve-Path -LiteralPath $HostPath).Path

    $manifest = [ordered]@{
        name            = $HostName
        description     = if ($template.description) { [string]$template.description } else { "BrowserPilot native messaging host" }
        path            = $HostPath
        type            = "stdio"
        allowed_origins = @("chrome-extension://$resolvedExtensionId/")
    }
    $manifestText = ($manifest | ConvertTo-Json -Depth 5)

    # Re-validate the in-memory manifest before writing anything.
    $parsedManifest = $manifestText | ConvertFrom-Json
    if ($parsedManifest.name -ne $HostName) { Fail "Generated manifest has an unexpected name" }
    if ($parsedManifest.type -ne "stdio") { Fail "Generated manifest has an unexpected type" }
    if ([System.IO.Path]::GetFullPath([string]$parsedManifest.path) -ne $HostPath) { Fail "Generated manifest path does not match the exe" }
    $expectedOrigin = "chrome-extension://$resolvedExtensionId/"
    if (@($parsedManifest.allowed_origins).Count -ne 1 -or @($parsedManifest.allowed_origins)[0] -ne $expectedOrigin) {
        Fail "Generated manifest allowed_origins does not match the extension ID"
    }

    $targets = @()
    $chromeKey = $RegistryRoot.TrimEnd('\') + '\Google\Chrome\NativeMessagingHosts\' + $HostName
    $targets += [pscustomobject]@{ browser = "chrome"; registryPath = $chromeKey }
    if ($IncludeEdge) {
        $edgeKey = $RegistryRoot.TrimEnd('\') + '\Microsoft\Edge\NativeMessagingHosts\' + $HostName
        $targets += [pscustomobject]@{ browser = "edge"; registryPath = $edgeKey }
    }

    $backupTargets = @()
    foreach ($target in $targets) {
        $state = Read-RegistryDefault $target.registryPath
        $backupTargets += [ordered]@{
            browser          = $target.browser
            registryPath     = $target.registryPath
            keyExisted       = [bool]$state.keyExisted
            hasDefault       = [bool]$state.hasDefault
            previousDefault  = $state.value
            previousManifest = Get-ManifestSummary ([string]$state.value)
        }
    }

    $registered = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $targets.Count; $i++) {
        [void]$registered.Add([ordered]@{
            browser         = $targets[$i].browser
            registryPath    = $targets[$i].registryPath
            previousDefault = $backupTargets[$i].previousDefault
            action          = "planned"
        })
    }
    $result = [ordered]@{
        ok           = $true
        dryRun       = [bool]$DryRun
        hostName     = $HostName
        extensionId  = $resolvedExtensionId
        manifestPath = $ManifestPath
        hostPath     = $HostPath
        backupFile   = $null
        registered   = @($registered)
    }

    if ($DryRun) {
        Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
        exit 0
    }

    # Order matters: backup first, then manifest, then registry.
    if (-not $BackupDir) { $BackupDir = Join-Path $scriptDir "backup" }
    if (-not [System.IO.Path]::IsPathRooted($BackupDir)) { $BackupDir = Join-Path $scriptDir $BackupDir }
    if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $backupFile = Join-Path $BackupDir ($stamp + ".json")
    $suffix = 0
    while (Test-Path -LiteralPath $backupFile) {
        $suffix++
        $backupFile = Join-Path $BackupDir ($stamp + "-" + $suffix + ".json")
    }
    $backup = [ordered]@{
        hostName        = $HostName
        createdAt       = (Get-Date).ToUniversalTime().ToString("o")
        createdAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        note            = "register.ps1 auto backup on $env:COMPUTERNAME by $env:USERNAME; native-host/unregister.ps1 restores these values verbatim"
        manifestPath    = $ManifestPath
        hostPath        = $HostPath
        extensionId     = $resolvedExtensionId
        targets         = $backupTargets
    }
    Write-Utf8NoBom $backupFile ($backup | ConvertTo-Json -Depth 8)
    $result.backupFile = $backupFile

    Write-Utf8NoBom $ManifestPath $manifestText

    for ($i = 0; $i -lt $targets.Count; $i++) {
        Set-RegistryDefault $targets[$i].registryPath $ManifestPath
        $registered[$i].action = "registered"
    }

    Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
    exit 0
} catch {
    [Console]::Error.WriteLine("[register] ERROR: " + $_.Exception.Message)
    exit 1
}
