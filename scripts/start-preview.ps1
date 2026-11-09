param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path (Split-Path (Split-Path $projectRoot)) 'work/runtimes'
$portableNode = Join-Path $runtimeRoot 'node-v22.23.4-win-x64'
$portableJava = Join-Path $runtimeRoot 'jdk-21.0.13+9-jre/bin'
if (Test-Path -LiteralPath (Join-Path $portableNode 'node.exe')) { $env:PATH = $portableNode + ';' + $env:PATH }
if (Test-Path -LiteralPath (Join-Path $portableJava 'java.exe')) { $env:PATH = $portableJava + ';' + $env:PATH }
if ((& node --version) -notmatch '^v22\.') { throw 'Instale Node.js 22 para abrir a previa.' }
$javaStart = New-Object System.Diagnostics.ProcessStartInfo
$javaStart.FileName = 'java'
$javaStart.Arguments = '-version'
$javaStart.UseShellExecute = $false
$javaStart.CreateNoWindow = $true
$javaStart.RedirectStandardError = $true
$javaProcess = [System.Diagnostics.Process]::Start($javaStart)
$javaVersion = $javaProcess.StandardError.ReadToEnd()
$javaProcess.WaitForExit()
$javaProcess.Dispose()
if ($javaVersion -notmatch 'version "(\d+)' -or [int]$Matches[1] -lt 21) { throw 'Instale Java 21 ou superior para abrir a previa.' }
$env:NODE_OPTIONS = '--use-system-ca'
$cache = Join-Path (Split-Path $runtimeRoot) 'emulator-cache'
if (Test-Path -LiteralPath $cache) { $env:FIREBASE_EMULATORS_PATH = $cache }
if ($CheckOnly) { Write-Output 'Node 22 e Java 21 prontos para a previa.'; return }
Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath 'node_modules/firebase-tools/lib/bin/firebase.js')) {
        & npm.cmd ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel instalar as ferramentas locais.' }
    }
    & npm.cmd run preview
    if ($LASTEXITCODE -ne 0) { throw 'A previa encerrou com erro. Confira se as portas 5000, 8080 e 9099 estao livres.' }
} finally { Pop-Location }
