# ADR 0003 — In-house media parsers instead of ffprobe

## Status

Accepted — 2026-08-02

## Context

The product promise is the second half of the tagline: _verify the file_. A link
ending in `.mp3` is a claim; a `Content-Type: audio/mpeg` header is a claim. The
bytes are evidence. Auralis has to answer, for every candidate, what container
and codec are really there, at what sample rate, bit depth, channel count and
bitrate, how long it is, and how confident it is in each of those numbers.

Four constraints shaped the choice:

- **Bounded bytes.** Identifying a file must never require downloading it.
  `orchestrate/verify.ts` allows one HEAD plus at most two range requests:
  `HEAD_SAMPLE_BYTES = 64 KiB` and `TAIL_SAMPLE_BYTES = 32 KiB`.
- **Bounded time.** `perVerificationMs` is 4 s in quick mode.
- **Hostile input.** Every byte comes from an untrusted remote source. The thing
  that parses it is an attack surface by definition.
- **Clean clone.** Same requirement as ADR 0002 — the pipeline must work
  end to end with `npm install && npm run build && npm run dev`.

## Decision

Write the parsers in-house, in TypeScript, pure and synchronous.

`media/signatures.ts` does magic-byte detection — `detectNonAudio` first
(MZ, ELF, Mach-O, ZIP, gzip, PDF, PNG, JPEG, and an ASCII sniff for HTML and
XML), then `detectAudioSignature`. `media/probe.ts` `probeMedia(input)` takes
`{ head, tail?, totalSizeBytes?, declaredMimeType?, filenameOrPath? }` and
returns `{ signature, nonAudio, technical, tags, status, evidence,
signatureAgreement }`. The per-container work lives in `media/parsers/`:

| Parser    | Covers                                                                    |
| --------- | ------------------------------------------------------------------------- |
| `mp3.ts`  | MPEG frame headers, Xing/Info headers, VBR detection, frame scanning      |
| `id3.ts`  | ID3v2 (head) and ID3v1 (tail), including ReplayGain frames                |
| `flac.ts` | STREAMINFO, Vorbis comments, audio MD5 presence                           |
| `riff.ts` | WAVE `fmt`/`data` chunks and AIFF/AIFC `COMM` chunks                      |
| `mp4.ts`  | MP4/M4A box tree, including `moov` recovery from the tail sample          |
| `ogg.ts`  | Ogg pages, Vorbis/Opus/FLAC-in-Ogg identification, final-granule duration |

**Formats covered:** MP3, WAV, AIFF (and AIFC), FLAC, M4A/ALAC, AAC (ADTS),
Ogg Vorbis and Opus. That is the whole list — `AUDIO_FORMATS` in
`domain/media.ts` plus `unknown`.

Design rules that fall out of the decision:

- **Pure and synchronous.** No I/O, no `async`, no globals. The docblock says
  why: _"Everything here is pure and synchronous so it can run inside an
  isolated worker."_
- **Claims are compared, never trusted.** The probe records
  `mismatch:extension-vs-signature`, `mismatch:declared-mime-vs-signature`,
  `agreement:extension-matches-signature` and `agreement:mime-matches-signature`,
  and only sets `signatureAgreement` when every comparable claim agrees.
- **Confidence is first class.** `MediaTechnicalMetadata.confidence` and
  `BitrateInfo.confidence` are `high | medium | low | none`, and
  `BitrateInfo.estimated` marks a bitrate derived from size ÷ duration rather
  than read from the stream. An MP3 bitrate from a single frame header is `low`
  until four frames agree.
- **Uncertainty is reported, not guessed.** `probeMedia` returns
  `status: 'unverified'` with `signature:none-recognised` rather than assuming.
- **The same code verifies local files.** `app.ts` `verifyWithoutUrl` reads
  bounded samples from disk with `readLocalSample` and calls the same
  `probeMedia`, so the evidence strings from the network path and the disk path
  are directly comparable.

## Consequences

### Positive

- A clean clone works. Nothing to install, nothing to detect at startup, no
  "ffprobe not found" branch anywhere in the code.
- No process spawning, therefore no process sandbox to design, no argument
  escaping to get right, no zombie reaping, no CPU/memory cgroup, and no path to
  arbitrary execution from a crafted file.
- The probe needs only a byte sample, which is what makes the "never download a
  whole file to identify one" rule achievable. ffprobe over a URL would fetch on
  its own terms; ffprobe over a temp file would need the whole file on disk first.
- Purity makes it trivially testable — `core/src/testing/media-fixtures.ts`
  generates real files and `core/tests/media-probe.test.ts` asserts on them with
  no network and no subprocess.
- Evidence strings (`mp3:duration-from-frame-count`,
  `flac:audio-md5-present`, `mp4:moov-recovered-from-tail`) are ours to design,
  so the "Why this result?" panel and the verification record can explain
  themselves. ffprobe's JSON would have to be translated into that vocabulary.
- The parsers surface structural problems as `corruptionSignals`, which flow
  into quality scoring and into compatibility verdicts rather than being
  discarded.

### Negative

- **They read containers; they do not decode audio.** There is no PCM output, no
  real loudness measurement (`LoudnessInfo` is populated from ReplayGain tags
  when present, not measured), no spectral analysis, no way to detect a file
  that is transcoded-up from a low-bitrate source, and no acoustic fingerprint.
  The strongest content key Auralis computes is
  `sha256(headSample[0..4096])` — a _partial signature_, not an audio
  fingerprint, and it changes if a mirror re-tags the file at the front.
- **The format list is the format list.** Anything outside MP3, WAV, AIFF,
  FLAC, M4A/ALAC, AAC, Ogg Vorbis and Opus returns `format: 'unknown'` and
  `status: 'unverified'`, and therefore is never downloadable. WavPack, Musepack,
  APE, WMA, AMR, DSD, Matroska/WebM audio and MP3 inside a video container all
  need new parser code. Adding one is a real piece of work, not configuration.
- **We own the bugs.** Two are already visible as deliberate workarounds in the
  code: MP4 files with `moov` at the end need it located in the tail sample and
  re-walked from its box header (concatenating buffers would leave every offset
  wrong), and a WAVE `data` chunk that declares a size larger than the file has
  to be clamped and flagged. Every format has more of these.
- **Bounded samples mean bounded answers.** Exact Ogg duration needs the final
  granule position, so it needs the tail — and the tail probe is skipped in quick
  mode (`fetchTail: mode !== 'quick'`) and skipped whenever the server does not
  honour ranges. In those cases duration is `null` or estimated, and the
  confidence field says so.
- **Maintenance is ongoing and unglamorous.** Container formats keep acquiring
  edge cases; ffmpeg has absorbed twenty years of them.

## Alternatives considered

| Alternative                                         | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ffprobe`**                                       | The obvious answer, and the one that would cover every format. Rejected on three counts, all structural rather than aesthetic. (1) **It is an external binary**, so it has to be installed on every machine that runs Auralis — every developer laptop, every CI runner, every container image — which breaks the clean-clone requirement outright. (2) **It would need process sandboxing.** Feeding attacker-controlled bytes to a large C codebase and spawning it as a subprocess means designing a real sandbox: resource limits, a restricted filesystem view, argument-injection defences, timeouts and reaping. That sandbox is more code, and more security-critical code, than the parsers it replaces. (3) **It does not fit the byte budget.** The pipeline is built on a HEAD plus two bounded range requests; ffprobe either fetches the URL on its own terms or needs a local file, and neither is compatible with "never download a whole file to identify one". |
| **`music-metadata` (npm)**                          | Pure JavaScript and broad-coverage, so points (1) and (2) above do not apply. Rejected on control rather than capability: it returns a metadata object, not an evidence trail, so `signatureAgreement`, per-field confidence, `corruptionSignals` and the `evidence[]` strings the UI explains itself with would all have to be reconstructed around it. It is also a large third-party dependency in the one place the product's core claim lives, and `@auralis/core` otherwise has exactly one runtime dependency. Reasonable to revisit if the format list needs to grow substantially.                                                                                                                                                                                                                                                                                                                                                                                      |
| **WebAssembly ffmpeg**                              | Removes the external-binary problem, but pulls a multi-megabyte artifact into the build, still decodes far more than is needed, and does not fix the byte-budget mismatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Trusting `Content-Type` and the file extension**  | This is the failure mode the product exists to fix. A web page served as `audio/mpeg` would be offered as a download.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Server-side transcoding to normalise everything** | Enormous cost per candidate, requires the whole file, and answers a different question — "what would this sound like after we re-encoded it" rather than "what is this".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
