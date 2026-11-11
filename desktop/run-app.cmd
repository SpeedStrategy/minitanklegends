@echo off
rem ============================================================
rem  RUN TANK LEGENDS FROM SOURCE (no installer needed)
rem
rem  This starts the desktop app in dev mode. It loads the live
rem  game from https://tanklg.pages.dev/ exactly like the
rem  installed app does. For an installer, build one first:
rem    desktop\build-windows.cmd
rem ============================================================
setlocal
set "HERE=%~dp0"
set "NODE=%~dp0..\MiniTankLegendsCline\node-v22\node-v22.18.0-win-x64"

if not exist "%NODE%\node.exe" (
  echo ERROR: bundled Node not found at:
  echo    %NODE%
  pause
  exit /b 1
)

cd /d "%HERE%"
"%NODE%\node.exe" node_modules\electron\cli.js .
if errorlevel 1 (
  echo.
  echo The app exited with an error - see the text above.
  pause
)
