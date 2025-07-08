#!/bin/bash

if [ -z "$1" ]; then
  echo "Please provide a command name (login or logout)"
  exit 1
fi

COMMAND=$1
shift

if [ ! -f "examples/$COMMAND.ts" ]; then
  echo "Command '$COMMAND' not found in examples directory"
  exit 1
fi

NODE_NO_WARNINGS=1 NODE_OPTIONS="--loader ts-node/esm" ./node_modules/.bin/ts-node --esm "examples/$COMMAND.ts" "$@" 
