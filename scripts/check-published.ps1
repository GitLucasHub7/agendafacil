# Somente leitura de dois arquivos públicos; não usa login, tokens nem arquivos .env.
param([Parameter(Mandatory=$true)][string]$Base)
$ErrorActionPreference = 'Stop'
$uri = [uri]$Base
if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Informe somente a origem HTTPS pública do site.' }
$checks = @(
    @{ File = 'firebase-config.js'; Name = 'projectId'; Pattern = '["'']?projectId["'']?\s*[:=]\s*["'']([^"'']+)["'']' },
    @{ File = 'app-mode.js'; Name = 'APP_MODE'; Pattern = '\bAPP_MODE\b\s*=\s*["''](spark|blaze)["'']' }
)
foreach ($check in $checks) {
    try {
        $response = Invoke-WebRequest -Uri ($Base.TrimEnd('/') + '/' + $check.File) -TimeoutSec 20
        $match = [regex]::Match([string]$response.Content, $check.Pattern)
        $value = if ($match.Success) { $match.Groups[1].Value } else { 'não identificado' }
        Write-Output ($check.File + ': HTTP ' + $response.StatusCode + '; ' + $check.Name + '=' + $value)
    } catch {
        $status = if ($_.Exception.Response) { [string][int]$_.Exception.Response.StatusCode } else { 'falha de conexão' }
        Write-Output ($check.File + ': HTTP ' + $status + '; ' + $check.Name + ' não confirmado')
    }
}
