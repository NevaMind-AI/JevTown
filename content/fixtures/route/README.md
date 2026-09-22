# Route regression fixture

Fixed split content for dialogue, task sequencing, NPC movement, portal travel and recording
regression tests. Loaded by tests/engine/package.test.ts, movement.test.ts and the split
world-format experiment.

Browser content is selected separately by public/content/remaining-time/manifest.json. Changes to
the playable story must not silently replace this fixture's behavioral coverage.
