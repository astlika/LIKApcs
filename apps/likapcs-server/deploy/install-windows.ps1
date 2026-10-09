<#
.SYNOPSIS
  Installs (or removes) the LIKApcs Server as a Windows service and opens the firewall port.

.DESCRIPTION
  Uses WinSW (https://github.com/winsw/winsw) to wrap `node dist/index.js` in an auto-starting
  service named LIKApcsServer. Must be run from an elevated PowerShell inside the server folder
  (the folder that contains dist\ and .env). Downloads WinSW on first use.

.PARAMETER Uninstall
  Stops and removes the service instead of installing it.

.PARAMETER Port
  TCP port to open in Windows Firewall (default 4700, must match LIKAPCS_PORT in .env).
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [int]$Port = 4700,
  [string]$WinswVersion = 'v2.12.0'
)

$ErrorActionPreference = 'Stop'
$ServiceId = 'LIKApcsServer'
$Root = (Get-Location).Path
$ServiceDir = Join-Path $Root 'service'
$Exe = Join-Path $ServiceDir "$ServiceId.exe"
$Xml = Join-Path $ServiceDir "$ServiceId.xml"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated (Administrator) PowerShell.'
}

if ($Uninstall) {
  if (Test-Path $Exe) {
    & $Exe stop 2>$null
    & $Exe uninstall
  }
  Remove-NetFirewallRule -DisplayName 'LIKApcs Server' -ErrorAction SilentlyContinue
  Write-Host "Service $ServiceId removed." -ForegroundColor Green
  return
}

if (-not (Test-Path (Join-Path $Root 'dist\index.js'))) { throw "dist\index.js not found - run this script from the server folder." }
if (-not (Test-Path (Join-Path $Root '.env'))) { throw ".env not found - copy .env.example to .env and configure it first." }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js was not found in PATH. Install Node.js 20 LTS from https://nodejs.org and reopen PowerShell.' }

New-Item -ItemType Directory -Force $ServiceDir | Out-Null
New-Item -ItemType Directory -Force (Join-Path $Root 'logs') | Out-Null

if (-not (Test-Path $Exe)) {
  $url = "https://github.com/winsw/winsw/releases/download/$WinswVersion/WinSW-x64.exe"
  Write-Host "Downloading WinSW $WinswVersion ..."
  Invoke-WebRequest -Uri $url -OutFile $Exe
}

$xmlContent = @"
<service>
  <id>$ServiceId</id>
  <name>LIKApcs Server</name>
  <description>LIKApcs POS / Gaming Station server (HTTP + WebSocket on port $Port)</description>
  <executable>$node</executable>
  <arguments>dist\index.js</arguments>
  <workingdirectory>$Root</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <logpath>$Root\logs</logpath>
  <stoptimeout>20 sec</stoptimeout>
</service>
"@
Set-Content -Path $Xml -Value $xmlContent -Encoding UTF8

Write-Host 'Applying database migrations ...'
& $node (Join-Path $Root 'dist\cli.js') migrate
if ($LASTEXITCODE -ne 0) { throw 'Migration failed - fix the database configuration in .env before installing the service.' }

$existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host 'Service already exists - restarting it with the new configuration.'
  & $Exe stop 2>$null
  & $Exe refresh
} else {
  & $Exe install
}
& $Exe start

if (-not (Get-NetFirewallRule -DisplayName 'LIKApcs Server' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'LIKApcs Server' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
  Write-Host "Firewall: allowed inbound TCP $Port on private/domain networks."
}

Start-Sleep -Seconds 3
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/system/health" -TimeoutSec 5
  Write-Host "Service $ServiceId is running - server version $($health.version)." -ForegroundColor Green
} catch {
  Write-Warning "Service installed but the health check failed: $($_.Exception.Message). Check logs\$ServiceId.out.log"
}
