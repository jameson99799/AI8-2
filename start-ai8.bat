@echo off
setlocal

powershell -ExecutionPolicy Bypass -File "%~dp0AI8\start-ai8.ps1"
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
    echo.
    echo AI8 launcher exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
