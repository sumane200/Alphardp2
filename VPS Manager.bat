```bat
@echo off
setlocal EnableExtensions EnableDelayedExpansion
title GitHub VPS Manager

REM ============================================================
REM GitHub VPS Manager
REM
REM vps_data.txt format:
REM VPS_NAME,GITHUB_TOKEN,CODESPACE_NAME,RDP_USER,RDP_PASS,RDP_HOST
REM ============================================================

set "DATA_FILE=%~dp0vps_data.txt"
set "NGROK_JSON=%TEMP%\github_vps_ngrok.json"
set "NGROK_HOST=%TEMP%\github_vps_host.txt"

if not exist "%DATA_FILE%" (
    type nul > "%DATA_FILE%"
)


REM ============================================================
REM MAIN MENU
REM ============================================================

:MAIN_MENU
cls
echo.
echo ============================================================
echo                 GITHUB VPS MANAGER
echo ============================================================
echo.
echo   1. Add a New VPS
echo   2. Manage Saved VPS
echo   3. Remove a VPS
echo   4. Exit
echo.
echo ============================================================
echo.

choice /c 1234 /n /m "Select an option: "

if errorlevel 4 goto EXIT
if errorlevel 3 goto REMOVE_VPS
if errorlevel 2 goto MANAGE_VPS
if errorlevel 1 goto ADD_VPS

goto MAIN_MENU


REM ============================================================
REM ADD VPS
REM ============================================================

:ADD_VPS
cls
echo.
echo ============================================================
echo                     ADD NEW VPS
echo ============================================================
echo.

set "VPS_NAME="
set "GH_TOKEN="
set "CS_NAME="
set "RDP_USER="
set "RDP_PASS="

set /p "VPS_NAME=VPS nickname: "

if not defined VPS_NAME (
    echo.
    echo VPS nickname cannot be empty.
    echo.
    pause
    goto MAIN_MENU
)

set /p "GH_TOKEN=GitHub Personal Access Token: "

if not defined GH_TOKEN (
    echo.
    echo GitHub token cannot be empty.
    echo.
    pause
    goto MAIN_MENU
)

set /p "CS_NAME=Codespace name: "

if not defined CS_NAME (
    echo.
    echo Codespace name cannot be empty.
    echo.
    pause
    goto MAIN_MENU
)

set /p "RDP_USER=RDP username: "

if not defined RDP_USER (
    echo.
    echo RDP username cannot be empty.
    echo.
    pause
    goto MAIN_MENU
)

set /p "RDP_PASS=RDP password: "

if not defined RDP_PASS (
    echo.
    echo RDP password cannot be empty.
    echo.
    pause
    goto MAIN_MENU
)

echo.
echo Saving VPS...

>>"%DATA_FILE%" echo %VPS_NAME%,%GH_TOKEN%,%CS_NAME%,%RDP_USER%,%RDP_PASS%,-

echo.
echo VPS "%VPS_NAME%" saved successfully.
echo.
pause
goto MAIN_MENU


REM ============================================================
REM MANAGE VPS
REM ============================================================

:MANAGE_VPS
cls
echo.
echo ============================================================
echo                   SAVED VPS LIST
echo ============================================================
echo.

set "COUNT=0"

for /f "usebackq tokens=1 delims=," %%A in ("%DATA_FILE%") do (
    set /a COUNT+=1
    echo   !COUNT!. %%A
)

if "%COUNT%"=="0" (
    echo.
    echo No VPSs are saved.
    echo.
    pause
    goto MAIN_MENU
)

echo.
echo   0. Back to Main Menu
echo.

set "SELECT="
set /p "SELECT=Select VPS: "

if "%SELECT%"=="0" goto MAIN_MENU
if not defined SELECT goto MANAGE_VPS

set "TARGET_VPS="
set "TARGET_TOKEN="
set "TARGET_CS="
set "TARGET_USER="
set "TARGET_PASS="
set "TARGET_HOST="

set "COUNT=0"

for /f "usebackq tokens=1-6 delims=," %%A in ("%DATA_FILE%") do (
    set /a COUNT+=1

    if "!COUNT!"=="%SELECT%" (
        set "TARGET_VPS=%%A"
        set "TARGET_TOKEN=%%B"
        set "TARGET_CS=%%C"
        set "TARGET_USER=%%D"
        set "TARGET_PASS=%%E"
        set "TARGET_HOST=%%F"
    )
)

if not defined TARGET_VPS (
    echo.
    echo Invalid VPS selection.
    echo.
    pause
    goto MANAGE_VPS
)


REM ============================================================
REM VPS ACTION MENU
REM ============================================================

:VPS_ACTION_MENU
cls
echo.
echo ============================================================
echo                  MANAGE: %TARGET_VPS%
echo ============================================================
echo.
echo   Codespace : %TARGET_CS%
echo   RDP User  : %TARGET_USER%
echo   RDP Host  : %TARGET_HOST%
echo.
echo ============================================================
echo.
echo   1. Activate
echo   2. Deactivate
echo   3. Show RDP Logins
echo   4. Back to Main Menu
echo.
echo ============================================================
echo.

choice /c 1234 /n /m "Select an option: "

if errorlevel 4 goto MAIN_MENU
if errorlevel 3 goto SHOW_LOGIN
if errorlevel 2 goto DEACTIVATE_VPS
if errorlevel 1 goto ACTIVATE_VPS

goto VPS_ACTION_MENU


REM ============================================================
REM ACTIVATE VPS
REM ============================================================

:ACTIVATE_VPS
cls
echo.
echo ============================================================
echo                  ACTIVATING %TARGET_VPS%
echo ============================================================
echo.

set "GH_TOKEN=%TARGET_TOKEN%"

if not defined GH_TOKEN (
    echo ERROR: GitHub token is missing.
    echo.
    set "GH_TOKEN="
    pause
    goto VPS_ACTION_MENU
)


REM ============================================================
REM 1. START CODESPACE
REM ============================================================

echo [1/6] Starting Codespace...
echo.

gh cs start -c "%TARGET_CS%" >nul 2>&1

if errorlevel 1 (
    echo Codespace may already be running.
    echo Continuing...
)

echo.
echo Waiting for Codespace SSH...
echo.

set "SSH_OK="

for /l %%I in (1,1,30) do (

    if not defined SSH_OK (

        gh cs ssh -c "%TARGET_CS%" -- "echo CONNECTION_OK" 2>nul | findstr /c:"CONNECTION_OK" >nul

        if not errorlevel 1 (
            set "SSH_OK=1"
        ) else (
            timeout /t 2 /nobreak >nul
        )
    )
)

if not defined SSH_OK (
    echo.
    echo ============================================================
    echo ERROR: Could not connect to the Codespace.
    echo ============================================================
    echo.

    set "GH_TOKEN="
    pause
    goto VPS_ACTION_MENU
)

echo Connection successful.
echo.


REM ============================================================
REM 2. XRDP
REM ============================================================

echo [2/6] Starting xrdp...
echo.

gh cs ssh -c "%TARGET_CS%" -- "sudo service xrdp restart" 2>nul

if errorlevel 1 (
    echo.
    echo ERROR: Could not restart xrdp.
    echo.

    set "GH_TOKEN="
    pause
    goto VPS_ACTION_MENU
)

echo xrdp restarted successfully.
echo.


REM ============================================================
REM 3. VERIFY XRDP
REM ============================================================

echo [3/6] Verifying xrdp...
echo.

gh cs ssh -c "%TARGET_CS%" -- "service xrdp status >/dev/null 2>&1" 2>nul

if errorlevel 1 (
    echo.
    echo ERROR: xrdp verification failed.
    echo.

    set "GH_TOKEN="
    pause
    goto VPS_ACTION_MENU
)

echo xrdp is running.
echo.


REM ============================================================
REM 4. START PINGGY TUNNEL
REM ============================================================

echo [4/5] Starting Pinggy tunnel...
echo.

REM Create a simple script on the Codespace and run it, to avoid any quoting/shell bugs
gh cs ssh -c "%TARGET_CS%" -- "echo 'pkill -f pinggy 2>/dev/null; rm -f /tmp/vps-pinggy.log; setsid ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R0:localhost:3389 tcp@a.pinggy.io >/tmp/vps-pinggy.log 2>&1 </dev/null & sleep 2' > /tmp/start_tunnel.sh" 2>nul
gh cs ssh -c "%TARGET_CS%" -- "bash /tmp/start_tunnel.sh" 2>nul

echo Pinggy tunnel launched.
echo.


REM ============================================================
REM 5. WAIT FOR PINGGY TUNNEL ADDRESS
REM ============================================================

echo [5/5] Waiting for Pinggy tunnel address (please wait)...
echo.

set "RDP_HOST="
set "RDP_URL="

if exist "%NGROK_HOST%" del /q "%NGROK_HOST%" >nul 2>&1

REM Poll the log file using a Windows loop to avoid any cmd.exe parsing bugs
for /l %%I in (1,1,30) do (
    if not defined RDP_HOST (
        if exist "%NGROK_HOST%" del /q "%NGROK_HOST%" >nul 2>&1
        
        REM grep -m 1 gets the first occurrence, avoiding the need for pipes
        gh cs ssh -c "%TARGET_CS%" -- "grep -m 1 -o 'tcp://[^ ]*' /tmp/vps-pinggy.log 2>/dev/null" > "%NGROK_HOST%" 2>nul
        
        if exist "%NGROK_HOST%" (
            set /p "RDP_URL="<"%NGROK_HOST%"
        )
        
        if defined RDP_URL (
            set "RDP_HOST=!RDP_URL:tcp://=!"
        )
        
        if not defined RDP_HOST (
            timeout /t 1 /nobreak >nul
        )
    )
)


REM ============================================================
REM TUNNEL FAILURE
REM ============================================================

if not defined RDP_HOST (

    echo.
    echo ============================================================
    echo ERROR: Could not obtain Pinggy tunnel address.
    echo ============================================================
    echo.
    echo Last lines from Pinggy log:
    echo.

    gh cs ssh -c "%TARGET_CS%" -- "cat /tmp/vps-pinggy.log 2>/dev/null || echo no_log_found"

    echo.
    echo.
    echo The saved RDP host was NOT changed.
    echo.

    set "GH_TOKEN="
    pause
    goto VPS_ACTION_MENU
)


REM ============================================================
REM SUCCESS
REM ============================================================

:TUNNEL_SUCCESS

echo.
echo ============================================================
echo                    VPS ACTIVATED
echo ============================================================
echo.
echo VPS Name : %TARGET_VPS%
echo Codespace: %TARGET_CS%
echo RDP Host : %RDP_HOST%
echo RDP User : %TARGET_USER%
echo RDP Pass : %TARGET_PASS%
echo.
echo ============================================================
echo.

REM Automatically update the last field in vps_data.txt
call :UPDATE_HOST "%TARGET_VPS%" "%RDP_HOST%"

set "TARGET_HOST=%RDP_HOST%"

if exist "%NGROK_JSON%" del /q "%NGROK_JSON%" >nul 2>&1
if exist "%NGROK_HOST%" del /q "%NGROK_HOST%" >nul 2>&1

set "GH_TOKEN="

echo RDP host automatically saved.
echo.

pause
goto VPS_ACTION_MENU


REM ============================================================
REM DEACTIVATE VPS
REM ============================================================

:DEACTIVATE_VPS
cls
echo.
echo ============================================================
echo                 DEACTIVATING %TARGET_VPS%
echo ============================================================
echo.

set "GH_TOKEN=%TARGET_TOKEN%"

if not defined GH_TOKEN (
    echo ERROR: GitHub token is missing.
    echo.
    set "GH_TOKEN="
    pause
    goto VPS_ACTION_MENU
)

echo Stopping Pinggy tunnel...

gh cs ssh -c "%TARGET_CS%" -- "pkill -f 'ssh.*pinggy' 2>/dev/null || true" >nul 2>&1

echo Pinggy tunnel stopped.
echo.

echo Stopping Codespace...

gh cs stop -c "%TARGET_CS%"

if errorlevel 1 (
    echo.
    echo Codespace could not be stopped.
    echo It may already be stopped.
) else (
    echo.
    echo Codespace stopped successfully.
)

set "GH_TOKEN="

echo.
pause
goto VPS_ACTION_MENU


REM ============================================================
REM SHOW RDP LOGIN
REM ============================================================

:SHOW_LOGIN
cls
echo.
echo ============================================================
echo                    RDP LOGIN
echo ============================================================
echo.
echo VPS Name : %TARGET_VPS%
echo.
echo RDP Host : %TARGET_HOST%
echo Username : %TARGET_USER%
echo Password : %TARGET_PASS%
echo.
echo ============================================================
echo.
pause
goto VPS_ACTION_MENU


REM ============================================================
REM REMOVE VPS
REM ============================================================

:REMOVE_VPS
cls
echo.
echo ============================================================
echo                     REMOVE VPS
echo ============================================================
echo.

set "COUNT=0"

for /f "usebackq tokens=1 delims=," %%A in ("%DATA_FILE%") do (
    set /a COUNT+=1
    echo   !COUNT!. %%A
)

if "%COUNT%"=="0" (
    echo.
    echo No VPSs are saved.
    echo.
    pause
    goto MAIN_MENU
)

echo.
echo   0. Back to Main Menu
echo.

set "SELECT="
set /p "SELECT=Select VPS to remove: "

if "%SELECT%"=="0" goto MAIN_MENU

set "REMOVE_VPS_NAME="
set "REMOVE_TOKEN="
set "REMOVE_CS="

set "COUNT=0"

for /f "usebackq tokens=1-3 delims=," %%A in ("%DATA_FILE%") do (
    set /a COUNT+=1

    if "!COUNT!"=="%SELECT%" (
        set "REMOVE_VPS_NAME=%%A"
        set "REMOVE_TOKEN=%%B"
        set "REMOVE_CS=%%C"
    )
)

if not defined REMOVE_VPS_NAME (
    echo.
    echo Invalid selection.
    echo.
    pause
    goto REMOVE_VPS
)

echo.
echo You selected:
echo %REMOVE_VPS_NAME%
echo.

choice /c YN /n /m "Remove this VPS? [Y/N]: "

if errorlevel 2 goto MAIN_MENU

set "GH_TOKEN=%REMOVE_TOKEN%"

echo.
echo Cleaning up VPS...

gh cs ssh -c "%REMOVE_CS%" -- "pkill -f 'ssh.*pinggy' 2>/dev/null || true" >nul 2>&1

gh cs stop -c "%REMOVE_CS%" >nul 2>&1

set "GH_TOKEN="


REM ============================================================
REM REWRITE DATA FILE
REM ============================================================

set "TEMP_FILE=%DATA_FILE%.tmp"

if exist "%TEMP_FILE%" del /q "%TEMP_FILE%" >nul 2>&1

for /f "usebackq delims=" %%L in ("%DATA_FILE%") do (

    set "LINE=%%L"

    for /f "tokens=1 delims=," %%A in ("!LINE!") do (
        set "LINE_NAME=%%A"
    )

    if /i not "!LINE_NAME!"=="%REMOVE_VPS_NAME%" (
        >>"%TEMP_FILE%" echo !LINE!
    )
)

move /y "%TEMP_FILE%" "%DATA_FILE%" >nul

echo.
echo VPS "%REMOVE_VPS_NAME%" removed successfully.
echo.

pause
goto MAIN_MENU


REM ============================================================
REM UPDATE RDP HOST
REM ============================================================

:UPDATE_HOST

set "UPDATE_NAME=%~1"
set "UPDATE_HOST=%~2"

set "TEMP_FILE=%DATA_FILE%.tmp"

if exist "%TEMP_FILE%" del /q "%TEMP_FILE%" >nul 2>&1

for /f "usebackq delims=" %%L in ("%DATA_FILE%") do (

    set "LINE=%%L"

    for /f "tokens=1-6 delims=," %%A in ("!LINE!") do (

        set "LINE_NAME=%%A"
        set "LINE_TOKEN=%%B"
        set "LINE_CS=%%C"
        set "LINE_USER=%%D"
        set "LINE_PASS=%%E"
        set "LINE_HOST=%%F"

        if /i "!LINE_NAME!"=="%UPDATE_NAME%" (
            >>"%TEMP_FILE%" echo !LINE_NAME!,!LINE_TOKEN!,!LINE_CS!,!LINE_USER!,!LINE_PASS!,%UPDATE_HOST%
        ) else (
            >>"%TEMP_FILE%" echo !LINE!
        )
    )
)

move /y "%TEMP_FILE%" "%DATA_FILE%" >nul

exit /b


REM ============================================================
REM EXIT
REM ============================================================

:EXIT
cls
echo.
echo ============================================================
echo              GitHub VPS Manager
echo ============================================================
echo.
echo Manager stopped.
echo.
echo Saved VPS information remains in:
echo %DATA_FILE%
echo.
echo ============================================================
echo.

pause
endlocal
exit /b
```
