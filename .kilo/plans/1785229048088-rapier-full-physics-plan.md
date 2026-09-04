# Rapier Full Physics Integration Plan

## Current State
- **Rapier 0.12.0 is already installed** via dynamic CDN import (`js/game.js:5269`)
- Tanks already have Rapier rigid bodies (`js/tank.js:91-117`), but with severely constrained motion:
  - `setEnabledRotations(false, true, false)` → only Y-axis spin (heading)
  - `setEnabledTranslations(true, false, true)` → X/Z movement only; **no Y translation**
  - Linear damping `0.5`, angular damping `2.0`
- Physics world exists (`js/game.js:399-425`) with ground at `y=-0.5` (160×160) and map walls at ±223 on a 450×450 map
- Camera tracks only `x`/`z` + fixed `baseY` — ignores any vertical/rotational physics
- Network snapshots sync only `{x, z, heading, speed, hp, alive, dying}` — no Y, no roll/pitch

## Goal
Enable full 6-DOF physics so tanks:
1. Fall with gravity when driving off edges / ramps
2. Flip / pitch / roll when reversing hard or colliding
3. Interact realistically with shell impacts and terrain

## Key Design Decision Needed

**Should full physics (Y translation + roll + pitch) be enabled in P2P multiplayer, or only single-player / free-roam?**

- **P2P currently snapshots only x/z/heading.** Enabling full physics on the host would desync clients because they never receive Y, roll, or pitch state, and their camera / rendering assumes `baseY`.
- **Recommended approach:** 
  - **Single-player + free-roam:** Enable full physics immediately.
  - **P2P host/client:** Keep current constrained physics for now, but lay the groundwork (extend snapshots, read Y from Rapier) so it can be toggled later without re-architecting.

## Implementation Steps (for single-player / free-roam first)

### 1. Extend the ground collider
- Currently ground is `160×0.5×160` at `y=-0.5`, but map walls go to ±223.
- Expand ground to `450×0.5×450` (or match `WORLD_SIZE`) so tanks have a continuous surface across the full playable area.
- Add a **kill plane** at `y=-15` (or lower) that instantly kills tanks that fall off the world. Detect by checking `translation().y` each frame.

### 2. Update tank rigid body descriptor
- In `js/tank.js:_createPhysBody()`:
  - Change `setEnabledRotations(false, true, false)` → `setEnabledRotations(true, true, true)` (allow pitch + roll)
  - Change `setEnabledTranslations(true, false, true)` → `setEnabledTranslations(true, true, true)` (allow Y fall)
  - Tune mass/inertia:
    - Keep `setMass(this.mass)` but also set moment of inertia if Rapier exposes it, or let Rapier compute from the cuboid shape.
    - Increase linear damping slightly (e.g., `0.6`) so tanks don't slide forever on flat ground.
    - Keep angular damping around `2.0` to prevent endless spinning.
- Add a config constant for `PHYSICS_GRAVITY_SCALE` if the world gravity needs tweaking.

### 3. Make rendering and camera follow the physics body
- In `js/tank.js:_syncTransform()`:
  - Read `p.y` from the rigid body and store it as `this.y` (or reuse `baseY` concept as a spawn height, not a lock).
  - Set `this.root.position.set(this.x, p.y, this.z)` so the 3D mesh follows the simulated height.
  - Read the full rotation quaternion and decompose into `heading` (yaw) + optional `pitch`/`roll` if you want visual lean; otherwise just use yaw for the hull and let pitch/roll affect the visual via `bodyGroup.rotation.x/z`.
- In `js/game.js` camera code:
  - Replace fixed `tBaseY + 1.2` look-at with the tank’s actual physics `y` (read from `_physBody.translation().y` or cache on the tank).
  - Clamp camera minimum height so it never clips underground.

### 4. Shell impacts impart physical force
- In `js/game.js:_onShellHitTank()`:
  - After `takeDamage()`, apply an impulse to the hit tank’s rigid body: `setLinvel` or `addForce` in the shell’s direction scaled by shell speed/mass.
  - This makes heavy shells push tanks backward / knock them over.

### 5. Falling / death handling
- In `js/tank.js:update()` (or `game.js:_update()` loop), check each alive tank:
  - If `_physBody.translation().y < -10` (below kill plane), call `takeDamage(this.maxHp, null, game)` or `_startDeath()`.
- In `tank.js:respawn()`:
  - Reset the rigid body: `setTranslation({x: sp.x, y: sp.y || 1.2, z: sp.z})`, zero linear/angular velocity, re-enable if disabled.
  - Reset `this.y` / `this.baseY` to spawn height.

### 6. P2P groundwork (optional, deferred)
- Extend `snapshot()` in `tank.js` to include `y`, `roll`, `pitch` (or the raw quaternion).
- Extend `applySnapshot()` to teleport the physics body to the received state for remote tanks.
- **Do not enable in P2P until this sync path is verified.**

## Performance / Optimization Considerations
- Rapier is already step-limited to `0.033s` per frame in `game.js:2875`.
- One dynamic body per tank + shells + casings = small count; no broadphase optimizations needed yet.
- Reading `translation()` and `rotation()` per tank per frame is cheap (C++ side).
- Avoid creating/destroying colliders during gameplay; reuse on respawn by resetting position/velocity.

## Validation
1. **Single-player:** Drive a tank off the map edge → it should fall with gravity, flip if moving fast, and die/respawn when below kill plane.
2. **Hard reverse at speed:** Tank should pitch nose-up or roll slightly instead of stopping instantly.
3. **Shell hit:** A direct shell impact should visibly push the tank and possibly knock it sideways.
4. **Normal driving:** Tanks should still drive smoothly on flat ground without unintended flipping.
5. **Performance:** Monitor FPS with `P` overlay while driving near many other tanks; target stays above 50 FPS on mid-range hardware.

## Risks
- **P2P desync:** Enabling full physics in host mode without snapshot extensions will cause clients to see tanks floating or at wrong heights. **Mitigation:** Ship only for single-player first.
- **Camera nausea:** Following a rolling tank may make the camera swing wildly. **Mitigation:** Smooth camera Y with lerp, or keep camera roll locked while only following Y height.
- **Map edge gaps:** Expanding the ground collider is necessary; otherwise tanks fall between the old ground and walls.
