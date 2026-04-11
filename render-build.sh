#!/usr/bin/env bash
# Render build script — installs Chromium dependencies for Puppeteer
set -e

# Install system dependencies for Chromium
apt-get update -qq && apt-get install -y -qq \
  libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
  libgtk-3-0 libasound2 libxshmfence1 libxdamage1 \
  fonts-liberation fonts-noto-color-emoji \
  --no-install-recommends 2>/dev/null || true

# Install Node dependencies
npm ci --production

echo "✓ Build complete — Puppeteer + Chromium deps installed"
