$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$target = Join-Path $root '.env'
if (Test-Path -LiteralPath $target) { throw '.env ya existe; no fue sobrescrito' }
$example = Get-Content -Raw -LiteralPath (Join-Path $root '.env.example')
function Random-Base64([int]$Bytes) { [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)) }
$content = $example.Replace('replace-with-at-least-32-random-characters', (Random-Base64 48))
$content = $content.Replace('replace-with-another-random-value', (Random-Base64 48))
$content = $content.Replace('replace-with-field-base64-32-byte-key', (Random-Base64 32))
$content = $content.Replace('replace-with-index-base64-32-byte-key', (Random-Base64 32))
$content = $content.Replace('replace-with-a-long-random-service-token', (Random-Base64 48))
$bootstrapPassword = 'OA-' + (Random-Base64 24).Replace('/','_').Replace('+','-')
$content = $content.Replace('replace-with-random-bootstrap-password', $bootstrapPassword)
[IO.File]::WriteAllText($target, $content, [Text.UTF8Encoding]::new($false))
Write-Host "Se creó $target"
Write-Host "Contraseña bootstrap inicial: $bootstrapPassword"
Write-Host 'Guárdela en un gestor seguro y cámbiela antes de usar datos reales.'
