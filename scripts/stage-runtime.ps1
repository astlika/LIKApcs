<#
.SYNOPSIS
  Stages the self-contained LIKApcs Server runtime that the main-PC installer (LIKApcs-Setup.exe)
  ships next to the Admin app. Run on Windows (locally or in CI) before `tauri build`.

.DESCRIPTION
  Produces apps/likapcs-admin/src-tauri/runtime/
    likapcs-server.exe        Node.js runtime (renamed node.exe) + LICENSE
    server/dist/*.js          the bundled server + CLI (built from apps/likapcs-server)
    server/database/migrations/*.sql
    pgsql/                    portable PostgreSQL (initdb, pg_ctl, postgres + required DLLs, lib, share)
  Every download is verified against a pinned SHA-256 before it is used.

.PARAMETER SkipServerBuild
  Reuse apps/likapcs-server/dist instead of running `pnpm --filter @likapcs/server build`.
#>
[CmdletBinding()]
param(
  [switch] $SkipServerBuild,
  [string] $NodeVersion = '22.23.3',
  [string] $NodeSha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71',
  [string] $PgVersion = '17.11.0',
  [string] $PgSha256 = '98040fae18dd9633ff95932125b0cecf0a45a1a9312e216e2a33ad03a31d4251'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$runtime = Join-Path $root 'apps/likapcs-admin/src-tauri/runtime'
$cache = Join-Path $root '.cache/runtime-downloads'
New-Item -ItemType Directory -Force $cache | Out-Null

function Get-Verified([string] $Url, [string] $Target, [string] $Sha256) {
  if (-not (Test-Path $Target) -or (Get-FileHash $Target -Algorithm SHA256).Hash -ne $Sha256) {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
  }
  $actual = (Get-FileHash $Target -Algorithm SHA256).Hash
  if ($actual -ne $Sha256) { throw "Checksum mismatch for $Target`n expected $Sha256`n actual   $actual" }
  Write-Host "Verified $(Split-Path $Target -Leaf)"
}

# 1. Server bundle -------------------------------------------------------------------------------
if (-not $SkipServerBuild) {
  Push-Location $root
  try { pnpm --filter @likapcs/server build; if ($LASTEXITCODE -ne 0) { throw 'server build failed' } }
  finally { Pop-Location }
}
if (Test-Path $runtime) { Remove-Item -Recurse -Force $runtime }
New-Item -ItemType Directory -Force "$runtime/server/dist", "$runtime/server/database/migrations" | Out-Null
Copy-Item "$root/apps/likapcs-server/dist/*.js" "$runtime/server/dist/"
Copy-Item "$root/database/migrations/*.sql" "$runtime/server/database/migrations/"

# 2. Node.js runtime ----------------------------------------------------------------------------------
$nodeZip = Join-Path $cache "node-v$NodeVersion-win-x64.zip"
Get-Verified "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $nodeZip $NodeSha256
$nodeDir = Join-Path $cache "node-v$NodeVersion-win-x64"
if (-not (Test-Path "$nodeDir/node.exe")) { Expand-Archive $nodeZip -DestinationPath $cache -Force }
Copy-Item "$nodeDir/node.exe" "$runtime/likapcs-server.exe"
Copy-Item "$nodeDir/LICENSE" "$runtime/NODE-LICENSE.txt"

# 3. Portable PostgreSQL (io.zonky.test embedded-postgres-binaries, MIT/PostgreSQL licence) -----------------
$pgJar = Join-Path $cache "embedded-postgres-binaries-windows-amd64-$PgVersion.jar"
Get-Verified "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/$PgVersion/embedded-postgres-binaries-windows-amd64-$PgVersion.jar" $pgJar $PgSha256
$pgExtract = Join-Path $cache "pg-$PgVersion"
if (-not (Test-Path "$pgExtract/bin/postgres.exe")) {
  if (Test-Path $pgExtract) { Remove-Item -Recurse -Force $pgExtract }
  New-Item -ItemType Directory -Force $pgExtract | Out-Null
  $jarZip = "$pgJar.zip"
  Copy-Item $pgJar $jarZip -Force
  $jarDir = Join-Path $cache "pg-$PgVersion-jar"
  if (Test-Path $jarDir) { Remove-Item -Recurse -Force $jarDir }
  Expand-Archive $jarZip -DestinationPath $jarDir -Force
  $txz = Get-ChildItem $jarDir -Filter '*.txz' | Select-Object -First 1
  if (-not $txz) { throw 'postgres txz archive not found inside the jar' }
  if (Get-Command 7z -ErrorAction SilentlyContinue) {
    # .txz = xz-compressed tar: first decompress to .tar, then unpack the tar.
    $tarDir = Join-Path $cache "pg-$PgVersion-tar"
    if (Test-Path $tarDir) { Remove-Item -Recurse -Force $tarDir }
    & 7z e -y "-o$tarDir" $txz.FullName | Out-Null
    $tarFile = Get-ChildItem $tarDir -Filter '*.tar' | Select-Object -First 1
    if (-not $tarFile) { throw 'xz decompression did not produce a tar file' }
    & 7z x -y "-o$pgExtract" $tarFile.FullName | Out-Null
    if (-not (Test-Path "$pgExtract/bin/postgres.exe")) { throw 'tar extraction did not produce bin/postgres.exe' }
  } else {
    tar -xJf $txz.FullName -C $pgExtract
    if ($LASTEXITCODE -ne 0) { throw 'tar extraction failed (install 7-Zip)' }
  }
}

# Only what initdb / pg_ctl / postgres need at runtime (no psql, pg_dump, docs or locales).
$keepBin = @(
  'initdb.exe', 'pg_ctl.exe', 'postgres.exe',
  'libpq.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll',
  'icudt67.dll', 'icuin67.dll', 'icuuc67.dll',
  'libiconv-2.dll', 'libintl-9.dll', 'liblz4.dll', 'libwinpthread-1.dll',
  'libxml2.dll', 'libxslt.dll', 'libzstd.dll', 'zlib1.dll'
)
New-Item -ItemType Directory -Force "$runtime/pgsql/bin" | Out-Null
foreach ($f in $keepBin) {
  $src = Join-Path "$pgExtract/bin" $f
  if (-not (Test-Path $src)) { throw "expected PostgreSQL file missing: $f" }
  Copy-Item $src "$runtime/pgsql/bin/"
}
Copy-Item -Recurse "$pgExtract/lib" "$runtime/pgsql/lib"
Copy-Item -Recurse "$pgExtract/share" "$runtime/pgsql/share"
foreach ($d in @('doc', 'locale', 'man')) {
  if (Test-Path "$runtime/pgsql/share/$d") { Remove-Item -Recurse -Force "$runtime/pgsql/share/$d" }
}
# Licence texts
Get-ChildItem $pgExtract -File | Where-Object { $_.Name -match 'LICENSE|COPYRIGHT' } | Copy-Item -Destination "$runtime/pgsql/"
@"
PostgreSQL $PgVersion portable binaries from https://github.com/zonkyio/embedded-postgres-binaries
PostgreSQL is released under the PostgreSQL Licence (https://www.postgresql.org/about/licence/).
"@ | Set-Content "$runtime/pgsql/README-LICENSE.txt"

# 4. MSVC runtime DLLs the PostgreSQL binaries depend on (not present on every fresh Windows). ----------------
$crt = Get-ChildItem 'C:\Program Files\Microsoft Visual Studio' -Recurse -Filter 'vcruntime140.dll' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\Microsoft\.VC14\d\.CRT\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if ($crt) {
  foreach ($dll in @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')) {
    $p = Join-Path $crt.DirectoryName $dll
    if (Test-Path $p) { Copy-Item $p "$runtime/pgsql/bin/" }
  }
  Write-Host "Bundled MSVC runtime from $($crt.DirectoryName)"
} else {
  Write-Warning 'MSVC runtime DLLs not found on this machine; PostgreSQL needs the VC++ 2015-2022 x64 redistributable installed on the target PC.'
}

# 5. Summary -------------------------------------------------------------------------------------------------------------
$size = [math]::Round((Get-ChildItem $runtime -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Runtime staged in $runtime ($size MB)"
Get-ChildItem $runtime | Select-Object Name, Length | Format-Table -AutoSize | Out-String | Write-Host
