export interface RenderOptions {
  channels: Float32Array[];
  sourceSampleRate: number;
  targetSampleRate: number;
  eqNotchHz: number | null;
  reverbWetPct: number;
}

function reverbNoise(context: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  let state = 85847207 >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967295) * 2 - 1;
  };
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) data[i] = next() * Math.exp(-8 * (i / length));
  }
  return buffer;
}

export async function resampleOffline(
  channels: Float32Array[],
  fromRate: number,
  toRate: number,
): Promise<Float32Array[]> {
  if (fromRate === toRate || (channels[0]?.length ?? 0) === 0) return channels;
  const frames = channels[0]?.length ?? 0;
  const outFrames = Math.max(1, Math.ceil((frames / fromRate) * toRate));
  const context = new OfflineAudioContext(channels.length, outFrames, toRate);
  const buffer = context.createBuffer(channels.length, frames, fromRate);
  channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, index) => new Float32Array(rendered.getChannelData(index)));
}

export async function renderTone(options: RenderOptions): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const { channels, sourceSampleRate, targetSampleRate, eqNotchHz, reverbWetPct } = options;
  const useNotch = eqNotchHz !== null && eqNotchHz > 0;
  const useReverb = reverbWetPct > 0;
  if (!useNotch && !useReverb && sourceSampleRate === targetSampleRate) {
    return { channels, sampleRate: sourceSampleRate };
  }
  const frames = channels[0]?.length ?? 0;
  const outFrames = Math.max(1, Math.round((frames / sourceSampleRate) * targetSampleRate));
  const tail = useReverb ? Math.ceil(targetSampleRate * 0.3) : 0;
  const context = new OfflineAudioContext(channels.length, outFrames + tail, targetSampleRate);
  const buffer = context.createBuffer(channels.length, frames, sourceSampleRate);
  channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
  const source = context.createBufferSource();
  source.buffer = buffer;
  let node: AudioNode = source;
  if (useNotch && eqNotchHz) {
    const filter = context.createBiquadFilter();
    filter.type = "notch";
    filter.frequency.value = eqNotchHz;
    filter.Q.value = 30;
    node.connect(filter);
    node = filter;
  }
  if (useReverb) {
    const wet = Math.min(1, reverbWetPct / 100);
    const convolver = context.createConvolver();
    convolver.buffer = reverbNoise(context, 0.3);
    const wetGain = context.createGain();
    wetGain.gain.value = wet;
    const dryGain = context.createGain();
    dryGain.gain.value = 1 - wet;
    node.connect(dryGain).connect(context.destination);
    node.connect(convolver).connect(wetGain).connect(context.destination);
  } else {
    node.connect(context.destination);
  }
  source.start();
  const rendered = await context.startRendering();
  const kept = outFrames + tail;
  return {
    channels: Array.from({ length: rendered.numberOfChannels }, (_, index) =>
      new Float32Array(rendered.getChannelData(index)).slice(0, kept),
    ),
    sampleRate: rendered.sampleRate,
  };
}
