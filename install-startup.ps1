# Start OTTObot when this user logs on (the user, 2026-09-24: "does the director startup
# when I restart my laptop?" - it did not).
#
# It registers ONE scheduled task that runs director-keep.js, the supervisor. That spawns
# the Director and relaunches it whenever it stops, and the Director's own keep-on watchdog
# then brings up a console for every account marked "keep on" - so the whole fleet comes
# back from a reboot without 21 logins going out at once.
#
#   powershell -ExecutionPolicy Bypass -File install-startup.ps1            install it
#   powershell -ExecutionPolicy Bypass -File install-startup.ps1 -Remove    take it away
#
# No admin rights needed: it is a logon task for this user only.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'OTTObot Director'
$Dir      = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node     = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "removed the scheduled task '$TaskName' - OTTObot will no longer start at logon"
  } else { "there is no scheduled task called '$TaskName'" }
  return
}

if (-not (Test-Path $Node)) { throw "node.exe not found at $Node" }
if (-not (Test-Path (Join-Path $Dir 'director-keep.js'))) { throw "director-keep.js is not in $Dir" }

$action = New-ScheduledTaskAction -Execute $Node -Argument 'director-keep.js' -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 2026-09-25: REPEAT every 10 minutes, for ever, as well as at logon. The supervisor
# itself died silently at some point after 06:38 that morning while the Director it had
# spawned kept running; when the Director then died at ~12:11 nothing relaunched it and
# the fleet sat idle for half an hour. A logon-only trigger cannot recover from that.
# director-keep.js holds a single-instance pid lock, so a repeat firing while a healthy
# supervisor is up just exits immediately - the repetition is free insurance.
$rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)).Repetition
$rep.Duration = ''            # empty = indefinitely; TimeSpan::MaxValue is rejected by the task XML
$trigger.Repetition = $rep
# A laptop lives on battery and sleeps: none of that may stop the fleet. And if the
# supervisor itself ever dies, Windows puts it back.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description 'Starts director-keep.js, which keeps the OTTObot Director up and lets it bring the account consoles back.' | Out-Null

"installed '$TaskName'"
"  runs    : $Node director-keep.js"
"  in      : $Dir"
"  when    : every time $env:USERNAME logs on (and it is retried if it fails)"
"  stop it : the Turn off button on the Director page, or -Remove to take the task away"
