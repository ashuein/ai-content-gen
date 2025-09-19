# Orchestrated run: RDKit service + chapter build + Vite dev server
Param()

$ErrorActionPreference = 'Stop'

# Load .env
$envFile = Join-Path $PSScriptRoot "..\..\.env"
if (-not (Test-Path $envFile)) { $envFile = Join-Path $PSScriptRoot "..\..\.env" }
$repoRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $repoRoot
if (Test-Path "$repoRoot\.env") {
	Get-Content "$repoRoot\.env" | ForEach-Object {
		if ($_ -match '^(?<k>[^#=]+)=(?<v>.*)$') {
			$k = $matches['k'].Trim(); $v = $matches['v']
			[Environment]::SetEnvironmentVariable($k, $v)
		}
	}
}

# Activate Python venv
$venv = Join-Path $repoRoot ".venv\Scripts\activate.ps1"
if (-not (Test-Path $venv)) {
	Write-Host ".venv not found; please create it: python -m venv .venv" -ForegroundColor Yellow
} else {
	Write-Host "Activating venv..." -ForegroundColor Cyan
	. $venv
}

# Start RDKit service
$rdkitCmd = "uvicorn python.rdkit_service.main:app --host 127.0.0.1 --port 8000"
Write-Host "Starting RDKit service: $rdkitCmd" -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$repoRoot'; $rdkitCmd" | Out-Null
Start-Sleep -Seconds 2

# Build chapter
Write-Host "Building chapter..." -ForegroundColor Cyan
npm run chapter:build

# Start Vite dev server
Write-Host "Starting Vite dev server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$repoRoot'; npm run dev" | Out-Null

Write-Host "All services launched. Open http://localhost:5173" -ForegroundColor Green
