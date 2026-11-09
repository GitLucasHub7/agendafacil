$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $projectRoot
try {
    $nodeVersion = & node --version
    if ($nodeVersion -notmatch '^v22\.') { throw 'Use Node.js 22 para reproduzir o runtime das Functions.' }
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
    if ($javaVersion -notmatch 'version "(\d+)' -or [int]$Matches[1] -lt 21) { throw 'Use Java 21 ou superior para o emulador Firestore.' }
    $env:CI = 'true'
    $env:XDG_CONFIG_HOME = Join-Path $projectRoot '.firebase/validation-config'
    $env:FIREBASE_EMULATORS_PATH = Join-Path $projectRoot '.firebase/emulator-cache'
    $env:FIREBASE_CLI_DISABLE_UPDATE_CHECK = 'true'
    $env:GCLOUD_PROJECT = 'demo-agendafacil'
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar ferramentas.' }
    & npm.cmd --prefix functions ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências das Functions.' }
    foreach ($script in @('check:assets', 'test:unit', 'test:rules', 'test:local')) {
        & npm.cmd run $script
        if ($LASTEXITCODE -ne 0) { throw "Falhou: $script" }
    }
    # A versão do GitHub usa somente configuração demo e não valida um ambiente de deploy.
    & npm.cmd run check:publication
    if ($LASTEXITCODE -ne 0) { throw 'Verificação de publicação falhou.' }
    & npm.cmd audit --audit-level=moderate
    if ($LASTEXITCODE -ne 0) { throw 'Auditoria das ferramentas aponta pendências.' }
    & npm.cmd --prefix functions audit --audit-level=moderate
    if ($LASTEXITCODE -ne 0) { throw 'Auditoria das Functions aponta pendências.' }
    Write-Output 'Validação local concluída. Nenhum deploy foi executado.'
} finally { Pop-Location }
