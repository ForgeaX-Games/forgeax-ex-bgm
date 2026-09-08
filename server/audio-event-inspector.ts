import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

export type AudioEventSource = 'game-audio' | 'event-bus' | 'legacy-audio' | 'direct-sfx';

export interface AudioEventCandidate {
  eventId: string;
  file: string;
  line: number;
  source: AudioEventSource;
  confidence: 'high' | 'medium';
  expression: string;
}

export interface AudioEventInspection {
  candidates: AudioEventCandidate[];
  scannedFiles: number;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
// A folder called `audio` usually holds the game's audio *code*; skipping it hid every call site.
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
// Tests name events that the shipped game never emits, so they must not become candidates.
const TEST_FILE_RE = /\.(?:test|spec)\.[jt]sx?$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GAME_AUDIO_METHODS = new Set(['emit', 'play', 'postEvent']);
const EVENT_BUSES = new Set(['EventBus', 'eventBus', 'EventBus.instance']);
/** Hand-written audio facades, e.g. `sfx.play('hit')` or `this.audioManager.play('hit')`. */
const AUDIO_FACADES = new Set([
  'audio', 'sfx', 'sound', 'sounds', 'soundfx',
  'audiomanager', 'soundmanager', 'sfxmanager', 'audiosystem', 'soundsystem', 'audioengine',
]);
const FACADE_METHODS = new Set(['play', 'emit', 'trigger', 'postEvent', 'playSound', 'playSfx', 'playOneShot']);

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot);
}

async function collectSourceFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.forgeax') continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const rel = relative(root, absolute).split(sep).join('/');
      if (rel === 'src/forgeax-audio' || rel.startsWith('src/forgeax-audio/')) continue;
      files.push(...await collectSourceFiles(root, absolute));
      continue;
    }
    if (
      entry.isFile()
      && SOURCE_EXTENSIONS.has(extension(entry.name))
      && !TEST_FILE_RE.test(entry.name)
    ) files.push(absolute);
  }
  return files.sort();
}

function methodEventId(method: string): string {
  return `sfx.${method.replace(/([a-z0-9])([A-Z])/g, '$1.$2').toLowerCase()}`;
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Every event name a call can pass. `sfx.play(isBoss ? 'boss-kill' : 'kill')` names two real
 * events, and dropping such calls used to hide whole families of sounds from the scan.
 */
function literalEventIds(node: ts.Expression | undefined): string[] {
  if (!node) return [];
  if (ts.isParenthesizedExpression(node)) return literalEventIds(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return EVENT_ID_RE.test(node.text) ? [node.text] : [];
  }
  if (ts.isConditionalExpression(node)) {
    return [...literalEventIds(node.whenTrue), ...literalEventIds(node.whenFalse)];
  }
  return [];
}

/** Dotted receiver text, used for the exact matches like `EventBus.instance`. */
function objectPath(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && ts.isIdentifier(expression.name)
  ) {
    return `${expression.expression.text}.${expression.name.text}`;
  }
  return undefined;
}

/** Trailing name of the receiver, so `this.sfx` and `game.audio` still read as `sfx` / `audio`. */
function receiverName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isCallExpression(expression)) return receiverName(expression.expression);
  return undefined;
}

function expressionText(sourceFile: ts.SourceFile, node: ts.Node, end: number): string {
  return sourceFile.text.slice(node.getStart(sourceFile), end).replace(/\s+/g, ' ').trim();
}

function candidatesFromSource(file: string, sourceText: string): AudioEventCandidate[] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const candidates: AudioEventCandidate[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const method = callee.name.text;
      const object = objectPath(callee.expression);
      const receiver = receiverName(callee.expression);
      const firstArg = node.arguments[0];
      const eventIds = literalEventIds(firstArg);
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const push = (
        ids: readonly string[],
        source: AudioEventSource,
        confidence: 'high' | 'medium',
        expression: string,
      ): void => {
        for (const eventId of ids) {
          candidates.push({ eventId, file, line, source, confidence, expression });
        }
      };
      const withArg = (): string => expressionText(sourceFile, callee, firstArg!.getEnd());

      if (object === 'gameAudio' && GAME_AUDIO_METHODS.has(method) && eventIds.length && firstArg) {
        push(eventIds, 'game-audio', 'high', withArg());
      } else if (object && EVENT_BUSES.has(object) && method === 'emit' && eventIds.length && firstArg) {
        push(eventIds, 'event-bus', 'high', withArg());
      } else if (
        eventIds.length
        && firstArg
        && receiver
        && AUDIO_FACADES.has(receiver.toLowerCase())
        && FACADE_METHODS.has(method)
      ) {
        push(eventIds, 'legacy-audio', 'high', withArg());
      } else if (receiver === 'sfx' && /^play[A-Z]/.test(method)) {
        push(
          [methodEventId(method.slice('play'.length))],
          'direct-sfx',
          'medium',
          `${expressionText(sourceFile, callee, callee.getEnd())}(`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return candidates;
}

export async function inspectAudioEvents(gameDir: string): Promise<AudioEventInspection> {
  const files = await collectSourceFiles(gameDir);
  const candidates: AudioEventCandidate[] = [];
  for (const absolute of files) {
    const file = relative(gameDir, absolute).split(sep).join('/');
    const sourceText = await readFile(absolute, 'utf8');
    candidates.push(...candidatesFromSource(file, sourceText));
  }
  return { candidates, scannedFiles: files.length };
}
