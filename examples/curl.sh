#!/usr/bin/env bash
# Generate an image and save it to fox.png.
# Prereq: chatgpt-bridge serve  (running on :10531)
# Requires: curl, jq, base64

set -euo pipefail

curl -sS http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a small red fox under an oak tree, watercolor",
    "size": "1024x1024",
    "quality": "high"
  }' \
  | jq -r '.data[0].b64_json' \
  | base64 --decode > fox.png

echo "saved fox.png"
