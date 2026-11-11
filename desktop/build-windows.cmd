@echo off
rem ============================================================
rem  BUILD THE WINDOWS INSTALLER + PORTABLE EXE
rem
rem  Output lands in  desktop\dist\
rem    TankLegends-Setup.exe     normal installer
rem    TankLegends-Portable.exe  single exe, no installation
rem
rem  The first build downloads build tooling once (a few
rem  minutes). Later builds are much faster.
rem ============================================================
setlocal
set "NODE=C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline\node-v22\node-v22.18.0-win-x64"
set "PATH=%NODE%;%PATH%"
set "TMP=%~dp0..\.build-cache\tmp"
set "TEMP=%TMP%"
set "npm_config_cache=%~dp0..\.build-cache\npm"
set "ELECTRON_BUILDER_CACHE=%~dp0..\.build-cache\eb"

if not exist "%TMP%" mkdir "%TMP%" >nul 2>&1
cd /d "%~dp0"
call "%NODE%\npm.cmd" run dist:win
echo.
echo Done. Installers are in desktop\dist\
pause
