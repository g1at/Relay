@echo off
setlocal
chcp 65001 >nul
set "RELAY_DIAG_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PROCESSOR_ARCHITEW6432 set "RELAY_DIAG_PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%RELAY_DIAG_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Collect-RelayOrbLog.ps1"
set "RELAY_DIAG_EXIT=%ERRORLEVEL%"
echo.
if not "%RELAY_DIAG_EXIT%"=="0" echo Collector exited with an error. Keep the logs and report the error above.
pause
exit /b %RELAY_DIAG_EXIT%
