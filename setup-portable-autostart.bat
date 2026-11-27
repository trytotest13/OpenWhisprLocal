@echo off
setlocal EnableExtensions

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "EXE_PATH=%APP_DIR%\OpenWhisprLocal.exe"
if not exist "%EXE_PATH%" set "EXE_PATH=%APP_DIR%\OpenWhispr.exe"

if not exist "%EXE_PATH%" (
    echo [ERROR] OpenWhisprLocal.exe not found in "%APP_DIR%".
    echo         Place this script in the same folder as OpenWhisprLocal.exe.
    pause
    exit /b 1
)

if not exist "%APP_DIR%\portable-data" mkdir "%APP_DIR%\portable-data" 2>nul

echo Linking portable OpenWhisprLocal to Windows Startup...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "com.gizmolabs.openwhispr" /t REG_SZ /d "\"%EXE_PATH%\" --hidden" /f >nul
if errorlevel 1 (
    echo [ERROR] Failed to update Windows Startup registry key.
    pause
    exit /b 1
)

echo [OK] Auto-start registered: "%EXE_PATH%" --hidden
echo [OK] Portable data folder: "%APP_DIR%\portable-data"
echo.
echo Starting OpenWhisprLocal...
start "" "%EXE_PATH%"
exit /b 0
