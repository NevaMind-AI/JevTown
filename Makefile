.PHONY: help install dev test build accept-prototype play-local accept-local prototype fmt fmt-check fmt-staged hooks-install

help:
	@echo "Targets: install dev test build accept-prototype play-local accept-local prototype fmt fmt-check fmt-staged hooks-install"

install:
	npm ci

dev:
	npm run play:local

test:
	npm test

build:
	npm run build

accept-prototype:
	npm run test:prototype
	npm run prototype

play-local:
	npm run play:local

accept-local:
	npm run test:prototype
	npm run play:local

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

hooks-install:
	npm run prepare
