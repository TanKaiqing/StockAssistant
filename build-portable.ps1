param([switch]$SkipDependencies)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$stockPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $stockPython)) { throw 'Run start.cmd once to create the Python environment.' }
if (-not $SkipDependencies) {
    & $stockPython -m pip install -r requirements-desktop.txt
    if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' }
}
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
$stockOutput = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'release\StockAssistant'))
if (-not $stockOutput.StartsWith([IO.Path]::GetFullPath($PSScriptRoot) + [IO.Path]::DirectorySeparatorChar)) { throw 'Output path is outside the workspace.' }
if (Test-Path -LiteralPath (Join-Path $stockOutput 'data\ledger.sqlite3')) { throw 'Output contains user data; move it to a safe location before rebuilding.' }
& $stockPython -m PyInstaller --noconfirm --distpath release --workpath build\portable StockAssistant.spec
if ($LASTEXITCODE -ne 0) { throw 'EXE build failed.' }
& $stockPython scripts\finish_portable.py
if ($LASTEXITCODE -ne 0) { throw 'Portable release finalization failed.' }
Write-Output ('Ready: ' + (Join-Path $stockOutput 'StockAssistant.exe'))
