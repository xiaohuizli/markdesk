#!/bin/zsh
set -e
cd -- "${0:A:h}"
if [[ ! -d node_modules/@vscode/ripgrep ]]; then
  npm ci --no-audit --no-fund
fi
npm start
