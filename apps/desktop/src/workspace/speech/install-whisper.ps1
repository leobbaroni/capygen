param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (-not [IO.Path]::IsPathRooted($Destination) -or $destinationPath.TrimEnd('\') -eq [IO.Path]::GetPathRoot($destinationPath).TrimEnd('\')) {
    throw 'Choose a dedicated absolute speech runtime directory.'
}
$runtimePath = Join-Path $destinationPath 'b4938-small-q5_1'
if (Test-Path -LiteralPath $runtimePath) { throw 'The pinned speech runtime already exists. No files were changed.' }
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
$stagingPath = Join-Path $destinationPath ('install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingPath | Out-Null
try {
    Write-Host 'Downloading whisper.cpp b4938 for Windows x64 (8.4 MB) and the multilingual small-q5_1 model (190.1 MB).'
    Write-Host 'Sources: github.com/ggml-org/whisper.cpp and huggingface.co/ggerganov/whisper.cpp. Audio stays on this computer.'
    $archivePath = Join-Path $stagingPath 'runtime.zip'
    $modelPath = Join-Path $stagingPath 'ggml-small-q5_1.bin'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip' -OutFile $archivePath
    if ((Get-Item -LiteralPath $archivePath).Length -ne 8361840 -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne 'C2A4B60EDB11F7E11A9191FFB50929535527D4D91C9903DBE3E554583BBBC63D') { throw 'Runtime checksum mismatch. Nothing installed.' }
    Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin' -OutFile $modelPath
    if ((Get-Item -LiteralPath $modelPath).Length -ne 190085487 -or (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash -ne 'AE85E4A935D7A567BD102FE55AFC16BB595BDB618E11B2FC7591BC08120411BB') { throw 'Model checksum mismatch. Nothing installed.' }
    $expandedPath = Join-Path $stagingPath 'expanded'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedPath
    $executables = @(Get-ChildItem -LiteralPath $expandedPath -Filter 'whisper-cli.exe' -Recurse -File)
    if ($executables.Count -ne 1) { throw 'Unexpected runtime layout. Nothing installed.' }
    $preparedPath = Join-Path $stagingPath 'prepared'
    New-Item -ItemType Directory -Path $preparedPath | Out-Null
    Copy-Item -LiteralPath $executables[0].FullName -Destination $preparedPath
    Get-ChildItem -LiteralPath $executables[0].DirectoryName -Filter '*.dll' -File | Where-Object { $_.Name -eq 'whisper.dll' -or $_.Name -like 'ggml*.dll' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $preparedPath }
    foreach ($notice in @('LICENSE-whisper.cpp.txt', 'LICENSE-whisper-model.txt')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $notice) -Destination $preparedPath
    }
    Move-Item -LiteralPath $modelPath -Destination $preparedPath
    'b4938-small-q5_1' | Set-Content -LiteralPath (Join-Path $preparedPath 'installed.txt') -Encoding ASCII
    Move-Item -LiteralPath $preparedPath -Destination $runtimePath
    Write-Host 'Local speech is ready. Return to capygen and click Check again.' -ForegroundColor Green
} finally {
    # This unique child is the only recursive cleanup target; never remove Destination.
    $resolvedStaging = [IO.Path]::GetFullPath($stagingPath)
    if (-not $resolvedStaging.StartsWith($destinationPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unsafe cleanup path.' }
    if (Test-Path -LiteralPath $resolvedStaging) { Remove-Item -LiteralPath $resolvedStaging -Recurse -Force }
}
