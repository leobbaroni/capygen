# Interactive, separately authenticated test identity. No credential copying.
$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nativeCli = Join-Path $repoPath 'node_modules\.pnpm\@anthropic-ai+claude-agent-sdk-win32-x64@0.3.261\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
if (-not (Test-Path -LiteralPath $nativeCli -PathType Leaf)) { throw 'The pinned Claude CLI is not installed. No download was attempted.' }
$identityRoot = 'C:\capygen-test-identities'
$claudeDirectory = Join-Path $identityRoot 'claude'
$codexDirectory = Join-Path $identityRoot 'codex'
$profileDirectory = Join-Path $identityRoot 'home'
$workspaceDirectory = Join-Path $identityRoot 'workspace'
$command = "& '" + $nativeCli.Replace("'", "''") + "' auth login --claudeai"
Add-Type -AssemblyName PresentationFramework
$detail = "Sign in separately for the capygen benchmark. You may use your existing Claude account.`n`nCLAUDE_CONFIG_DIR=$claudeDirectory`nHOME / USERPROFILE=$profileDirectory`nWorking directory=$workspaceDirectory`n`nExact command:`n$command`n`nYour personal Claude/Codex configuration and credentials are not used. Continue?"
if ([System.Windows.MessageBox]::Show($detail, 'capygen benchmark sign-in', 'YesNo', 'Question', 'No') -ne 'Yes') { return }
foreach ($directory in @($claudeDirectory, $codexDirectory, $profileDirectory, $workspaceDirectory, (Join-Path $profileDirectory 'AppData\Roaming'), (Join-Path $profileDirectory 'AppData\Local'))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
foreach ($entry in @(Get-ChildItem Env:)) {
    if ($entry.Name -match '^(ANTHROPIC_|OPENAI_|OPENROUTER_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDECODE$|CODEX_THREAD_ID$)') { Remove-Item -LiteralPath ('Env:' + $entry.Name) }
}
$env:CLAUDE_CONFIG_DIR = $claudeDirectory
$env:CODEX_HOME = $codexDirectory
$env:HOME = $profileDirectory
$env:USERPROFILE = $profileDirectory
$env:APPDATA = Join-Path $profileDirectory 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $profileDirectory 'AppData\Local'
Set-Location -LiteralPath $workspaceDirectory
Write-Host 'capygen is running this command in its dedicated test identity:' -ForegroundColor Cyan
Write-Host $command
& $nativeCli auth login --claudeai
if ($LASTEXITCODE -ne 0) { throw 'Sign-in did not complete.' }
Write-Host 'Sign-in finished. Tell Codex that the benchmark login is ready.' -ForegroundColor Green
