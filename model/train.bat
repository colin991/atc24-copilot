@echo off
rem Trains the ATC model on this PC (NVIDIA card with 8 GB+ recommended).
rem   train.bat          full run
rem   train.bat quick    continue from the last model
cd /d "%~dp0\.."
if not exist model\data mkdir model\data
echo Making training calls...
node model\synth.mjs 8000 7 > model\data\synth.jsonl || goto :fail
node model\prepare.mjs model\data\synth.jsonl model\data\real.jsonl > model\data\train.jsonl || goto :fail
if /i "%1"=="quick" (
  python model\train.py --quick || goto :fail
) else (
  python model\train.py || goto :fail
)
python model\convert.py || goto :fail
echo.
echo Done. The model is in model\out. Upload it as a release asset named atc-model.gguf.
exit /b 0
:fail
echo Something failed, see above.
exit /b 1
