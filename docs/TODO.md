# Mini Tank Legends - Bug Fixes

## Progress

### Bug 1: Fullscreen/Landscape detection (menu.js)
- [x] Fixed corrupted `_detectPlatform()`, `_isFullscreen()`, `_initFullscreen()` in menu.js
- [x] Removed duplicate `_showSection` function

### Bug 2: Mobile joystick throttle inverted (input.js)
- [x] Fixed `const throttle = move.y` → `const throttle = -move.y` in input.js (inverted joystick up = forward)

### Deployment
- [ ] Deploy to Cloudflare Pages
