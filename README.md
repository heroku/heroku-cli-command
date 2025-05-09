Heroku CLI Command
===================

Base class for Heroku CLI commands. Built off of [oclif](https://oclif.io).

[![Version](https://img.shields.io/npm/v/@heroku-cli/command.svg)](https://npmjs.org/package/@heroku-cli/command)
![GitHub Actions CI](https://github.com/heroku/heroku-cli-command/actions/workflows/ci.yml/badge.svg)
[![Known Vulnerabilities](https://snyk.io/test/npm/@heroku-cli/command/badge.svg)](https://snyk.io/test/npm/@heroku-cli/command)
[![Downloads/week](https://img.shields.io/npm/dw/@heroku-cli/command.svg)](https://npmjs.org/package/@heroku-cli/command)
[![License](https://img.shields.io/npm/l/@heroku-cli/command.svg)](https://github.com/heroku/heroku-cli-command/blob/master/package.json)

## Overview

This package provides the core functionality for Heroku CLI commands, including a comprehensive set of completion handlers for various Heroku resources. It serves as the foundation for building Heroku CLI commands with built-in support for command-line completion.

## Features

### Completion Handlers

The package includes completion handlers for various Heroku resources:

- **Apps**: Autocomplete for Heroku application names
- **Addons**: Autocomplete for add-ons associated with specific apps
- **Dynos**: Autocomplete for dyno names within apps
- **Buildpacks**: Common Heroku buildpack options
- **Dyno Sizes**: Available dyno size options
- **Files**: Local file system completion
- **Pipelines**: Heroku pipeline names
- **Process Types**: Process types from Procfile
- **Regions**: Available Heroku regions
- **Git Remotes**: Git remote names
- **Roles**: User role options (admin, collaborator, member, owner)
- **Scopes**: Permission scope options
- **Spaces**: Heroku Private Spaces
- **Stacks**: Available Heroku stacks
- **Stages**: Pipeline stage options
- **Teams**: Heroku team names

### APIClient

The package includes a built-in `APIClient` for making authenticated requests to the Heroku Platform API:

- Handles authentication and request formatting
- Provides a simple interface for making GET requests to Heroku resources
- Automatically parses JSON responses
- Used internally by completion handlers to fetch resource lists
- Supports configurable request options through the CLI config

Example usage:
```typescript
const heroku = new APIClient(config)
const {body: resources} = await heroku.get('/apps')
```

## Usage

This package is primarily used as a dependency in other Heroku CLI plugins and commands. It provides the base functionality needed to implement Heroku CLI commands with proper completion support.

## Development

Built with TypeScript and uses the [oclif](https://oclif.io) framework for CLI command development.
