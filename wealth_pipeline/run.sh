#!/bin/bash
# Start the wealth pipeline scheduler
cd "$(dirname "$0")"
source .venv/bin/activate
python scheduler.py
