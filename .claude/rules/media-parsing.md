---
description: Rules for code that parses media bytes.
globs: ['auralis/packages/core/src/media/**/*.ts']
---

# Media parsing

Every byte reaching this subsystem is hostile input from an unknown source.

## Non-negotiable

- **Pure and synchronous.** No I/O, no timers, no globals. This is what lets the
  parsers run inside a bounded worker.
- **Bounded loops.** Every `while` has an iteration cap. MP3 frames, FLAC
  metadata blocks, MP4 boxes and depth, ID3 frames, RIFF chunks, Ogg pages, XML
  nodes and depth all have explicit limits.
- **Bounded allocation.** Never allocate from a length field in the file without
  clamping it first. A declared size is a claim.
- **Bounds-checked reads.** Use `ByteReader`; it returns `null` past the end
  rather than reading whatever is there.
- **Never download the whole file.** A head sample and optionally a tail sample
  is enough for every supported format. If you think you need more, you have
  found a design problem.

## Honesty

- Report `null` for anything you did not measure. Never fill in a plausible
  value.
- Mark derived numbers `estimated: true` and set `confidence` accordingly.
- One frame header is a reading, not a measurement. High confidence requires
  several consecutive frames to agree.
- Record what you observed in `corruptionSignals` using a stable
  `format:problem` identifier.
- A signature match is evidence. An extension and a `Content-Type` are claims.
  Report agreement and disagreement separately.

## Strings

Every string extracted from a tag goes through `cleanTagString` before it leaves
the module. Tags are the classic vector for injecting markup into a UI.

## Playlists

A playlist is never a playable result. Detect it, classify it as `playlist`, and
let the orchestrator reject it. Resolution is bounded by depth, entry count and
a visited set.
