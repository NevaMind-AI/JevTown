# World format design references

## evan-ak · World Description Format v2

- [Specification v2 — original text](world-format-v2.md)
- Source: evan-ak's design, supplied verbatim by the project owner in the planning conversation.
- Scope: the specification from its title through §14.3, preserved without editorial changes. The
  surrounding conversation is not part of the specification.
- The referenced `01-world-format-spec.md`, `02-design-rationale.md`, and
  `03-implementation-plan.md` were not supplied alongside this snapshot. Their contents must not be
  inferred from their filenames or references.

## How to use this reference

Read this specification before changing the world.json loader, sample worlds, or runtime contract.
It is a design reference, not a claim that the current engine implements the complete format.

Format v2 is a reference, not a mandatory contract. Start from the smallest playable scenario:
identify what it needs, what existing code can supply, and which proposed features are extra. Reuse,
simplify, or depart from v2 where that produces a smaller working solution; full compatibility and
migration are not acceptance requirements.

Document the chosen MVP contract, deferred features, and relevant differences beside the
implementation and in its PR. A difference from v2 is not itself a defect. Cross-world/map loading
syntax is an exploratory extension: label it explicitly and validate it with a minimal example,
rather than attributing invented fields to this reference.

Keep this snapshot unchanged; add a separately identified reference when a revised design is
supplied. In particular, map-exported entities, rendering/collision configuration boundaries,
execution ordering, and recording guarantees need explicit decisions wherever the MVP differs from
the source.
