# Restart ONLY the SalsaDevKit electron instance.
# NEVER kill by process name 'electron' — that also kills SalsaSpotlight's dev build!
$procs = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { $_.CommandLine -like '*SalsaDevKit*' }
if ($procs) {
  foreach ($p in $procs) { Write-Host ("killing PID " + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force }
  Start-Sleep -Milliseconds 900
} else {
  Write-Host 'no running SalsaDevKit instance'
}
