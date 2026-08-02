/**
 * Deterministic media fixtures.
 *
 * These are synthesised, not downloaded, so a clean clone can demonstrate and
 * test the whole pipeline without depending on any live website. Every audio
 * fixture is a real, structurally valid file of its format — the point of the
 * exercise is that the verifier is reading genuine container bytes.
 *
 * The adversarial fixtures are equally deliberate: an HTML page named `.mp3`,
 * a truncated file, and a playlist are exactly the inputs a discovery engine
 * has to refuse to call "verified audio".
 */

export interface FixtureFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly description: string;
}

const SAMPLE_RATE = 44100;

/** Generates a sine tone as interleaved 16-bit samples. */
function sineSamples(
  frequencyHz: number,
  seconds: number,
  channels: number,
  sampleRate = SAMPLE_RATE,
): Int16Array {
  const frames = Math.floor(seconds * sampleRate);
  const samples = new Int16Array(frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    // A short fade at each end avoids the click a hard start would produce.
    const fade = Math.min(1, frame / 1000, (frames - frame) / 1000);
    const value = Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate) * 0.4 * fade;
    const encoded = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    for (let channel = 0; channel < channels; channel += 1) {
      samples[frame * channels + channel] = encoded;
    }
  }
  return samples;
}

export function buildWav(
  frequencyHz: number,
  seconds: number,
  channels: number,
  sampleRate = SAMPLE_RATE,
): Uint8Array {
  const samples = sineSamples(frequencyHz, seconds, channels, sampleRate);
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buffer.writeUInt16LE(channels * 2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  }
  return new Uint8Array(buffer);
}

/** Encodes a number as an 80-bit IEEE 754 extended float, as AIFF requires. */
function writeExtendedFloat80(buffer: Buffer, offset: number, value: number): void {
  if (value === 0) {
    buffer.fill(0, offset, offset + 10);
    return;
  }
  const sign = value < 0 ? 0x8000 : 0;
  const absolute = Math.abs(value);
  let exponent = Math.floor(Math.log2(absolute));
  let mantissa = absolute / 2 ** exponent;
  if (mantissa >= 2) {
    mantissa /= 2;
    exponent += 1;
  }
  buffer.writeUInt16BE(sign | (exponent + 16383), offset);
  const scaled = mantissa * 2 ** 63;
  buffer.writeUInt32BE(Math.floor(scaled / 2 ** 32) >>> 0, offset + 2);
  buffer.writeUInt32BE(scaled >>> 0, offset + 6);
}

export function buildAiff(
  frequencyHz: number,
  seconds: number,
  channels: number,
  sampleRate = SAMPLE_RATE,
): Uint8Array {
  const samples = sineSamples(frequencyHz, seconds, channels, sampleRate);
  const frames = samples.length / channels;
  const dataBytes = samples.length * 2;
  const ssndSize = 8 + dataBytes;
  const commSize = 18;
  const formSize = 4 + (8 + commSize) + (8 + ssndSize);

  const buffer = Buffer.alloc(8 + formSize);
  buffer.write('FORM', 0, 'ascii');
  buffer.writeUInt32BE(formSize, 4);
  buffer.write('AIFF', 8, 'ascii');

  buffer.write('COMM', 12, 'ascii');
  buffer.writeUInt32BE(commSize, 16);
  buffer.writeUInt16BE(channels, 20);
  buffer.writeUInt32BE(frames, 22);
  buffer.writeUInt16BE(16, 26);
  writeExtendedFloat80(buffer, 28, sampleRate);

  buffer.write('SSND', 38, 'ascii');
  buffer.writeUInt32BE(ssndSize, 42);
  buffer.writeUInt32BE(0, 46); // offset
  buffer.writeUInt32BE(0, 50); // block size

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16BE(samples[i] ?? 0, 54 + i * 2);
  }
  return new Uint8Array(buffer);
}

const MPEG1_L3_BITRATES: Readonly<Record<number, number>> = {
  128: 0x9,
  192: 0xb,
  256: 0xd,
  320: 0xe,
};

/**
 * Builds a structurally valid MPEG-1 Layer III stream.
 *
 * Frame headers, side information and padding are real; the frame payloads
 * encode digital silence. That is enough for a decoder to play the file and for
 * the verifier to read format, sample rate, channel mode, bitrate and duration
 * from the bytes rather than from the filename.
 */
export function buildMp3(options: {
  readonly seconds: number;
  readonly bitrateKbps: 128 | 192 | 256 | 320;
  readonly channels: 1 | 2;
  readonly withId3: boolean;
  readonly title?: string;
  readonly artist?: string;
}): Uint8Array {
  const sampleRate = SAMPLE_RATE;
  const samplesPerFrame = 1152;
  const frameCount = Math.max(1, Math.round((options.seconds * sampleRate) / samplesPerFrame));
  const bitrateIndex = MPEG1_L3_BITRATES[options.bitrateKbps] ?? 0x9;
  const bitrateBps = options.bitrateKbps * 1000;

  const parts: Buffer[] = [];
  if (options.withId3)
    parts.push(buildId3v2(options.title ?? 'Fixture tone', options.artist ?? 'Auralis fixtures'));

  for (let index = 0; index < frameCount; index += 1) {
    const frameLength = Math.floor((samplesPerFrame / 8) * (bitrateBps / sampleRate));
    const frame = Buffer.alloc(frameLength);
    frame[0] = 0xff;
    // MPEG-1 (11), Layer III (01), no CRC (1)
    frame[1] = 0xfb;
    frame[2] = ((bitrateIndex << 4) | (0x0 << 2)) & 0xff; // 44100 Hz, no padding
    // Channel mode: stereo (00) or mono (11), no emphasis.
    frame[3] = options.channels === 1 ? 0xc0 : 0x00;
    parts.push(frame);
  }

  if (options.withId3)
    parts.push(buildId3v1(options.title ?? 'Fixture tone', options.artist ?? 'Auralis fixtures'));
  return new Uint8Array(Buffer.concat(parts));
}

function buildId3v2(title: string, artist: string): Buffer {
  const frames: Buffer[] = [];
  const addTextFrame = (id: string, value: string): void => {
    const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(value, 'utf8')]);
    const header = Buffer.alloc(10);
    header.write(id, 0, 'ascii');
    // ID3v2.4 sizes are sync-safe: seven significant bits per byte.
    const size = payload.length;
    header[4] = (size >> 21) & 0x7f;
    header[5] = (size >> 14) & 0x7f;
    header[6] = (size >> 7) & 0x7f;
    header[7] = size & 0x7f;
    frames.push(header, payload);
  };

  addTextFrame('TIT2', title);
  addTextFrame('TPE1', artist);
  addTextFrame('TALB', 'Auralis test fixtures');
  addTextFrame('TSSE', 'Auralis fixture generator');

  const body = Buffer.concat(frames);
  const padding = Buffer.alloc(64);
  const total = body.length + padding.length;

  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 4; // version 2.4
  header[4] = 0;
  header[5] = 0;
  header[6] = (total >> 21) & 0x7f;
  header[7] = (total >> 14) & 0x7f;
  header[8] = (total >> 7) & 0x7f;
  header[9] = total & 0x7f;

  return Buffer.concat([header, body, padding]);
}

function buildId3v1(title: string, artist: string): Buffer {
  const tag = Buffer.alloc(128);
  tag.write('TAG', 0, 'ascii');
  tag.write(title.slice(0, 30), 3, 'latin1');
  tag.write(artist.slice(0, 30), 33, 'latin1');
  tag.write('Auralis test fixtures'.slice(0, 30), 63, 'latin1');
  tag.write('2026', 93, 'ascii');
  return tag;
}

const HTML_DECOY = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in to continue</title></head>
<body><h1>Sign in to continue</h1><p>This page is served with an audio file name and an audio content type. It is not an audio file.</p></body></html>
`;

const M3U_PLAYLIST = `#EXTM3U
#EXTINF:3,Fixture tone A
tone-a-440hz-stereo.wav
#EXTINF:3,Fixture tone B
tone-b-330hz-mono.mp3
`;

/** The full fixture set served by the bundled origin. */
export function buildFixtures(): readonly FixtureFile[] {
  return [
    {
      name: 'tone-a-440hz-stereo.wav',
      bytes: buildWav(440, 3, 2),
      contentType: 'audio/wav',
      description: 'Valid 16-bit 44.1 kHz stereo WAV, 3 seconds.',
    },
    {
      name: 'tone-b-330hz-mono.mp3',
      bytes: buildMp3({
        seconds: 4,
        bitrateKbps: 192,
        channels: 1,
        withId3: true,
        title: 'Fixture tone B',
        artist: 'Auralis fixtures',
      }),
      contentType: 'audio/mpeg',
      description: 'Valid MPEG-1 Layer III mono stream at 192 kbps with ID3v2 and ID3v1 tags.',
    },
    {
      name: 'tone-c-220hz-stereo-320.mp3',
      bytes: buildMp3({
        seconds: 5,
        bitrateKbps: 320,
        channels: 2,
        withId3: true,
        title: 'Fixture tone C',
        artist: 'Auralis fixtures',
      }),
      contentType: 'audio/mpeg',
      description: 'Valid MPEG-1 Layer III stereo stream at 320 kbps.',
    },
    {
      name: 'tone-d-550hz-stereo.aiff',
      bytes: buildAiff(550, 2, 2),
      contentType: 'audio/aiff',
      description: 'Valid 16-bit 44.1 kHz stereo AIFF, 2 seconds.',
    },
    {
      name: 'tone-e-96khz-24bit-stereo.wav',
      bytes: buildWav(440, 2, 2, 96000),
      contentType: 'audio/wav',
      description: 'High sample rate WAV, used to exercise device compatibility rules.',
    },
    {
      name: 'not-really-audio.mp3',
      bytes: new Uint8Array(Buffer.from(HTML_DECOY, 'utf8')),
      contentType: 'audio/mpeg',
      description: 'An HTML page served with an audio file name and an audio content type.',
    },
    {
      name: 'truncated-tone.wav',
      bytes: buildWav(440, 3, 2).subarray(0, 30),
      contentType: 'audio/wav',
      description: 'A WAV file cut off before its format chunk is complete.',
    },
    {
      name: 'collection.m3u',
      bytes: new Uint8Array(Buffer.from(M3U_PLAYLIST, 'utf8')),
      contentType: 'audio/x-mpegurl',
      description: 'A playlist, which must never be presented as a playable audio file.',
    },
  ];
}
