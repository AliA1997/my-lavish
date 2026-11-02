# see-plan installer for Windows.
#   irm https://github.com/AliA1997/my-lavish/releases/latest/download/install.ps1 | iex
# Downloads the latest release, checks it against SHA256SUMS, installs to ~\.see-plan\bin,
# and adds that folder to your user PATH. To also install the Claude Code skill, either run the
# script with -InstallSkill, or set $env:SEE_PLAN_INSTALL_SKILL = "1" before the one-liner.
param(
  [switch]$InstallSkill,
  [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "https://github.com/AliA1997/my-lavish/releases"
$base = if ($Version -eq "latest") { "$repo/latest/download" } else { "$repo/download/$Version" }
$asset = "see-plan-win-x64.zip"
$installDir = Join-Path $HOME ".see-plan\bin"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("see-plan-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Write-Host "Downloading $asset ..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")

  $line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS has no entry for $asset" }
  $expected = ($line -split "\s+")[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if ($expected -ne $actual) { throw "Checksum mismatch for ${asset}: expected $expected, got $actual" }
  Write-Host "Checksum OK."

  $unpacked = Join-Path $tmp "unpacked"
  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $unpacked -Force
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Get-Process -Name "see-plan" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$installDir*" } | Stop-Process -Force
  foreach ($f in @("see-plan.exe", "LICENSE", "NOTICE", "THIRD_PARTY_LICENSES.txt", "README.md")) {
    Copy-Item -Force (Join-Path $unpacked $f) $installDir
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($userPath -split ";" | Where-Object { $_ })
  if ($parts -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $installDir) -join ";"), "User")
    Write-Host "Added $installDir to your user PATH (open a new terminal to use it)."
  }
  $env:Path = "$installDir;$env:Path"

  if ($InstallSkill -or $env:SEE_PLAN_INSTALL_SKILL -eq "1") {
    $skillDir = Join-Path $HOME ".claude\skills\my-lavish"
    New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
    Copy-Item -Force (Join-Path $unpacked "skills\my-lavish\*") $skillDir
    Write-Host "Installed the Claude Code skill to $skillDir."
  } else {
    Write-Host "Skill not installed. Re-run with -InstallSkill (or SEE_PLAN_INSTALL_SKILL=1) to add it to ~/.claude/skills."
  }

  $v = & (Join-Path $installDir "see-plan.exe") --version
  Write-Host "see-plan $v installed to $installDir."
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
