# Seed maps

JSON files in this folder seed the shared IVR map when the server boots (only for numbers the map doesn't know yet). This is how the top-50 phone trees get mapped before the first user calls them.

## Mapping a tree

1. Make a call to it (simulated, or real on Twilio) with the rules or Claude brain. The server learns every screen it gets through: `.voiced/maps.json`.
2. Export it: `npm run map:export -- <phone digits>` writes `maps/<business>.json`.
3. Review the file and commit it.

## Format

One file per business: `{ "<phone digits>": IvrMap }` (see `src/core/memory.ts`).

- `screens[].prints`: fingerprints of the prompt sentences, in order (amounts, digits and months masked, so they match across callers)
- `screens[].bargeAt`: the sentence index where the IVR starts accepting input; replays fire there
- `screens[].plays[<task kind>]`: the action that worked (`press` digits or `say` text, with `{{fact}}` placeholders, never literal secrets) plus success/failure counts
- `screens[].next[<task kind>]`: the screen that followed, which gives the edges of the tree

A replay that fails (invalid option, or looping back) is counted, and a play with more failures than successes is dropped and relearned.
