# Creates the local development role and databases for LIKApcs on Windows.
# Requires PostgreSQL installed with psql on PATH; run from an elevated PowerShell if needed.
# Usage: .\scripts\dev-db.ps1 [-Password likapcs_dev_password] [-SuperUser postgres]
param(
  [string]$Password = "likapcs_dev_password",
  [string]$SuperUser = "postgres"
)
$ErrorActionPreference = "Stop"
$sql = @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'likapcs') THEN
    CREATE ROLE likapcs LOGIN PASSWORD '$Password' CREATEDB;
  END IF;
END `$`$;
"@
$sql | psql -U $SuperUser -v ON_ERROR_STOP=1
foreach ($db in @("likapcs", "likapcs_test")) {
  $exists = psql -U $SuperUser -tAc "SELECT 1 FROM pg_database WHERE datname='$db'"
  if ($exists -ne "1") { psql -U $SuperUser -c "CREATE DATABASE $db OWNER likapcs" }
}
Write-Host "Databases ready. Connection string:"
Write-Host "  LIKAPCS_DATABASE_URL=postgres://likapcs:$Password@127.0.0.1:5432/likapcs"
