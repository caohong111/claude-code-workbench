[CmdletBinding()]
param(
  [string]$InstallDir,
  [string]$DataDir,
  [switch]$NoLaunch,
  [switch]$SkipShortcuts
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This source installer currently supports Windows only.' }

$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$targetRoot = $sourceRoot
if ($InstallDir) { $targetRoot = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)).TrimEnd('\') }
if ($targetRoot -eq [IO.Path]::GetPathRoot($targetRoot).TrimEnd('\')) { throw 'Choose an application folder, not a drive root.' }

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$nodeCommand -or !$npmCommand) { throw 'Install Node.js LTS (22.12.0 or newer) from https://nodejs.org/ and reopen PowerShell, then run this installer again.' }
$nodeVersion = & $nodeCommand.Source --version
if ($LASTEXITCODE -ne 0 -or ([version]$nodeVersion.TrimStart('v')) -lt [version]'22.12.0') { throw 'Node.js 22.12.0 or newer is required. Install the current LTS from https://nodejs.org/.' }

$gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
$gitBashCandidates = @($env:CLAUDE_CODE_GIT_BASH_PATH)
if ($gitCommand) { $gitBashCandidates += Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($gitCommand.Source))) 'bin\bash.exe' }
foreach ($key in @('HKCU:\Software\GitForWindows', 'HKLM:\Software\GitForWindows', 'HKLM:\Software\WOW6432Node\GitForWindows')) {
  $installation = Get-ItemProperty -LiteralPath $key -Name InstallPath -ErrorAction SilentlyContinue
  if ($installation.InstallPath) { $gitBashCandidates += Join-Path $installation.InstallPath 'bin\bash.exe' }
}
if ($env:ProgramFiles) { $gitBashCandidates += Join-Path $env:ProgramFiles 'Git\bin\bash.exe' }
$gitBash = $gitBashCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (!$gitBash) { Write-Warning 'Git Bash was not found. The workbench and compatible Responses channels can still run. Claude Code shell features require Git for Windows: https://git-scm.com/downloads/win, or CLAUDE_CODE_GIT_BASH_PATH pointing to bash.exe.' }

if (![string]::Equals($sourceRoot, $targetRoot, [StringComparison]::OrdinalIgnoreCase)) {
  if ($targetRoot.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'InstallDir must be outside the downloaded source folder.' }
  if (Test-Path -LiteralPath $targetRoot) {
    if (@(Get-ChildItem -LiteralPath $targetRoot -Force).Count) { throw 'InstallDir must be empty. Existing files are not overwritten.' }
  } else { New-Item -ItemType Directory -Path $targetRoot | Out-Null }
  $rootFiles = @('package.json', 'package-lock.json', 'themes.json', 'index.html', 'vite.config.js', 'README.md', 'CONTRIBUTING.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'AGENTS.md', '.gitignore', '.gitleaks.toml', '.npmrc', 'install.ps1', 'launch.vbs')
  foreach ($name in $rootFiles) {
    $file = Join-Path $sourceRoot $name
    if (Test-Path -LiteralPath $file -PathType Leaf) { Copy-Item -LiteralPath $file -Destination (Join-Path $targetRoot $name) }
  }
  $sourceDirectories = @('.github', 'assets', 'docs', 'electron', 'shared', 'src', 'tools', 'tests')
  $excluded = '(^|[\\/])(?:node_modules|dist|data|local-data|output|qa|temp|cache|runtime|\.tmp|\.git)(?:[\\/]|$)|(^|[\\/])\.env(?:\.|$)|(?:credentials|auth|workspaces)\.json$'
  foreach ($name in $sourceDirectories) {
    $directory = Join-Path $sourceRoot $name
    if (!(Test-Path -LiteralPath $directory -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse) {
      $relative = $file.FullName.Substring($sourceRoot.Length + 1)
      if ($relative -match $excluded) { continue }
      if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Source links cannot be copied: $relative" }
      $destination = Join-Path $targetRoot $relative
      New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
  }
}

if (!$DataDir) { $DataDir = Join-Path $targetRoot 'local-data' }
$workbenchHome = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir))
if ($workbenchHome.Contains('"') -or $workbenchHome.Contains("`r") -or $workbenchHome.Contains("`n")) { throw 'DataDir contains unsupported characters.' }
if ([string]::Equals($workbenchHome.TrimEnd('\', '/'), [IO.Path]::GetPathRoot($workbenchHome).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { throw 'DataDir must be a dedicated application data folder, not a drive or share root.' }
if ([string]::Equals($workbenchHome.TrimEnd('\', '/'), $targetRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'DataDir must be a separate data folder, not the source folder itself.' }
if ((Test-Path -LiteralPath $workbenchHome) -and !(Test-Path -LiteralPath $workbenchHome -PathType Container)) { throw 'DataDir points to a file. Choose a dedicated application data folder.' }
foreach ($directory in @($workbenchHome, (Join-Path $workbenchHome 'temp'), (Join-Path $workbenchHome 'cache\npm'), (Join-Path $workbenchHome 'cache\electron'))) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$previousNpmCache = $env:npm_config_cache
$previousElectronCache = $env:ELECTRON_CACHE
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
  $env:npm_config_cache = Join-Path $workbenchHome 'cache\npm'
  $env:ELECTRON_CACHE = Join-Path $workbenchHome 'cache\electron'
  $env:TEMP = Join-Path $workbenchHome 'temp'
  $env:TMP = $env:TEMP
  Push-Location -LiteralPath $targetRoot
  try {
    & $npmCommand.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check the network error above, then rerun the installer.' }
    & $npmCommand.Source run runtime:install
    if ($LASTEXITCODE -ne 0) { throw 'The Electron runtime could not be installed. No shortcut was created.' }
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw 'The application build failed. No shortcut was created.' }
  } finally { Pop-Location }
} finally {
  $env:npm_config_cache = $previousNpmCache
  $env:ELECTRON_CACHE = $previousElectronCache
  $env:TEMP = $previousTemp
  $env:TMP = $previousTmp
}

$launcher = Join-Path $targetRoot 'launch.vbs'
$windowsScriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (!$SkipShortcuts) {
  $shortcutShell = New-Object -ComObject WScript.Shell
  $shortcutDirectories = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
  foreach ($directory in $shortcutDirectories) {
    $shortcutPath = Join-Path $directory 'Claude Code Workbench (Source).lnk'
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.Description -ne 'Claude Code Workbench (source)') {
      Write-Warning "An unrelated shortcut was preserved: $shortcutPath"
      continue
    }
    $shortcut.TargetPath = $windowsScriptHost
    $shortcut.Arguments = '//nologo "' + $launcher + '" "' + $workbenchHome + '"'
    if ($gitBash) { $shortcut.Arguments += ' "' + $gitBash + '"' }
    $shortcut.WorkingDirectory = $targetRoot
    $shortcut.Description = 'Claude Code Workbench (source)'
    $iconPath = Join-Path $targetRoot 'assets\app-icon.ico'
    if (Test-Path -LiteralPath $iconPath) { $shortcut.IconLocation = $iconPath + ',0' }
    $shortcut.Save()
  }
}

Write-Host "Installed source: $targetRoot"
Write-Host "Local application data: $workbenchHome"
Write-Host 'Your Claude credentials and existing CC Switch settings were not modified.'
if (!$NoLaunch) {
  $launchArguments = @('//nologo', ('"' + $launcher + '"'), ('"' + $workbenchHome + '"'))
  if ($gitBash) { $launchArguments += ('"' + $gitBash + '"') }
  Start-Process -FilePath $windowsScriptHost -ArgumentList $launchArguments -WindowStyle Hidden
}
