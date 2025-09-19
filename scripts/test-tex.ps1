# Test TeX → PDF → SVG using repo-local binaries from .env
Param()

$ErrorActionPreference = 'Stop'
# Repo root is parent of scripts directory
$root = Split-Path -Parent $PSScriptRoot

# Load .env
if (Test-Path "$root\.env") {
	Get-Content "$root\.env" | ForEach-Object {
		if ($_ -match '^(?<k>[^#=]+)=(?<v>.*)$') {
			$k = $matches['k'].Trim(); $v = $matches['v']
			[Environment]::SetEnvironmentVariable($k, $v)
		}
	}
}

# Resolve local binaries (fall back to repo-local defaults if env not set)
$tectonicEnv = if ($env:TECTONIC_BIN) { $env:TECTONIC_BIN } else { './tectonic.exe' }
$dvisvgmEnv = if ($env:DVISVGM_PATH) { $env:DVISVGM_PATH } else { './dvisvgm-3.5-win64/dvisvgm.exe' }
$gsEnv = if ($env:GHOSTSCRIPT_PATH) { $env:GHOSTSCRIPT_PATH } else { '' }

$tectonicPathInfo = Resolve-Path -LiteralPath (Join-Path $root $tectonicEnv) -ErrorAction SilentlyContinue
$dvisvgmPathInfo = Resolve-Path -LiteralPath (Join-Path $root $dvisvgmEnv) -ErrorAction SilentlyContinue
$gsPathInfo = if ($gsEnv) { Resolve-Path -LiteralPath (Join-Path $root $gsEnv) -ErrorAction SilentlyContinue } else { $null }

$tectonic = if ($tectonicPathInfo) { $tectonicPathInfo.Path } else { $null }
$dvisvgm = if ($dvisvgmPathInfo) { $dvisvgmPathInfo.Path } else { $null }
$gs = if ($gsPathInfo) { $gsPathInfo.Path } else { $null }

if (-not $tectonic) { throw "TECTONIC_BIN not set or file missing" }
if (-not $dvisvgm) { throw "DVISVGM_PATH not set or file missing" }
if (-not $gs) { Write-Host "Warning: Ghostscript not set; dvisvgm may fail depending on features" -ForegroundColor Yellow }

$tmp = Join-Path $root "tmp-tex"
$out = Join-Path $root "CR_rendered"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
New-Item -ItemType Directory -Force -Path $out | Out-Null

$tex = @'
\documentclass{standalone}
\usepackage{amsmath}
\begin{document}
$E=mc^2$
\end{document}
'@
Set-Content -Path (Join-Path $tmp "hello.tex") -Value $tex -Encoding UTF8

& "$tectonic" (Join-Path $tmp "hello.tex") --outdir $tmp --chatter minimal

$pdf = Join-Path $tmp "hello.pdf"
$svg = Join-Path $out "test-hello.svg"

# Prepend Ghostscript dir to PATH for dvisvgm
if ($gs) {
	$gsDir = Split-Path -Parent $gs
	$env:PATH = "$gsDir" + [IO.Path]::PathSeparator + $env:PATH
}

# Use fontmap + woff2 to avoid fontconfig and embed deterministic web fonts
$fontmap = (Join-Path $root 'fontmaps\tex2sys.map')
$arguments = @('--pdf', "$pdf", "--fontmap=$fontmap", '--font-format=woff2', '--verbosity=0', '--stdout')
$errLog = Join-Path $tmp 'dvisvgm.err'
$proc = Start-Process -FilePath "$dvisvgm" -ArgumentList $arguments -RedirectStandardOutput "$svg" -RedirectStandardError "$errLog" -NoNewWindow -PassThru
$proc | Wait-Process
# Clean up stderr log unless non-empty
if ((Test-Path $errLog) -and ((Get-Item $errLog).Length -eq 0)) { Remove-Item $errLog -Force }

Write-Host "Generated: $svg" -ForegroundColor Green
