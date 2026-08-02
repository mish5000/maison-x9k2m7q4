import { describe, expect, it } from 'vitest';

import {
  buildAiff,
  buildFixtures,
  buildMp3,
  buildWav,
  detectAudioSignature,
  detectNonAudio,
  detectPlaylistFormat,
  extensionFromPath,
  filterResolvableEntries,
  parsePlaylist,
  probeMedia,
} from '../src/index.js';

function fixture(name: string): Uint8Array {
  const found = buildFixtures().find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown fixture ${name}`);
  return found.bytes;
}

describe('signature detection', () => {
  it('identifies each supported container from its magic bytes', () => {
    expect(detectAudioSignature(buildWav(440, 1, 2))?.format).toBe('wav');
    expect(detectAudioSignature(buildAiff(440, 1, 2))?.format).toBe('aiff');
    expect(
      detectAudioSignature(buildMp3({ seconds: 1, bitrateKbps: 128, channels: 2, withId3: true }))
        ?.signature,
    ).toBe('id3v2+mpeg-frame');
    expect(
      detectAudioSignature(buildMp3({ seconds: 1, bitrateKbps: 128, channels: 2, withId3: false }))
        ?.signature,
    ).toBe('mpeg-frame');
  });

  it('refuses to treat a web page as audio, whatever it is called', () => {
    const html = fixture('not-really-audio.mp3');
    const nonAudio = detectNonAudio(html);
    expect(nonAudio?.kind).toBe('html');
    expect(detectAudioSignature(html)).toBeNull();
  });

  it('recognises executables and archives renamed as audio', () => {
    expect(detectNonAudio(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))?.kind).toBe('executable');
    expect(detectNonAudio(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))?.kind).toBe('executable');
    expect(detectNonAudio(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))?.kind).toBe('archive');
    expect(detectNonAudio(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))?.kind).toBe('archive');
  });

  it('extracts extensions from paths, ignoring queries and fragments', () => {
    expect(extensionFromPath('/audio/track.mp3')).toBe('mp3');
    expect(extensionFromPath('/audio/track.MP3?token=abc')).toBe('mp3');
    expect(extensionFromPath('/audio/track')).toBeNull();
    expect(extensionFromPath('/audio/.hidden')).toBeNull();
  });
});

describe('WAV probing', () => {
  it('reads exact duration, sample rate, channels and bit depth from the header', () => {
    const bytes = buildWav(440, 3, 2);
    const result = probeMedia({
      head: bytes,
      totalSizeBytes: bytes.length,
      declaredMimeType: 'audio/wav',
      filenameOrPath: '/audio/tone.wav',
    });

    expect(result.status).toBe('verified_audio');
    expect(result.technical.format).toBe('wav');
    expect(result.technical.codec).toBe('pcm_s16le');
    expect(result.technical.sampleRateHz).toBe(44100);
    expect(result.technical.channels).toBe(2);
    expect(result.technical.bitDepth).toBe(16);
    expect(result.technical.lossless).toBe(true);
    expect(result.technical.durationSeconds).toBeCloseTo(3, 2);
    expect(result.technical.durationEstimated).toBe(false);
    expect(result.technical.bitrate.mode).toBe('lossless');
    expect(result.technical.bitrate.averageBps).toBe(44100 * 2 * 2 * 8);
    expect(result.signatureAgreement).toBe(true);
  });

  it('reports a truncated file as damaged rather than verified', () => {
    const bytes = fixture('truncated-tone.wav');
    const result = probeMedia({
      head: bytes,
      totalSizeBytes: bytes.length,
      filenameOrPath: '/a.wav',
    });
    expect(result.technical.corruptionSignals).toContain('wav:fmt-chunk-truncated');
    expect(result.technical.corruptionSignals).toContain('wav:data-chunk-not-found');
    expect(result.status).toBe('probable_audio');
  });

  it('flags a data chunk larger than the file', () => {
    const bytes = buildWav(440, 2, 2);
    const result = probeMedia({
      head: bytes,
      // A source that under-reports its own length is a classic spoofing signal.
      totalSizeBytes: 1000,
      filenameOrPath: '/a.wav',
    });
    expect(result.technical.corruptionSignals).toContain('wav:data-chunk-larger-than-file');
  });

  it('notes disagreement between the declared type and the bytes', () => {
    const bytes = buildWav(440, 1, 2);
    const result = probeMedia({
      head: bytes,
      totalSizeBytes: bytes.length,
      declaredMimeType: 'audio/mpeg',
      filenameOrPath: '/a.mp3',
    });
    expect(result.technical.format).toBe('wav');
    expect(result.signatureAgreement).toBe(false);
    expect(result.evidence).toContain('mismatch:extension-vs-signature');
    expect(result.evidence).toContain('mismatch:declared-mime-vs-signature');
  });
});

describe('AIFF probing', () => {
  it('decodes the 80-bit sample rate and exact frame count', () => {
    const bytes = buildAiff(550, 2, 2);
    const result = probeMedia({
      head: bytes,
      totalSizeBytes: bytes.length,
      declaredMimeType: 'audio/aiff',
      filenameOrPath: '/tone.aiff',
    });

    expect(result.technical.format).toBe('aiff');
    expect(result.technical.sampleRateHz).toBe(44100);
    expect(result.technical.bitDepth).toBe(16);
    expect(result.technical.channels).toBe(2);
    expect(result.technical.durationSeconds).toBeCloseTo(2, 3);
    expect(result.technical.lossless).toBe(true);
    expect(result.technical.corruptionSignals).toEqual([]);
  });
});

describe('MP3 probing', () => {
  it('reads frame headers rather than trusting the filename', () => {
    const bytes = buildMp3({
      seconds: 4,
      bitrateKbps: 192,
      channels: 1,
      withId3: true,
      title: 'Fixture tone B',
      artist: 'Auralis fixtures',
    });
    const result = probeMedia({
      head: bytes,
      tail: bytes.subarray(Math.max(0, bytes.length - 4096)),
      totalSizeBytes: bytes.length,
      declaredMimeType: 'audio/mpeg',
      filenameOrPath: '/tone.mp3',
    });

    expect(result.technical.format).toBe('mp3');
    expect(result.technical.codec).toBe('mp3');
    expect(result.technical.sampleRateHz).toBe(44100);
    expect(result.technical.channels).toBe(1);
    expect(result.technical.lossless).toBe(false);
    expect(result.technical.bitrate.nominalBps).toBe(192_000);
    expect(result.technical.bitrate.mode).toBe('cbr');
    expect(result.technical.durationSeconds).toBeCloseTo(4, 0);
    expect(result.evidence).toContain('mp3:mpeg1-layer3');
  });

  it('reads ID3v2 tags', () => {
    const bytes = buildMp3({
      seconds: 2,
      bitrateKbps: 320,
      channels: 2,
      withId3: true,
      title: 'A Title',
      artist: 'An Artist',
    });
    const result = probeMedia({
      head: bytes,
      totalSizeBytes: bytes.length,
      filenameOrPath: '/a.mp3',
    });
    expect(result.tags.title).toBe('A Title');
    expect(result.tags.artist).toBe('An Artist');
    expect(result.tags.album).toBe('Auralis test fixtures');
    expect(result.technical.encoder).toBe('Auralis fixture generator');
  });

  it('reads the ID3v1 trailer from the tail sample', () => {
    const bytes = buildMp3({
      seconds: 1,
      bitrateKbps: 128,
      channels: 2,
      withId3: true,
      title: 'Trailer Title',
      artist: 'Trailer Artist',
    });
    const result = probeMedia({
      head: bytes.subarray(0, 2048),
      tail: bytes.subarray(bytes.length - 256),
      totalSizeBytes: bytes.length,
      filenameOrPath: '/a.mp3',
    });
    // The head sample here is too small to contain the ID3v2 frames, so the
    // trailer is what supplies the tags — which is exactly the point.
    expect(result.tags.title).toBe('Trailer Title');
  });

  it('does not claim high confidence from a single frame header', () => {
    const result = probeMedia({
      head: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]),
      totalSizeBytes: null,
      filenameOrPath: '/a.mp3',
    });
    // The header genuinely declares 128 kbps, so the value is reported — but a
    // six-byte sample is not evidence enough to call the reading reliable.
    expect(result.technical.bitrate.nominalBps).toBe(128_000);
    expect(result.technical.bitrate.confidence).toBe('low');
    expect(result.technical.confidence).not.toBe('high');
  });
});

describe('probe edge cases', () => {
  it('reports an empty response as a failed verification', () => {
    const result = probeMedia({ head: new Uint8Array(0), filenameOrPath: '/a.mp3' });
    expect(result.status).toBe('verification_failed');
    expect(result.evidence).toContain('probe:no-bytes-returned');
  });

  it('reports unrecognised bytes as unverified rather than guessing', () => {
    const result = probeMedia({
      head: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      filenameOrPath: '/a.mp3',
    });
    expect(result.status).toBe('unverified');
    expect(result.technical.format).toBe('unknown');
  });

  it('classifies an HTML decoy as not audio', () => {
    const result = probeMedia({
      head: fixture('not-really-audio.mp3'),
      declaredMimeType: 'audio/mpeg',
      filenameOrPath: '/not-really-audio.mp3',
    });
    expect(result.status).toBe('not_audio');
    expect(result.nonAudio?.kind).toBe('html');
  });
});

describe('playlists', () => {
  it('detects and parses M3U without treating it as audio', () => {
    const text = new TextDecoder().decode(fixture('collection.m3u'));
    const format = detectPlaylistFormat(text, 'm3u');
    expect(format).toBe('m3u');

    const parsed = parsePlaylist(text, 'm3u', 'https://example.com/audio/');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.uri).toBe('https://example.com/audio/tone-a-440hz-stereo.wav');
    expect(parsed.entries[0]?.title).toBe('Fixture tone A');
    expect(parsed.entries[0]?.durationSeconds).toBe(3);
  });

  it('parses PLS entries in index order', () => {
    const pls = `[playlist]
File2=https://example.com/b.mp3
Title2=Second
File1=https://example.com/a.mp3
Title1=First
Length1=120
NumberOfEntries=2`;
    const parsed = parsePlaylist(pls, 'pls', null);
    expect(parsed.entries.map((entry) => entry.title)).toEqual(['First', 'Second']);
    expect(parsed.entries[0]?.durationSeconds).toBe(120);
  });

  it('drops entries that point back at an already-visited playlist', () => {
    const entries = [
      { uri: 'https://example.com/a.m3u', title: null, durationSeconds: null },
      { uri: 'https://example.com/b.mp3', title: null, durationSeconds: null },
      { uri: 'https://example.com/b.mp3', title: null, durationSeconds: null },
    ];
    const filtered = filterResolvableEntries(entries, new Set(['https://example.com/a.m3u']));
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.warnings).toContain('playlist:circular-reference-skipped');
  });

  it('caps the number of entries taken from one playlist', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 500; i += 1) lines.push(`https://example.com/track-${i}.mp3`);
    const parsed = parsePlaylist(lines.join('\n'), 'm3u', null);
    expect(parsed.entries.length).toBeLessThanOrEqual(100);
    expect(parsed.truncated).toBe(true);
  });
});
