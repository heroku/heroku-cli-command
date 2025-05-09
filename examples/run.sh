#!/bin/bash

if [ -z "$1" ]; then
  echo "Please provide a command name (login or logout)"
  exit 1
fi

if [ ! -f "examples/$1.ts" ]; then
  echo "Command '$1' not found in examples directory"
  exit 1
fi

./node_modules/.bin/ts-node "examples/$1.ts" 
