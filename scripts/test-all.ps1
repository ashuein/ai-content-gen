# Unified test runner (Windows)
Param()

$ErrorActionPreference = 'Stop'

function Write-Section($title) { Write-Host "`n=== $title ===" -ForegroundColor Cyan }
function Pass($msg) { Write-Host "PASS: $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red }
function Skip($msg) { Write-Host "SKIP: $msg" -ForegroundColor Yellow }

# Repo root
$root = Split-Path -Parent $PSScriptRoot

# Load .env
$envPath = Join-Path $root ".env"
if (Test-Path $envPath) {
	Get-Content $envPath | ForEach-Object {
		if ($_ -match '^(?<k>[^#=]+)=(?<v>.*)$') {
			$k = $matches['k'].Trim(); $v = $matches['v']
			[Environment]::SetEnvironmentVariable($k, $v)
		}
	}
}

# Activate venv if present (prefer .\venv, fallback .\.venv)
$act1 = Join-Path $root 'venv\Scripts\Activate.ps1'
$act2 = Join-Path $root '.venv\Scripts\Activate.ps1'
if (Test-Path $act1 -PathType Leaf) { . $act1 } elseif (Test-Path $act2 -PathType Leaf) { . $act2 }
# Ensure RDKIT_PYTHON defaults to venv python when present
if ([string]::IsNullOrEmpty($env:RDKIT_PYTHON)) {
	$venvPy1 = Join-Path $root 'venv\Scripts\python.exe'
	$venvPy2 = Join-Path $root '.venv\Scripts\python.exe'
	if (Test-Path $venvPy1 -PathType Leaf) { $env:RDKIT_PYTHON = $venvPy1 }
	elseif (Test-Path $venvPy2 -PathType Leaf) { $env:RDKIT_PYTHON = $venvPy2 }
}

# Results accumulator
$results = @()
function Add-Result($name, $status, $detail) {
	$results += [pscustomobject]@{ name=$name; status=$status; detail=$detail }
}

function Test-RdkitHealth([string]$base) {
	try {
		$health = Invoke-WebRequest -Uri ("$($base.TrimEnd('/'))/health") -UseBasicParsing -TimeoutSec 5
		return ($health.StatusCode -eq 200 -and $health.Content -match '"status"\s*:\s*"ok"')
	} catch { return $false }
}

function Parse-UrlPort([string]$base) {
	try { return ([uri]$base).Port } catch { return 8000 }
}

function Can-ImportRdkit([string]$py) {
	try {
		$tmp = New-TemporaryFile
		$proc = Start-Process -FilePath $py -ArgumentList @('-c','import rdkit,sys;sys.exit(0)') -NoNewWindow -PassThru -RedirectStandardOutput $tmp.FullName -RedirectStandardError $tmp.FullName -WorkingDirectory $root -ErrorAction SilentlyContinue
		$proc | Wait-Process | Out-Null
		$ok = ($proc.ExitCode -eq 0)
		Remove-Item $tmp.FullName -ErrorAction SilentlyContinue
		return $ok
	} catch { return $false }
}

$global:rdkitProc = $null
function Resolve-PythonExe() {
	$tryList = @()
	if (-not [string]::IsNullOrEmpty($env:RDKIT_PYTHON)) { $tryList += $env:RDKIT_PYTHON }
	$tryList += (Join-Path $root ".venv\Scripts\python.exe")
	$tryList += (Join-Path $root "venv\Scripts\python.exe")
	$tryList += 'py -3'
	$tryList += 'py'
	$tryList += 'python'
	$tryList += 'python3'
	foreach ($cand in $tryList) {
		if ($cand -eq 'py -3') {
			try { $out = & py -3 -c 'import rdkit,sys;sys.exit(0)' 2>$null; if ($LASTEXITCODE -eq 0) { return 'py -3' } } catch {}
			continue
		}
		if ($cand -eq 'py') {
			try { $out = & py -c 'import rdkit,sys;sys.exit(0)' 2>$null; if ($LASTEXITCODE -eq 0) { return 'py' } } catch {}
			continue
		}
		if ($cand -and ($cand -notlike 'py*')) {
			Write-Host "Check interpreter: $cand -> " -NoNewline -ForegroundColor DarkGray
			if (Test-Path $cand -PathType Leaf) { Write-Host 'present' -ForegroundColor DarkGray } else { Write-Host 'missing' -ForegroundColor DarkGray }
		}
		if ($cand -and (Can-ImportRdkit $cand)) { return $cand }
	}
	return $null
}

# Python env preflight (explicit existence checks)
Write-Section "Python env"
$defaultVenvPy1 = Join-Path $root ".venv\Scripts\python.exe"
$defaultVenvPy2 = Join-Path $root "venv\Scripts\python.exe"
Write-Host "Expected venv (.venv): $defaultVenvPy1 -> " -NoNewline -ForegroundColor DarkGray
if (Test-Path $defaultVenvPy1 -PathType Leaf) { Write-Host 'present' -ForegroundColor DarkGray } else { Write-Host 'missing' -ForegroundColor DarkGray }
Write-Host "Expected venv (venv):  $defaultVenvPy2 -> " -NoNewline -ForegroundColor DarkGray
if (Test-Path $defaultVenvPy2 -PathType Leaf) { Write-Host 'present' -ForegroundColor DarkGray } else { Write-Host 'missing' -ForegroundColor DarkGray }
if (-not [string]::IsNullOrEmpty($env:RDKIT_PYTHON)) {
	Write-Host "RDKIT_PYTHON=$($env:RDKIT_PYTHON) -> " -NoNewline -ForegroundColor DarkGray
	if (Test-Path $env:RDKIT_PYTHON -PathType Leaf) { Write-Host 'present' -ForegroundColor DarkGray } else { Write-Host 'missing' -ForegroundColor DarkGray }
}

$py = Resolve-PythonExe
if (-not $py) {
	Fail "No Python interpreter with rdkit found"
	Add-Result "Python" "FAIL" "rdkit missing"
} else {
	Write-Host "Using Python: $py" -ForegroundColor DarkGray
	Pass "rdkit import OK"
	Add-Result "Python" "PASS" "rdkit import ok"
}

# 1) RDKit CLI SVG test (uses selected Python)
Write-Section "RDKit CLI"
if (-not $py) {
	Skip "No Python interpreter"
	Add-Result "RDKit:cli" "SKIP" "no python"
} else {
	try {
		$render = Join-Path $root 'server\chem\render.py'
$svgOut = Join-Path $root 'CR_rendered\rdkit-test.svg'
        $proc2 = if ($py -eq 'py -3') { Start-Process -FilePath 'py' -ArgumentList @('-3', $render, 'CCO') -WorkingDirectory $root -RedirectStandardOutput $svgOut -RedirectStandardError (Join-Path $root 'CR_rendered\rdkit-test.err') -NoNewWindow -PassThru -Wait } elseif ($py -eq 'py') { Start-Process -FilePath 'py' -ArgumentList @($render,'CCO') -WorkingDirectory $root -RedirectStandardOutput $svgOut -RedirectStandardError (Join-Path $root 'CR_rendered\rdkit-test.err') -NoNewWindow -PassThru -Wait } else { Start-Process -FilePath $py -ArgumentList @($render,'CCO') -WorkingDirectory $root -RedirectStandardOutput $svgOut -RedirectStandardError (Join-Path $root 'CR_rendered\rdkit-test.err') -NoNewWindow -PassThru -Wait }
		if ($proc2.ExitCode -eq 0 -and (Test-Path $svgOut) -and ((Get-Content $svgOut -Raw) -match '<svg')) {
			Pass "RDKit SVG generated"
			Add-Result "RDKit:cli" "PASS" "svg present"
		} else {
			Fail "RDKit SVG failed"
			Add-Result "RDKit:cli" "FAIL" "nonzero exit or no svg"
		}
	} catch {
		Fail "RDKit CLI error: $($_.Exception.Message)"
		Add-Result "RDKit:cli" "FAIL" $_.Exception.Message
	}
}

# 2) TeX→SVG smoke test
Write-Section "TeX→SVG"
try {
	& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\test-tex.ps1') | Out-Null
$svg = Join-Path $root 'CR_rendered\test-hello.svg'
	if (Test-Path $svg -PathType Leaf) {
		Pass "Generated test-hello.svg"
Add-Result "TeX→SVG" "PASS" "CR_rendered/test-hello.svg exists"
	} else {
		Fail "test-hello.svg missing"
		Add-Result "TeX→SVG" "FAIL" "missing test-hello.svg"
	}
} catch {
	Fail ("TeX test failed: $($_.Exception.Message)")
	Add-Result "TeX→SVG" "FAIL" $_.Exception.Message
}

# 3) Chapter build
Write-Section "Chapter build"
$chapterJson = Join-Path $root 'CR_rendered\chapter.json'
try {
	$build = & cmd /c "npm run chapter:build" 2>&1
	Write-Host $build
	if ($LASTEXITCODE -ne 0) {
		throw "chapter:build exit $LASTEXITCODE"
	}
	if (-not (Test-Path $chapterJson -PathType Leaf)) { throw "chapter.json missing" }
	Pass "chapter:build wrote chapter.json"
	Add-Result "Build" "PASS" "chapter.json"
} catch {
	Fail ("Build failed: $($_.Exception.Message)")
	Add-Result "Build" "FAIL" $_.Exception.Message
}

# 4) Artifact validation
Write-Section "Artifacts"
if (Test-Path $chapterJson) {
	try {
		$doc = Get-Content $chapterJson -Raw | ConvertFrom-Json
		# Equation: must have html
		$eq = $doc.sections | Where-Object { $_.type -eq 'equation' }
		if ($eq -and $eq[0].html -and ($eq[0].html -match '<math')) {
			Pass "Equation rendered"
			Add-Result "Equation" "PASS" "MathML present"
		} else { Fail "Equation missing HTML"; Add-Result "Equation" "FAIL" "no html" }
		# Plot: svg present
		$pl = $doc.sections | Where-Object { $_.type -eq 'plot' }
		if ($pl -and $pl[0].svg -and ($pl[0].svg -match '<svg')) {
			Pass "Plot SVG present"
			Add-Result "Plot" "PASS" "svg present"
		} else { Fail "Plot missing SVG"; Add-Result "Plot" "FAIL" "no svg" }
		# Chem: svg present
		$ch = $doc.sections | Where-Object { $_.type -eq 'chem' }
		if ($ch -and $ch[0].svg -and ($ch[0].svg -match '<svg')) {
			Pass "Chem SVG present"
			Add-Result "Chem" "PASS" "svg present"
		} else { Fail "Chem missing SVG"; Add-Result "Chem" "FAIL" "no svg" }
		# Diagram: svg present
		$dg = $doc.sections | Where-Object { $_.type -eq 'diagram' }
		if ($dg -and $dg[0].svg -and ($dg[0].svg -match '<svg')) {
			Pass "Diagram SVG present"
			Add-Result "Diagram" "PASS" "svg present"
		} else { Fail "Diagram missing SVG"; Add-Result "Diagram" "FAIL" "no svg" }
		# Widget presence
		$wg = $doc.sections | Where-Object { $_.type -eq 'widget' }
		if ($wg) { Pass "Widget present"; Add-Result "Widget" "PASS" "present" } else { Skip "No widget"; Add-Result "Widget" "SKIP" "absent" }
	} catch {
		Fail ("Artifact validation failed: $($_.Exception.Message)")
		Add-Result "Artifacts" "FAIL" $_.Exception.Message
	}
} else {
	Skip "chapter.json not found"
	Add-Result "Artifacts" "SKIP" "no chapter.json"
}

# Summary
Write-Section "Summary"
$results | Format-Table -AutoSize

# Exit non-zero on any FAIL
if ($results | Where-Object { $_.status -eq "FAIL" }) { exit 1 } else { exit 0 }
