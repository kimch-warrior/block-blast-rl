@echo off
cd /d "%~dp0"
docker compose up --build -d
if errorlevel 1 exit /b 1
echo Game: http://127.0.0.1:5173
echo Containers: http://block-blast:3000 on network block-blast-local
