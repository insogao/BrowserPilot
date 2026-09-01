# Register native messaging host: com.browserpilot.browseragent (Chrome + Edge, HKCU)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File native-host/register.ps1
# Optional: -HostPath <abs path> -ExtensionId <id> -ManifestPath <abs path>
param(
    [string]$HostPath = "",
    [string]$ExtensionId = "nnollghpaggbcdkkgoieneffnlijinio",
    [string]$ManifestPath = ""
)

$ErrorActionPreference = "Continue"
$HostName = "com.browserpilot.browseragent"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $ManifestPath) { $ManifestPath = Join-Path $scriptDir "host.manifest.json" }
if (-not $HostPath) {
    if (Test-Path $ManifestPath) {
        try { $HostPath = (Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json).path } catch {}
    }
    if (-not $HostPath) { $HostPath = Join-Path $scriptDir "dist\browserpilot-host.exe" }
}

if (-not (Test-Path $HostPath)) {
    Write-Host "WARNING: host not found at $HostPath (run: node scripts/build-host.mjs)"
}

$manifest = @{
    name             = $HostName
    description      = "BrowserPilot native messaging host"
    path             = $HostPath
    type             = "stdio"
    allowed_origins  = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
# UTF-8 without BOM (Chrome native host manifest should be BOM-free)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $manifest, $utf8NoBom)
Write-Host "manifest written -> $ManifestPath"

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(default)" -Value $ManifestPath
Write-Host "registered HKCU Chrome: $regPath -> $ManifestPath"

$edgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
New-Item -Path $edgeRegPath -Force | Out-Null
Set-ItemProperty -Path $edgeRegPath -Name "(default)" -Value $ManifestPath
Write-Host "registered HKCU Edge: $edgeRegPath"
