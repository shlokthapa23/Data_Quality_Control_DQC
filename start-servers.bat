@echo off
setlocal

rem %~dp0 = the folder this .bat file lives in, no matter where it's run from
set "ROOT=%~dp0"

if not exist "%ROOT%Backend\.venv\Scripts\python.exe" (
    echo [ERROR] Backend venv not found at "%ROOT%Backend\.venv"
    echo Run setup first:
    echo   cd "%ROOT%Backend"
    echo   python -m venv .venv
    echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
    pause
    exit /b 1
)

if not exist "%ROOT%Frontend\node_modules" (
    echo [ERROR] Frontend node_modules not found. Run setup first:
    echo   cd "%ROOT%Frontend"
    echo   npm install
    pause
    exit /b 1
)

echo Starting Backend  (Flask, http://localhost:5000)...
start "Backend"  cmd /k "cd /d "%ROOT%Backend" && .venv\Scripts\python.exe app.py"

echo Starting Frontend (Vite,  http://localhost:5173)...
start "Frontend" cmd /k "cd /d "%ROOT%Frontend" && npm.cmd run dev"

echo.
echo Both servers are launching in separate windows.
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:5000

endlocal
