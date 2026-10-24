@echo off
cd /d "%~dp0"
echo === Cloudflare Pages deploy: cf-dist ===
echo === Need CLOUDFLARE_API_TOKEN env var (get from Cloudflare Dashboard → Profile → API Tokens) ===
echo === Or use Cloudflare Dashboard: Pages → Deploy Folder → select cf-dist → Deploy ===
pause
"node-v22\node-v22.18.0-win-x64\node.exe" node_modules\.bin\wrangler.cmd pages deploy cf-dist --project-name=mini-tank-legends
echo deploy exit=%errorlevel%
pause
