export type RuntimeAudioBus = "sfx" | "music" | "voice";
export type RuntimeConditionValue = string | number | boolean | Array<string | number | boolean>;
export type RuntimeFollowValue = string | number | boolean;
export type PlaybackId = number;
export type GameObjectId = string;
export type RuntimeSelectionScope = "global" | "gameObject";
export type RuntimeCurveInterp = "linear" | "log" | "exp" | "sCurve" | "constant";
export type AudioCallbackPhase = "start" | "end" | "stop";
export interface AudioPoint {
	x: number;
	y: number;
	z: number;
}
/** Where a sound comes from; `forward` only matters for cone attenuation. */
export type AudioEmitterTransform = AudioPoint & {
	forward?: AudioPoint;
};
export interface AudioListenerTransform {
	position: AudioPoint;
	forward?: AudioPoint;
	up?: AudioPoint;
}
export interface AudioEventContext {
	emitter?: AudioPoint;
	listener?: AudioListenerTransform;
	gameObjectId?: GameObjectId;
	[key: string]: unknown;
}
export interface RuntimeCurvePoint {
	x: number;
	y: number;
	interp: RuntimeCurveInterp;
}
export interface RuntimeBlendLayer {
	node: RuntimeAudioNode;
	rangeStart: number;
	rangeEnd: number;
	crossfadeCurve?: RuntimeCurvePoint[];
}
/** Runtime-local AudioNode tree — mirrors shared AudioNode without pulling server code. */
export type RuntimeAudioNode = {
	kind: "sound";
	asset: RuntimeAudioAsset;
	nodeKey?: string;
} | {
	kind: "random";
	children: RuntimeAudioNode[];
	weights: number[];
	avoidRepeatCount: number;
	scope: RuntimeSelectionScope;
	nodeKey?: string;
} | {
	kind: "sequence";
	children: RuntimeAudioNode[];
	loop: boolean;
	scope: RuntimeSelectionScope;
	nodeKey?: string;
} | {
	kind: "switch";
	groupId: string;
	assignments: Record<string, RuntimeAudioNode>;
	onSwitchChange?: "restart" | "continue";
	defaultNode?: RuntimeAudioNode;
	nodeKey?: string;
} | {
	kind: "blend";
	rtpcId: string;
	layers: RuntimeBlendLayer[];
	nodeKey?: string;
};
export interface RuntimeAttenuation {
	id: string;
	name?: string;
	maxDistance: number;
	curves: {
		outputVolumeDb: RuntimeCurvePoint[];
		lowpassHz?: RuntimeCurvePoint[];
		highpassHz?: RuntimeCurvePoint[];
		auxSendDb?: RuntimeCurvePoint[];
		spread?: RuntimeCurvePoint[];
	};
	cone?: {
		innerAngleDeg: number;
		outerAngleDeg: number;
		outerVolumeDb: number;
		outerLowpassHz: number;
	};
}
export interface RuntimeMusicSegment {
	id: string;
	name: string;
	tempo: number;
	timeSignature: [
		number,
		number
	];
	preEntryMs?: number;
	entryCueMs?: number;
	exitCueMs?: number;
	postExitMs?: number;
	durationMs?: number;
	assetUrl?: string;
}
export interface RuntimeMusicPlaylist {
	id: string;
	name: string;
	segmentIds: string[];
}
export type RuntimeMusicSyncPoint = "immediate" | "nextBeat" | "nextBar";
export interface RuntimeMusicTransition {
	fromPlaylistId: "*" | string;
	toPlaylistId: "*" | string;
	exitAt: RuntimeMusicSyncPoint;
	fadeOutMs?: number;
	fadeInMs?: number;
}
export interface RuntimeMusicProject {
	segments: RuntimeMusicSegment[];
	playlists: RuntimeMusicPlaylist[];
	transitions: RuntimeMusicTransition[];
}
export interface RuntimeBankFeatures {
	music?: boolean;
	attenuation?: boolean;
	gameSyncs?: boolean;
}
export interface RuntimeGameSyncDefs {
	states?: Array<{
		id: string;
		name: string;
		values: string[];
		defaultValue: string;
		transitions: Array<{
			from: "*" | string;
			to: "*" | string;
			timeMs: number;
		}>;
	}>;
	switches?: Array<{
		id: string;
		name: string;
		values: string[];
		defaultValue: string;
		rtpcId?: string;
	}>;
	rtpcs?: Array<{
		id: string;
		name: string;
		min: number;
		max: number;
		defaultValue: number;
		scope: RuntimeSelectionScope;
		slewMsDefault: number;
	}>;
}
export interface RuntimeRtpcBinding {
	rtpcId: string;
	target: "volumeDb" | "pitchSemitones" | "lowpassHz" | "highpassHz" | "auxSendDb";
	auxBusId?: string;
	curve: RuntimeCurvePoint[];
}
export interface RuntimeStateOffset {
	groupId: string;
	values: Record<string, {
		volumeDb?: number;
		pitchSemitones?: number;
		lowpassHz?: number;
	}>;
}
export type AudioEventCallback = (detail: {
	eventId: string;
	phase: AudioCallbackPhase;
	playbackId?: PlaybackId;
	gameObjectId?: GameObjectId;
}) => void;
export interface RuntimeAudioShaping {
	gainDb: number;
	pitchSemitones: number;
	highpassHz: number;
	lowpassHz: number;
	eqLowDb: number;
	eqMidDb: number;
	eqHighDb: number;
}
export interface RuntimeAudioAsset {
	assetId: string;
	file: string;
	url: string;
	/** Engine asset GUID of the clip, carried over from the event pack. */
	guid?: string;
	name?: string;
	shaping?: RuntimeAudioShaping;
	durationMs?: number;
}
export interface RuntimeAudioBinding {
	eventId: string;
	/** GUID of the event asset this was compiled from, in events.pack.json. */
	guid?: string;
	label: string;
	enabled: boolean;
	kind: RuntimeAudioBus;
	assets: RuntimeAudioAsset[];
	variation: {
		mode: "single" | "sequential" | "random-no-repeat";
	};
	trigger: {
		delayMs: number;
		cooldownMs: number;
		probability: number;
		/** Repeat interval in ms; absent means measure it, 0 means leave timing alone. */
		rhythmLockMs?: number;
	};
	playback: {
		volume: number;
		bus: RuntimeAudioBus;
		spatial: "2d" | "3d";
		/** Attenuation share set to evaluate for this sound; falls back to the first one. */
		attenuationId?: string;
		mode: "one-shot" | "loop";
		fadeInMs: number;
		fadeOutMs: number;
		stopEventId?: string;
	};
	shaping?: RuntimeAudioShaping;
	follow?: {
		field: string;
		label?: string;
		defaultValue: RuntimeFollowValue;
		cases?: Array<{
			value: RuntimeFollowValue;
			label?: string;
			assets: RuntimeAudioAsset[];
		}>;
		range?: {
			min: number;
			max: number;
			volumeStart: number;
			volumeEnd: number;
			pitchStart: number;
			pitchEnd: number;
			lowpassStart: number;
			lowpassEnd: number;
		};
	};
	conditions: Array<{
		field: string;
		operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";
		value: RuntimeConditionValue;
	}>;
	priority?: number;
	maxInstances?: number;
}
export interface RuntimeDuckRule {
	sourceBusId: string;
	volumeDb: number;
	attackMs: number;
	releaseMs: number;
	curve: "linear" | "sCurve";
}
export interface RuntimeBusNode {
	id: string;
	name: string;
	parentId?: string;
	volumeDb: number;
	ducking: RuntimeDuckRule[];
	voiceLimit?: number;
}
export interface RuntimeAudioProject {
	schemaVersion: "forgeax-audio-runtime/1";
	projectId: string;
	revision: number;
	engineVersion?: string;
	bindings: RuntimeAudioBinding[];
	buses?: RuntimeBusNode[];
	voiceBudget?: {
		maxPhysical: number;
	};
	/** Optional v2 bank extras — ignored by the legacy bindings path when absent. */
	bankFeatures?: RuntimeBankFeatures;
	gameSyncs?: RuntimeGameSyncDefs;
	attenuations?: RuntimeAttenuation[];
	music?: RuntimeMusicProject;
}
export interface AudioPlayRequest {
	bindingId: string;
	eventId: string;
	playbackId?: PlaybackId;
	gameObjectId?: GameObjectId;
	asset: RuntimeAudioAsset;
	volume: number;
	bus: RuntimeAudioBus | string;
	loop: boolean;
	fadeInMs: number;
	fadeOutMs: number;
	spatial: "2d" | "3d";
	context: AudioEventContext;
	startAudioTime?: number;
}
export interface AudioHandle {
	stop(fadeOutMs: number): void;
	update?(request: AudioPlayRequest): void;
}
export interface AudioPort {
	play(request: AudioPlayRequest): AudioHandle | Promise<AudioHandle | undefined> | undefined;
	setBusVolume(bus: RuntimeAudioBus | string, volume: number): void;
	unlock?(): Promise<void>;
	isReady?(): boolean;
	currentTime?(): number;
	dispose(): void;
}
export type EmitOutcome = "played" | "blocked_disabled" | "blocked_conditions" | "blocked_probability" | "blocked_cooldown" | "no_asset" | "rejected_voice_limit" | "context_locked" | "no_binding";
export interface EmitReceipt {
	eventId: string;
	bindingId: string;
	gameObjectId: GameObjectId;
	playbackId?: PlaybackId;
	outcome: EmitOutcome;
	audioTime?: number;
	detail?: string;
}
export type EmitOutcomeCounts = Partial<Record<EmitOutcome, number>>;
export interface ProfilerEventCounts {
	total: number;
	byOutcome: EmitOutcomeCounts;
}
/**
 * Cumulative emit tallies. The receipt ring is capped; these are not.
 * Audit/verify read this to decide whether a session actually sounded.
 */
export interface ProfilerCounts {
	total: number;
	byOutcome: EmitOutcomeCounts;
	byEvent: Record<string, ProfilerEventCounts>;
}
export interface ProfilerSnapshot {
	projectId: string;
	receipts: EmitReceipt[];
	voices: Array<{
		playbackId: PlaybackId;
		eventId: string;
		gameObjectId: GameObjectId;
		computedVolumeDb: number;
		state: string;
	}>;
	counts: ProfilerCounts;
}
export interface ProfilerPostMessage {
	type: "forgeax-audio-profiler";
	projectId: string;
	receipts: EmitReceipt[];
	voices: ProfilerSnapshot["voices"];
	counts: ProfilerCounts;
}
export interface ForgeaxAudioRuntime {
	emit(eventId: string, context?: AudioEventContext): number;
	/** Alias for emit — Wwise-style naming used by authored game code. */
	postEvent(eventId: string, context?: AudioEventContext): number;
	/** Same as emit, but returns one receipt per evaluated binding / miss. */
	emitDetailed(eventId: string, context?: AudioEventContext): EmitReceipt[];
	setGameValue(field: string, value: RuntimeFollowValue, gameObjectId?: GameObjectId): void;
	setState(groupId: string, value: string): void;
	setSwitch(groupId: string, value: string, gameObjectId?: GameObjectId): void;
	setRTPC(rtpcId: string, value: number, gameObjectId?: GameObjectId, slewMs?: number): void;
	setListener(transform: AudioListenerTransform): void;
	setObstruction(gameObjectId: GameObjectId, value: number): void;
	/**
	 * Publish where a game object is. Emits tagged with the same id then spatialize without
	 * passing coordinates at every call site.
	 */
	setGameObjectTransform(gameObjectId: GameObjectId, transform: AudioEmitterTransform): void;
	on(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
	off(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
	warmUp(urls?: string[]): Promise<void>;
	getProfilerSnapshot(): ProfilerSnapshot;
	registerGameObject(gameObjectId: GameObjectId): void;
	unregisterGameObject(gameObjectId: GameObjectId): void;
	stop(eventId?: string, gameObjectId?: GameObjectId): void;
	stopPlayback(playbackId: PlaybackId, fadeOutMs?: number): void;
	setBusVolume(bus: RuntimeAudioBus | string, volume: number): void;
	whenReady(): Promise<void>;
	isReady(): boolean;
	dispose(): void;
}
export interface ForgeaxAudioRuntimeOptions {
	port?: AudioPort;
	now?: () => number;
	random?: () => number;
	schedule?: (run: () => void, delayMs: number) => unknown;
	cancel?: (handle: unknown) => void;
	onReceipt?: (receipt: EmitReceipt) => void;
	engineVersion?: string;
	/** Disable diagnostics allocation when quiet. Default true. */
	diagnostics?: boolean;
}
export declare const ENGINE_VERSION = "2.0.0-dev";
export declare class EngineVersionMismatchError extends Error {
	readonly code = "engine_version_mismatch";
	constructor(expected: string, actual: string);
}
export declare function assertEngineVersion(project: RuntimeAudioProject, engineVersion?: string): void;
export declare function createForgeaxAudioRuntime(project: RuntimeAudioProject, options?: ForgeaxAudioRuntimeOptions): ForgeaxAudioRuntime;
/**
 * Layer shaping: gains sum, filters take the stricter side, then clamp.
 * The audio studio preview imports this so audition matches in-game audio.
 */
export declare function mergeShaping(...layers: Array<RuntimeAudioShaping | Partial<RuntimeAudioShaping> | undefined>): RuntimeAudioShaping | undefined;
export interface DecodeCacheOptions {
	maxBytes: number;
	decode: (url: string) => Promise<{
		buffer: AudioBuffer;
		byteLength: number;
	}>;
}
export interface DecodeCache {
	get(url: string): Promise<AudioBuffer>;
	peek(url: string): AudioBuffer | undefined;
	clear(): void;
	stats(): {
		entries: number;
		bytes: number;
	};
}
export declare function createDecodeCache(options: DecodeCacheOptions): DecodeCache;
export declare const STREAM_THRESHOLD_MS = 30000;
export declare function shouldStreamAsset(durationMs: number | undefined, thresholdMs?: number): boolean;
export interface BusGraphState {
	busId: string;
	volumeDb: number;
	duckDb: number;
	activeVoices: number;
}
export interface BusGraph {
	buses(): RuntimeBusNode[];
	noteVoiceStart(busId: string): void;
	noteVoiceStop(busId: string): void;
	setVolumeDb(busId: string, volumeDb: number): void;
	/** Returns linear gain multipliers after ducking for each bus id. */
	tickDucking(audioTime: number): Map<string, number>;
	state(busId: string): BusGraphState | undefined;
	dispose(): void;
}
export declare function defaultRuntimeBuses(): RuntimeBusNode[];
/** Detect cycles including aux-less parent links. */
export declare function busGraphHasCycle(buses: RuntimeBusNode[]): boolean;
/**
 * Logical bus graph + ducking. Physical Web Audio nodes stay in the port;
 * this module owns voice counts and duck automation curves.
 */
export declare function createBusGraph(buses: RuntimeBusNode[]): BusGraph;
export declare const GLOBAL_GAME_OBJECT_ID: GameObjectId;
export interface RtpcDefinition {
	id: string;
	name: string;
	min: number;
	max: number;
	defaultValue: number;
	scope: "global" | "gameObject";
	slewMsDefault: number;
}
export interface SwitchGroup {
	id: string;
	name: string;
	values: string[];
	defaultValue: string;
	rtpcId?: string;
}
export interface StateGroup {
	id: string;
	name: string;
	values: string[];
	defaultValue: string;
	transitions: Array<{
		from: "*" | string;
		to: "*" | string;
		timeMs: number;
	}>;
}
export interface StateSnapshot {
	groupId: string;
	from: string;
	to: string;
	/** 0..1 progress of the configured transition time. */
	progress: number;
}
export interface GameSyncs {
	setState(groupId: string, value: string, audioTime: number): void;
	setSwitch(groupId: string, value: string, gameObjectId?: GameObjectId): void;
	setRTPC(rtpcId: string, value: number, gameObjectId?: GameObjectId, slewMs?: number): void;
	/** @deprecated Prefer setRTPC */
	setRtpc(rtpcId: string, value: number, gameObjectId?: GameObjectId, slewMs?: number): void;
	getRtpc(rtpcId: string, gameObjectId?: GameObjectId): number;
	getRTPC(rtpcId: string, gameObjectId?: GameObjectId): number;
	getSwitch(groupId: string, gameObjectId?: GameObjectId): string | undefined;
	getState(groupId: string): string | undefined;
	stateSnapshot(groupId: string, audioTime: number): StateSnapshot | undefined;
	tick(deltaSeconds: number): void;
	clearScope(gameObjectId: GameObjectId): void;
	dispose(): void;
}
export declare function createGameSyncs(input?: {
	rtpcs?: RtpcDefinition[];
	switches?: SwitchGroup[];
	states?: StateGroup[];
}): GameSyncs;
export interface AttenuationProps {
	volumeDb: number;
	lowpassHz?: number;
	highpassHz?: number;
}
export interface VoicePropertyInput {
	baseVolumeDb: number;
	basePitchSemitones?: number;
	/** Active state offsets, already weighted by transition progress when needed. */
	stateOffsets?: Array<{
		volumeDb?: number;
		pitchSemitones?: number;
		lowpassHz?: number;
	}>;
	stateOffsetDefs?: RuntimeStateOffset[];
	activeStates?: Record<string, {
		value: string;
		from?: string;
		progress?: number;
	}>;
	rtpcBindings?: RuntimeRtpcBinding[];
	rtpcValues?: Record<string, number>;
	attenuation?: AttenuationProps;
	fadeGainDb?: number;
	mute?: boolean;
}
export interface ResolvedVoiceProperties {
	volumeDb: number;
	pitchSemitones: number;
	lowpassHz?: number;
	highpassHz?: number;
}
/**
 * finalVolumeDb / pitch stack:
 * base + state offsets + rtpc curves + distance + cone + fade
 */
export declare function resolveVoiceProperties(input: VoicePropertyInput): ResolvedVoiceProperties;
export interface ResolvedContainerAsset extends RuntimeAudioAsset {
	metadata?: {
		blendWeights?: Array<{
			layerIndex: number;
			weight: number;
		}>;
	};
}
export interface ResolveNodeContext {
	gameObjectId: GameObjectId;
	getSwitch: (groupId: string) => string | undefined;
	getRtpc: (rtpcId: string) => number;
	random: () => number;
	/** Optional root key; nested nodes append path segments. */
	rootKey?: string;
}
export interface ContainerResolver {
	resolveNode(node: RuntimeAudioNode, ctx: ResolveNodeContext): ResolvedContainerAsset | undefined;
	clearScope(gameObjectId: GameObjectId): void;
	dispose(): void;
}
export declare function createContainerResolver(): ContainerResolver;
export interface AttenuationEvaluation {
	distance: number;
	volumeDb: number;
	lowpassHz?: number;
	highpassHz?: number;
	auxSendDb?: number;
	spread?: number;
	coneVolumeDb: number;
	obstructionDb: number;
	occlusionDb: number;
}
/**
 * Distance + cone from emitter/listener transforms, plus obstruction/occlusion offsets.
 */
export declare function evaluateAttenuation(input: {
	attenuation: RuntimeAttenuation;
	emitter: AudioPoint & {
		forward?: AudioPoint;
	};
	listener: AudioListenerTransform;
	/** 0..1 — maps to a simple linear dB / lowpass offset. */
	obstruction?: number;
	/** 0..1 — maps to a simple linear dB / lowpass offset. */
	occlusion?: number;
}): AttenuationEvaluation;
export interface CallbackBus {
	on(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
	off(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
	fire(eventId: string, phase: AudioCallbackPhase, detail?: {
		playbackId?: PlaybackId;
		gameObjectId?: GameObjectId;
	}): void;
	dispose(): void;
}
export declare function createCallbackBus(): CallbackBus;
export interface ProfilerVoiceSnap {
	playbackId: number;
	eventId: string;
	gameObjectId: string;
	computedVolumeDb: number;
	state: string;
}
export interface AudioProfiler {
	recordReceipt(receipt: EmitReceipt): void;
	setVoices(voices: ProfilerVoiceSnap[]): void;
	getSnapshot(): ProfilerSnapshot;
	toPostMessage(): ProfilerPostMessage;
	dispose(): void;
}
export declare function createProfiler(input: {
	projectId: string;
	capacity?: number;
}): AudioProfiler;
export interface MusicEngineOptions {
	music?: RuntimeMusicProject;
	scheduleAt: (audioTime: number, run: (startAudioTime: number) => void) => string;
	nowAudio: () => number;
	onPlaySegment?: (segment: RuntimeMusicSegment, startAudioTime: number) => void;
}
export interface MusicEngine {
	playPlaylist(playlistId: string): void;
	transitionTo(playlistId: string, exitAt?: RuntimeMusicSyncPoint): void;
	stop(): void;
	currentPlaylistId(): string | undefined;
	currentSegmentId(): string | undefined;
	dispose(): void;
}
/** Seconds per beat given tempo in BPM. */
export declare function beatDurationSeconds(tempo: number): number;
/** Seconds per bar given tempo and time signature numerator (beats per bar). */
export declare function barDurationSeconds(tempo: number, beatsPerBar: number): number;
/**
 * Quantise `audioTime` to the next beat boundary relative to `segmentStartAudioTime`.
 * If already exactly on a beat, returns the following beat (strictly next).
 */
export declare function nextBeatAudioTime(segmentStartAudioTime: number, audioTime: number, tempo: number): number;
/**
 * Quantise `audioTime` to the next bar boundary relative to `segmentStartAudioTime`.
 */
export declare function nextBarAudioTime(segmentStartAudioTime: number, audioTime: number, tempo: number, timeSignature: [
	number,
	number
]): number;
export declare function quantizeExitTime(sync: RuntimeMusicSyncPoint, segmentStartAudioTime: number, audioTime: number, segment: Pick<RuntimeMusicSegment, "tempo" | "timeSignature">): number;
/**
 * Minimal interactive music engine. Tree-shake friendly: games without music
 * never import this module. Stub-safe when `music` is absent.
 */
export declare function createMusicEngine(options: MusicEngineOptions): MusicEngine;

export {};
