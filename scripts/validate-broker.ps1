$ErrorActionPreference = "Stop"

Push-Location "$PSScriptRoot\..\data_broker"
try {
  npm.cmd run validate
}
finally {
  Pop-Location
}
