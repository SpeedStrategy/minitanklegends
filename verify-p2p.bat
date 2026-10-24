@echo off
cd /d "C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline"
echo === run apply_p2p.js on committed base ===
node.exe apply_p2p.js
echo apply_p2p exit=%errorlevel%
echo.
echo === syntax check on result ===
node.exe --check js/game.js
echo node-check exit=%errorlevel%
echo.
echo === verify P2P symbols landed ===
echo size: %~z1js/game.js
grep -c "sendInputP2P" js/game.js
grep -c "broadcastP2P" js/game.js
grep -c "_p2pHostOptIn" js/game.js
grep -c "onP2PId" js/game.js
grep -c "SessionGuard" js/game.js
grep -c "handbrake = this.input.pressed" js/game.js
grep -c "Net.p2p.enabled && Net.p2p.hostId" js/game.js
grep -c "Net.sendInputP2P(input)" js/game.js
grep -c "Net.sendInput(input)" js/game.js
grep -c "NakamaNet.sendMatchData({t: 'input', input})" js/game.js
grep -c "P2PEnableCheck" js/game.js
echo.
echo === confirm no leftover console gunk from this run ===
grep -c "id='dev-console'" js/game.js
grep -c "_consoleExec(cmd)" js/game.js
