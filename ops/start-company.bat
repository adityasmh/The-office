@echo off
rem ops\start-company.bat - thin wrapper around ops\start-company.ps1
rem One command to bring up Laya + the router/dashboard + mission control.
rem
rem   start-company.bat                 -> launch, open the dashboard
rem   start-company.bat -Quiet -NoBrowser
rem   start-company.bat -NoWatch
rem
rem All arguments are forwarded verbatim to the PowerShell script.
rem Stop everything with:  ops\stop-company.bat  (or stop-company.ps1 -IncludeLaya)

setlocal
set "PS1=%~dp0start-company.ps1"
if not exist "%PS1%" (
  echo [start-company] missing %PS1%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [start-company] exit code %RC% - see the service windows for details.
  echo [start-company] troubleshooting: docs\CEO_RUNBOOK.md
  pause
)
exit /b %RC%
