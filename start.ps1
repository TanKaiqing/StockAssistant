$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPython = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    Write-Host 'Creating a local Python environment...'
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
}
if (-not (Test-Path -LiteralPath '.venv/.stock-assistant-ready')) {
    & $taskPython -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
    New-Item -ItemType File -Path '.venv/.stock-assistant-ready' -Force | Out-Null
}
if (-not (Test-Path -LiteralPath 'node_modules')) {
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
}
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
Write-Host ''
Write-Host 'StockAssistant is ready: http://127.0.0.1:8000' -ForegroundColor Cyan
Write-Host 'Open this URL in your browser. Press Ctrl+C to stop.'
& $taskPython -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
