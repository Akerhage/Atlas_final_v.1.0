@echo off
setlocal EnableDelayedExpansion

REM Force UTF-8 FÖRE någon output
chcp 65001 > nul

echo.
echo ===================================================
echo ATLAS START-RENSARE (UTF-8 + PORT 3000 FIX)
echo ===================================================
echo.

rem ==== 1️⃣ Döda process som blockar port 3000 ====
echo Söker efter process som blockerar port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
set "PID=%%a"
)

if defined PID (
echo Port 3000 blockeras av Process ID: !PID!. Avslutar...
taskkill /F /PID !PID! >nul 2>&1
timeout /t 2 /nobreak > nul
) else (
echo Port 3000 är redan ledig.
)
echo.

rem ==== 2️⃣ Ställ in UTF-8 för konsol och miljö ====
echo Ställer in miljön på UTF-8...

REM Sätt miljövariabler för Node.js
set "LANG=sv_SE.UTF-8"
set "LC_ALL=sv_SE.UTF-8"
set "NODE_NO_WARNINGS=1"

echo Miljö för UTF-8 har ställts in.
echo.

rem ==== 3️⃣ Starta Electron-processen korrekt ====
echo Startar Atlas-server (Electron + Node.js)...
echo.

REM Starta Electron med UTF-8 miljö
REM /k har bytts ut mot /c för att stänga CMD-fönstret automatiskt när Electron avslutas.
start "Atlas App" /min cmd /c "chcp 65001 > nul && node .\\node_modules\\electron\\cli.js ."

echo.
echo ===================================================
echo ✅ Atlas startad (UTF-8 aktiv, port 3000 fri)
echo ===================================================
echo.
exit