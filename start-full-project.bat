@echo off
title CrowdTrust Full Stack Launcher
echo ======================================================================
echo   CrowdTrust Blockchain Framework - Full Stack Launcher
echo ======================================================================
echo.

set ROOT=%~dp0

echo [1/4] Starting local Ethereum Hardhat node on port 8545...
start "CrowdTrust Hardhat Node (Port 8545)" cmd /k "cd /d %ROOT% && npx hardhat node"

echo Waiting for Hardhat node to initialize...
timeout /t 5 /nobreak > nul

echo [2/4] Deploying contracts and seeding sample campaigns...
cd /d "%ROOT%"
call npx hardhat run scripts/deploy.ts --network localhost
call npx hardhat run scripts/seed.ts --network localhost

echo [3/4] Starting backend Express API and Indexer on port 4000...
start "CrowdTrust Backend API (Port 4000)" cmd /k "cd /d %ROOT%backend && npm run dev"

echo Waiting for Backend API to initialize...
timeout /t 3 /nobreak > nul

echo [4/4] Starting frontend dashboard on port 5180...
start "CrowdTrust Dashboard (Port 5180)" cmd /k "cd /d %ROOT%frontend && npm run dev"

echo Opening browser at http://localhost:5180 ...
timeout /t 2 /nobreak > nul
start http://localhost:5180

echo.
echo ======================================================================
echo   CrowdTrust is now running!
echo   - Dashboard: http://localhost:5180
echo   - Backend API: http://localhost:4000
echo   - Hardhat RPC: http://127.0.0.1:8545
echo ======================================================================
pause
