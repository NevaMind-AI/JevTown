# List available commands.
default:
    @just --list

# Install the exact dependency versions from package-lock.json.
install:
    npm ci

# Run the connected room world, starting in unit 404.
dev:
    npm run play:local

# Run existing tests.
test:
    npm test

# Type-check and build the frontend.
build:
    npm run build

# Stage 1 acceptance: automated checks, then an interactive local session.
accept-prototype:
    npm run test:prototype
    npm run prototype

# Start the local playable UI without a backend.
play-local:
    npm run play:local

# Phase 2 checks followed by the playable UI.
accept-local:
    npm run test:prototype
    npm run play:local

# Start only the interactive in-memory prototype.
prototype:
    npm run prototype

# Format the working tree, including existing files.
fmt:
    npm run fmt

# Check all supported, non-ignored files in the working tree.
fmt-check:
    npm run fmt:check

# Format staged files and restage results, preserving unstaged changes.
fmt-staged:
    npm run fmt:staged

# Enable this repository's pre-commit hook.
hooks-install:
    npm run prepare
