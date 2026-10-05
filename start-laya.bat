@echo off
rem One-click Laya server for the router (project venv, GPU by default). Keep this window open.
rem Full deps install first: deps\setup.ps1
rem CPU only (pre-GPU behaviour):  set LAYA_DEVICE=cpu
rem VRAM budget override:          set LAYA_GPU_MEM_FRACTION=0.5
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve-laya.ps1"
