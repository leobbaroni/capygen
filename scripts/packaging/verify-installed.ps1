param(
  [Parameter(Mandatory)][string]$ArtifactDirectory,
  [Parameter(Mandatory)][string]$ExpectedCommit,
  [Parameter(Mandatory)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OS -ne 'Windows_NT') {
  throw 'Installer execution is restricted to disposable hosted Windows GitHub Actions.'
}
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$' -or $ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid expected artifact identity.' }
function Get-CapygenRegistration {
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'capygen' }
}
if (Get-CapygenRegistration) { throw 'An existing capygen installation must not be changed.' }
$audit = Get-Content -LiteralPath (Join-Path $ArtifactDirectory 'artifact-audit.json') -Raw | ConvertFrom-Json
if ($audit.sourceCommit -ne $ExpectedCommit -or $audit.version -ne $ExpectedVersion -or $audit.sourceDirty -ne $false) { throw 'Artifact provenance mismatch.' }
$installerName = "capygen-$ExpectedVersion-setup.exe"
$entries = @($audit.artifacts | Where-Object { $_.url -eq $installerName })
if ($entries.Count -ne 1) { throw 'Expected one audited installer.' }
$installer = [IO.Path]::GetFullPath((Join-Path $ArtifactDirectory $installerName))
$checksum = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($checksum -ne $entries[0].sha256) { throw 'Installer checksum mismatch.' }
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\','/')
$root = Join-Path $runner ('capygen installed ü smoke-' + [Guid]::NewGuid().ToString('N'))
$install = Join-Path $root 'Application space ü'
$testRoot = Join-Path $root 'test'
New-Item -ItemType Directory -Path $root | Out-Null
$exe = Join-Path $install 'capygen.exe'
$uninstaller = Join-Path $install 'Uninstall capygen.exe'
$proof = [ordered]@{ version = $ExpectedVersion; sourceCommit = $ExpectedCommit; installerSha256 = $checksum; hostedWindows = $true; installed = $false; runtimePassed = $false; uninstalled = $false; preserved = $false; passed = $false }
$failure = $null
$hashes = @{}
try {
  # NSIS requires /D last and consumes its unquoted remainder, including spaces.
  $process = Start-Process -FilePath $installer -ArgumentList "/S /currentuser /D=$install" -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw 'Installer failed to produce the requested executable.' }
  $proof.installed = $true
  $env:CAPYGEN_INSTALLED_EXE = $exe
  $env:CAPYGEN_INSTALLED_TEST_ROOT = $testRoot
  corepack pnpm exec playwright test --config scripts/packaging/installed.playwright.config.ts
  if ($LASTEXITCODE) { throw "Installed runtime checks failed with exit code $LASTEXITCODE." }
  $proof.runtimePassed = $true
  foreach ($relative in @('profile/capygen.db','claude/fixture-preserved.txt','codex/fixture-preserved.txt','project/fixture-preserved.txt')) {
    $file = Join-Path $testRoot $relative
    $hashes[$relative] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  }
} catch { $failure = $_.Exception.Message }
finally {
  try {
    if (Test-Path -LiteralPath $uninstaller) {
      $removal = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
      if ($removal.ExitCode -ne 0 -or (Test-Path -LiteralPath $exe) -or (Get-CapygenRegistration)) { throw 'Uninstaller did not remove the owned installation.' }
      $proof.uninstalled = $true
    } elseif ($proof.installed) { throw 'Generated uninstaller missing.' }
    if ($hashes.Count -eq 4) {
      foreach ($relative in $hashes.Keys) {
        if ((Get-FileHash -LiteralPath (Join-Path $testRoot $relative) -Algorithm SHA256).Hash -ne $hashes[$relative]) { throw 'Uninstall changed an owned user-data or backend fixture.' }
      }
      $proof.preserved = $true
    }
  } catch { $failure = ($failure, $_.Exception.Message | Where-Object { $_ }) -join ' '; }
  $proof.passed = $proof.installed -and $proof.runtimePassed -and $proof.uninstalled -and $proof.preserved -and -not $failure
  if ($failure) { $proof.error = $failure }
  New-Item -ItemType Directory -Force -Path e2e-out | Out-Null
  $proof | ConvertTo-Json | Set-Content -LiteralPath e2e-out/installed-smoke-proof.json
  $resolved = [IO.Path]::GetFullPath($root)
  if (-not $resolved.StartsWith($runner + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved).StartsWith('capygen installed ü smoke-'))) { throw 'Unexpected cleanup target.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
if (-not $proof.passed) { throw ($failure ?? 'Installed verification incomplete.') }
