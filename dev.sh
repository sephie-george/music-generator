#!/bin/bash
# Auto-restart dev server if it crashes
while true; do
  echo "[$(date)] Starting Next.js dev server on port 3001..."
  npx next dev -p 3001
  EXIT_CODE=$?
  echo "[$(date)] Server exited with code $EXIT_CODE. Restarting in 2s..."
  sleep 2
done
