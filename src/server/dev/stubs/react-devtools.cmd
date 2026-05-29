@echo off
rem No-op stub. `ks start` unconditionally spawns `react-devtools`; when the
rem standalone devtools binary isn't installed, the resulting ENOENT becomes an
rem unhandled 'error' event that crashes the whole dev server. We prepend this
rem stub dir to the spawned PATH so the spawn resolves and exits cleanly.
exit /b 0
