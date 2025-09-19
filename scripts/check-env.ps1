# Check environment for Auto Doc Render MVP
Param()

Write-Host "Checking environment..." -ForegroundColor Cyan

function Test-Command {
	param([string]$cmd)
	$old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
	$null = Get-Command $cmd
	$ok = $?
	$ErrorActionPreference = $old
	return $ok
}

$results = @()

# Node
$results += [pscustomobject]@{ Name='node'; Present= (Test-Command node); Version= if (Test-Command node) { node -v } else { '' } }
$results += [pscustomobject]@{ Name='npm'; Present= (Test-Command npm); Version= if (Test-Command npm) { npm -v } else { '' } }

# Python
$results += [pscustomobject]@{ Name='python'; Present= (Test-Command python); Version= if (Test-Command python) { python --version } else { '' } }

# TeX toolchain
$results += [pscustomobject]@{ Name='dvisvgm'; Present= (Test-Command dvisvgm); Version= if (Test-Command dvisvgm) { (dvisvgm --version | Select-String -Pattern '^dvisvgm').ToString() } else { '' } }
$results += [pscustomobject]@{ Name='gswin64c'; Present= (Test-Command gswin64c); Version= if (Test-Command gswin64c) { (gswin64c --version) } else { '' } }
$results += [pscustomobject]@{ Name='tectonic'; Present= (Test-Command tectonic); Version= if (Test-Command tectonic) { tectonic --version } else { '' } }

# Local binaries via env
$dvipath = $env:DVISVGM_PATH
$gspath = $env:GHOSTSCRIPT_PATH
$results += [pscustomobject]@{ Name='DVISVGM_PATH'; Present= ([string]::IsNullOrEmpty($dvipath) -eq $false) -and [IO.File]::Exists($dvipath); Version=$dvipath }
$results += [pscustomobject]@{ Name='GHOSTSCRIPT_PATH'; Present= ([string]::IsNullOrEmpty($gspath) -eq $false) -and [IO.File]::Exists($gspath); Version=$gspath }

# RDKit service URL
$results += [pscustomobject]@{ Name='RDKIT_URL'; Present= [string]::IsNullOrEmpty($env:RDKIT_URL) -eq $false; Version=$env:RDKIT_URL }

$results | Format-Table -AutoSize

Write-Host "Tip: add dvisvgm folder to PATH or set DVISVGM_PATH; install Ghostscript, and run the Tectonic installer if using PGFPlots compile." -ForegroundColor DarkGray
