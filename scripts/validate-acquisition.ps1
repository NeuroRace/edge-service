$ErrorActionPreference = "Stop"

python -m unittest discover -s "$PSScriptRoot\..\tests" -p "test_*.py"
