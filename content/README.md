# Scene/story demo contract 1.0

Authoring references: [能力索引](CAPABILITIES.md), [Scene capabilities](SCENE_CAPABILITIES.md), and
[Story capabilities](STORY_CAPABILITIES.md). Each authoring Skill owns its respective content files;
the tables distinguish editable content from engine-provided behavior.

This is the project's exploratory MVP contract, informed by (not compatible with)
[evan-ak's v2 reference](../docs/references/world-format-v2.md).

## Files and loading

`public/content/remaining-time/manifest.json` selects the 26-room browser package and S01
investigation. `content/scenes`, `content/story.json`, and `content/fixtures/route/` are regression
fixtures. Start a new timeline after editing browser content; refresh resumes the existing saved
content. Tavern content, dining, performances and teaching live only on `experiment/tavern-agentic`.
`loadContent` validates the entire package before the runtime accepts it. Unsupported keys,
versions, references and operations are errors. This demo supports schema_version `1.0`;
content_version identifies the authored revision. Changes to established field semantics require a
new contract version.

## Scene

A scene declares a unique id, name, rectangular map dimensions, floor/wall tile IDs from the
existing gentle tileset, interior anchors and entities. Coordinates are integer tile coordinates.
Optional `map.collision` explicitly marks open/blocked cells; without it, boundary walls and
occupied entity tiles block walking. Optional `map.art` places bundled PNGs at pixel coordinates
with depth sorting; it is separate from collision. Entities have package-unique IDs, a display name,
existing character sprite ID, and position. Optional portal specifies a destination scene and
anchor. Portals use the `door` visual, drawn as a simple door marker. Walking into its tile
automatically checks the owning story entry and performs travel; E is for dialogue entities and
fixed seats. Each portal requires exactly one choice containing travel, with an optional condition.

Map geometry and portal destinations belong to scenes. Story defines the conditions and effects of
interacting with them. All arrival anchors must be walkable and free of entities. Returning uses an
explicit return anchor, not an inferred previous tile.

## Story

Boolean variables are global to the run. `interactions` is keyed directly by the scene entity ID
(for example `n07` or `room.exit`). Each entry keeps that entity's text, choices, conditions and
consequences together. An entity without an entry is inert in this demo. Story references to
nonexistent entities are load errors. A choice has id, text, optional `{var, equals}` condition and
an ordered effects list:

- `set`: write a declared boolean variable.
- `pay_time`: deduct nonnegative integer seconds from the runtime's one life balance; negative
  balances are allowed, unsafe integer arithmetic is rejected.
- `travel`: follow the interacting entity's portal. At most one per choice.

Dialogue choices are explicit confirmations; completing a choice ends the interaction. Portal
choices execute on contact rather than opening dialogue. A locked portal rejects the movement and
shows its story text. Arrival anchors are outside portal tiles, and held movement input is cleared
on travel to prevent immediate bounce-back. An unconditional UI exit remains available even when all
choices are hidden. Execution rechecks the condition and interaction revision. Stale choices fail;
request IDs deduplicate retries. Effects apply to a draft and commit together. Successful travel
retains balance, variables, simulation/story clocks and tutorial, changes scene/player position and
clears movement and interaction context. Frontend clears held movement input on travel. Scene data
is preloaded, so unknown references fail before play rather than midway through a transition.

## Goods and shops

Optional story `items` defines the immutable item catalog; `shops[entityId]` binds offers and
initial stock to an existing interactive non-portal entity. Split stories merge items and shops with
duplicate/reference validation. See the [Story capability table](STORY_CAPABILITIES.md) for full
JSON examples, numeric bounds and authoring steps.

Buy/sell commands recheck the active interaction, reach and revision, and derive prices from
content. Life balance, player inventory and merchant stock commit together. Purchases cannot
overdraw; selling returns items to stock. Quantities are 1–99 per command and at most 9999 per
item/stock entry. `State.commerce` holds mutable quantities only when items are configured,
preserving older recordings' state shape. The 1-key panel shows inventory; commerce state and
deduplication are retained by recording/replay/checkpoints. Optional shop
`restock: {intervalSeconds:86400}` tops stock up every 24 hours of game story time, retaining
surplus. `advanceStoryTime` commands advance that clock and replenish due shops atomically; no
wall-clock timer or automatic passage of time is required. Saved next-restock timestamps retain
phase across jumps and replay. Consumption, equipment and inventory task facts are not implemented.

## Fixed seats

Scene entities may declare `seat: {orientation,depth,playerSprite}` for built-in player sit/stand
interaction. Their interior tile may be furniture-blocked; ordinary walking remains blocked. The
player shares only this designated seat tile, reserving their original approach tile against NPC
movement and portal arrivals until standing. Seats are immovable sprite entities without portals,
story interactions or shops. Optional State.seated holds the seat ID and return position; commands
and pose restore through recording/replay. See [Scene capabilities](SCENE_CAPABILITIES.md) for the
full JSON, pixel coordinates, exporter recipe and checks.

Scene NPCs may declare seatedOn with a same-scene chair ID and matching position; one fixed sprite
guest may share each chair tile. Their optional state field retains this binding. Matching
seat.table labels reserve all chairs at the table against player sitting, including empty chairs.
Guests can have dialogue but cannot move or leave their initial seat. See
[Scene capabilities](SCENE_CAPABILITIES.md) for details.

## Deliberate limits

The live package covers room traversal and the S01 investigation; route fixtures test permission
dialogue and two-way travel. Static PNG layers and grid collision are supported; continuous
colliders, autonomous NPCs, furniture carrying and a minimap remain future work. The shared renderer
handles the player; memory recording supports JSON import/export, replay and continuation. OPFS
automatic saves retain room progress; retired tavern saves are not loaded or migrated.

## Tasks

Optional `story.tasks` declares task id, title, description and ordered steps. Each step has id,
text and a condition declaring an `event`, optional equality `where` filters, a positive target
`count`, and optional `collect` field. Without collect, matching facts increment a counter; with
collect, distinct field values count. Optional `items: [{value,label}]` restricts the collection to
an explicit set and supplies UI checklist labels, such as the four directions.

Registered facts and fields:

- `movement.completed`: direction (`up`, `down`, `left`, `right`).
- `interaction.started`: entityId.
- `choice.confirmed`: entityId, choiceId.
- `scene.entered`: sceneId (successful travel; initial load is not a travel fact).

Unknown events/fields and invalid entity/scene references are rejected. Only the active step
consumes successful facts. Earlier actions are not credited retroactively; cancellation, rejection
and deduplicated retries do not count. Progress and collected values persist across scenes and reset
with the run. The task board displays content labels and per-step counts/collected items, including
which directions remain. This MVP supports equality filters and counting/distinct collection;
arbitrary expressions and composite conditions are not part of the current contract.
