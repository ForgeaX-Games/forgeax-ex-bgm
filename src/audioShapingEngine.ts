import {
  DEFAULT_AUDIO_SHAPING,
  gainDbToLinear,
  pitchSemitonesToRate,
  type AudioShapingParams,
} from './audioShaping.ts';

type ExtendedAudioElement = HTMLAudioElement & {
  webkitPreservesPitch?: boolean;
};

export class AudioShapingEngine {
  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowShelf: BiquadFilterNode | null = null;
  private midPeak: BiquadFilterNode | null = null;
  private highShelf: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private output: GainNode | null = null;

  constructor(private readonly audio: HTMLAudioElement) {
    this.audio.preservesPitch = false;
    (this.audio as ExtendedAudioElement).webkitPreservesPitch = false;
  }

  /**
   * `volume` 对应绑定的 playback.volume：运行时是在 shaping 增益之外再乘一道
   * （见 runtime 的 targetVolume），这里保持同样的叠加顺序。
   */
  apply(params: AudioShapingParams, bypassed = false, volume = 1): boolean {
    const effective = bypassed ? DEFAULT_AUDIO_SHAPING : params;
    this.audio.playbackRate = pitchSemitonesToRate(effective.pitchSemitones);
    if (!this.ensureGraph()) return false;

    const now = this.context!.currentTime;
    const scale = Math.max(0, Math.min(4, Number.isFinite(volume) ? volume : 1));
    this.set(this.output!.gain, gainDbToLinear(effective.gainDb) * scale, now);
    this.set(this.highpass!.frequency, effective.highpassHz, now);
    this.set(this.lowpass!.frequency, effective.lowpassHz, now);
    this.set(this.lowShelf!.gain, effective.eqLowDb, now);
    this.set(this.midPeak!.gain, effective.eqMidDb, now);
    this.set(this.highShelf!.gain, effective.eqHighDb, now);
    return true;
  }

  async resume(): Promise<void> {
    if (!this.ensureGraph() || this.context!.state === 'running') return;
    await this.context!.resume();
  }

  close(): void {
    this.source?.disconnect();
    void this.context?.close();
  }

  private ensureGraph(): boolean {
    if (this.context) return true;
    const AudioContextCtor = window.AudioContext
      || (window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
    if (!AudioContextCtor) return false;

    this.context = new AudioContextCtor();
    this.source = this.context.createMediaElementSource(this.audio);
    this.highpass = this.context.createBiquadFilter();
    this.lowShelf = this.context.createBiquadFilter();
    this.midPeak = this.context.createBiquadFilter();
    this.highShelf = this.context.createBiquadFilter();
    this.lowpass = this.context.createBiquadFilter();
    this.output = this.context.createGain();

    this.highpass.type = 'highpass';
    this.highpass.Q.value = 0.707;
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 200;
    this.midPeak.type = 'peaking';
    this.midPeak.frequency.value = 1_200;
    this.midPeak.Q.value = 0.8;
    this.highShelf.type = 'highshelf';
    this.highShelf.frequency.value = 5_000;
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = 0.707;

    this.source
      .connect(this.highpass)
      .connect(this.lowShelf)
      .connect(this.midPeak)
      .connect(this.highShelf)
      .connect(this.lowpass)
      .connect(this.output)
      .connect(this.context.destination);
    return true;
  }

  private set(param: AudioParam, value: number, now: number): void {
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, 0.015);
  }
}

