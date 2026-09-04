param(
  [string]$SourceDirectory,
  [string]$PackageZip,
  [string]$PackageUrl = $env:MODEL_PACKAGE_URL,
  [string]$Token = $env:GH_MODELS_TOKEN
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$modelParent = Join-Path $repoRoot '.models'
$target = Join-Path $modelParent 'oa-final-2026-09-03'
New-Item -ItemType Directory -Force -Path $modelParent | Out-Null

function Test-Package([string]$Path) {
  $manifestPath = Join-Path $Path 'MANIFEST.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Falta MANIFEST.json' }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.release -ne 'oa-final-2026-09-03' -or $manifest.files.Count -ne 51) { throw 'Versión o cantidad de archivos incorrecta' }
  foreach ($item in $manifest.files) {
    $file = Join-Path $Path $item.path
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Falta $($item.path)" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    if ($actual -ne $item.sha256) { throw "Hash inválido: $($item.path)" }
  }
}

if (Test-Path -LiteralPath $target -PathType Container) {
  Test-Package $target
  Write-Host "Modelos verificados en $target"
  exit 0
}

$staging = Join-Path $modelParent ('.staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  if ($SourceDirectory) {
    $source = (Resolve-Path -LiteralPath $SourceDirectory).Path
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $staging -Recurse
  } else {
    $archive = if ($PackageZip) { (Resolve-Path -LiteralPath $PackageZip).Path } else { Join-Path $staging 'models.zip' }
    if (-not $PackageZip) {
      if (-not $PackageUrl) { throw 'Indique -SourceDirectory, -PackageZip o MODEL_PACKAGE_URL' }
      $headers = if ($Token) { @{ Authorization = "Bearer $Token"; Accept = 'application/octet-stream' } } else { @{} }
      Invoke-WebRequest -Uri $PackageUrl -Headers $headers -OutFile $archive
    }
    $extract = Join-Path $staging 'extracted'
    Expand-Archive -LiteralPath $archive -DestinationPath $extract
    $candidate = if (Test-Path -LiteralPath (Join-Path $extract 'MANIFEST.json')) { $extract } else {
      $folders = @(Get-ChildItem -LiteralPath $extract -Directory)
      if ($folders.Count -ne 1) { throw 'El ZIP debe contener el paquete directamente o una única carpeta raíz' }
      $folders[0].FullName
    }
    Test-Package $candidate
    Move-Item -LiteralPath $candidate -Destination $target
  }
  if ($SourceDirectory) { Test-Package $staging; Move-Item -LiteralPath $staging -Destination $target; $staging = $null }
  Test-Package $target
  Write-Host 'Los 51 archivos y sus hashes fueron verificados correctamente.'
} finally {
  if ($staging -and (Test-Path -LiteralPath $staging)) {
    $resolved = (Resolve-Path -LiteralPath $staging).Path
    if ($resolved.StartsWith($modelParent + [IO.Path]::DirectorySeparatorChar)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  }
}
