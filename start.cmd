@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install from https://nodejs.org/ and rerun this script.
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example. Edit it to set your API key before use.
)
echo Starting VibeOS demo...
node src/server.js
