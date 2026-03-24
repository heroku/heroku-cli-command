$ErrorActionPreference = 'Continue'

$vaultTypeLoad = '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]'

Write-Host "=== powershell -> $((Get-Command powershell).Source) ==="

Write-Host '=== PasswordVault in this PowerShell session ==='
try {
  Invoke-Expression $vaultTypeLoad
  Write-Host 'OK: type loaded'
} catch {
  Write-Host "FAILED: $($_.Exception.Message)"
}

Write-Host '=== Child powershell -Command (same pattern as each execSync) ==='
& powershell -NoProfile -NonInteractive -Command $vaultTypeLoad
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: child exited with code $LASTEXITCODE"
} else {
  Write-Host 'OK: child loaded PasswordVault type'
}

$saveCommand =
      '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = New-Object Windows.Security.Credentials.PasswordCredential("heroku-cli-test", "test@example.com", "fake-token")
      $vault.Add($credential)'

Write-Host '=== Save credential ==='
& powershell -NoProfile -NonInteractive -Command $saveCommand
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: child exited with code $LASTEXITCODE"
} else {
  Write-Host 'OK: credential saved'
}

$getCommand =
      '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = $vault.Retrieve("heroku-cli-test", "test@example.com")
      $credential.Password'

Write-Host '=== Get credential ==='
& powershell -NoProfile -NonInteractive -Command $getCommand
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: child exited with code $LASTEXITCODE"
} else {
  Write-Host 'OK: credential retrieved'
}

$removeCommand =
      '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = $vault.Retrieve("heroku-cli-test", "test@example.com")
      $vault.Remove($credential)'

Write-Host '=== Remove credential ==='
& powershell -NoProfile -NonInteractive -Command $removeCommand
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: child exited with code $LASTEXITCODE"
} else {
  Write-Host 'OK: credential removed'
}