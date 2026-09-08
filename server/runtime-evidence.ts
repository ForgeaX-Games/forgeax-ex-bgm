/**
 * Turn a profiler dump into pass/fail for "did this session actually sound".
 *
 * Receipts wrap at 64; only `counts` is trustworthy for a real playtest.
 * Callers that still have an old dump (receipts only) get a truncated warning
 * and we rebuild counts from whatever is left in the ring.
 */

export interface RuntimeEvidenceDiagnostic {
  code: string;
  message: string;
  eventId?: string;
}

const OUTCOMES = [
  'played',
  'blocked_disabled',
  'blocked_conditions',
  'blocked_probability',
  'blocked_cooldown',
  'no_asset',
  'rejected_voice_limit',
  'context_locked',
  'no_binding',
] as const;

type Outcome = (typeof OUTCOMES)[number];

export interface RuntimeEvidenceEventCounts {
  total: number;
  byOutcome: Partial<Record<Outcome, number>>;
}

export interface RuntimeEvidenceCounts {
  total: number;
  byOutcome: Partial<Record<Outcome, number>>;
  byEvent: Record<string, RuntimeEvidenceEventCounts>;
}

export interface ParsedRuntimeEvidence {
  projectId?: string;
  counts: RuntimeEvidenceCounts;
  truncated: boolean;
}

const COOLDOWN_MIN = 3;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function outcomeOf(value: unknown): Outcome | undefined {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value)
    ? value as Outcome
    : undefined;
}

function emptyCounts(): RuntimeEvidenceCounts {
  return { total: 0, byOutcome: {}, byEvent: {} };
}

function bump(counts: RuntimeEvidenceCounts, eventId: string, outcome: Outcome): void {
  counts.total += 1;
  counts.byOutcome[outcome] = (counts.byOutcome[outcome] ?? 0) + 1;
  const row = counts.byEvent[eventId] ?? { total: 0, byOutcome: {} };
  row.total += 1;
  row.byOutcome[outcome] = (row.byOutcome[outcome] ?? 0) + 1;
  counts.byEvent[eventId] = row;
}

function parseByOutcome(raw: unknown): Partial<Record<Outcome, number>> {
  if (!isObject(raw)) return {};
  const out: Partial<Record<Outcome, number>> = {};
  for (const key of OUTCOMES) {
    const value = asCount(raw[key]);
    if (value > 0) out[key] = value;
  }
  return out;
}

function parseCounts(raw: unknown): RuntimeEvidenceCounts | undefined {
  if (!isObject(raw)) return undefined;
  const byOutcome = parseByOutcome(raw.byOutcome);
  const byEvent: Record<string, RuntimeEvidenceEventCounts> = {};
  if (isObject(raw.byEvent)) {
    for (const [eventId, row] of Object.entries(raw.byEvent)) {
      if (!eventId.trim() || !isObject(row)) continue;
      const eventOutcome = parseByOutcome(row.byOutcome);
      const total = asCount(row.total) || Object.values(eventOutcome).reduce((sum, n) => sum + (n ?? 0), 0);
      if (total <= 0) continue;
      byEvent[eventId] = { total, byOutcome: eventOutcome };
    }
  }
  const total = asCount(raw.total) || Object.values(byOutcome).reduce((sum, n) => sum + (n ?? 0), 0);
  return { total, byOutcome, byEvent };
}

function countsFromReceipts(raw: unknown): { counts: RuntimeEvidenceCounts; truncated: boolean } {
  const counts = emptyCounts();
  if (!Array.isArray(raw)) return { counts, truncated: false };
  for (const item of raw) {
    if (!isObject(item)) continue;
    const eventId = String(item.eventId ?? '').trim();
    const outcome = outcomeOf(item.outcome);
    if (!eventId || !outcome) continue;
    bump(counts, eventId, outcome);
  }
  return { counts, truncated: raw.length >= 64 };
}

/**
 * Accept a profiler snapshot, a postMessage payload, or a bare `counts` object.
 */
export function parseRuntimeEvidence(raw: unknown): ParsedRuntimeEvidence {
  if (!isObject(raw)) {
    throw new Error('runtime evidence must be a JSON object from getProfilerSnapshot()');
  }
  const payload = isObject(raw.counts) || Array.isArray(raw.receipts) ? raw : { counts: raw };
  const parsed = parseCounts(payload.counts);
  if (parsed && parsed.total > 0) {
    return {
      ...(typeof payload.projectId === 'string' ? { projectId: payload.projectId } : {}),
      counts: parsed,
      truncated: false,
    };
  }
  const fromReceipts = countsFromReceipts(payload.receipts);
  return {
    ...(typeof payload.projectId === 'string' ? { projectId: payload.projectId } : {}),
    counts: fromReceipts.counts,
    truncated: fromReceipts.truncated,
  };
}

export function evaluateRuntimeEvidence(
  evidence: ParsedRuntimeEvidence,
): { errors: RuntimeEvidenceDiagnostic[]; warnings: RuntimeEvidenceDiagnostic[] } {
  const errors: RuntimeEvidenceDiagnostic[] = [];
  const warnings: RuntimeEvidenceDiagnostic[] = [];
  const { counts } = evidence;
  const played = counts.byOutcome.played ?? 0;
  const locked = counts.byOutcome.context_locked ?? 0;

  if (evidence.truncated) {
    warnings.push({
      code: 'runtime_evidence_truncated',
      message:
        'runtime evidence has no cumulative counts and the receipt ring is full; '
        + 'rebuild the game runtime so getProfilerSnapshot() includes counts',
    });
  }

  if (counts.total <= 0) {
    errors.push({
      code: 'runtime_silent',
      message: 'runtime evidence has no emit receipts; play a real session with audio attached',
    });
    return { errors, warnings };
  }

  if (played <= 0) {
    errors.push({
      code: 'runtime_silent',
      message:
        `runtime evidence recorded ${counts.total} emit(s) but none played. `
        + 'Preview without WebAudio, a locked context, or missing assets will do this',
    });
  }

  if (locked > 0) {
    errors.push({
      code: 'runtime_context_locked',
      message:
        `AudioContext stayed locked for ${locked} emit(s); the session was silent. `
        + 'Play in a Chrome/WebGPU preview that has an unlocked WebAudio context',
    });
  }

  for (const [eventId, row] of Object.entries(counts.byEvent)) {
    const eventPlayed = row.byOutcome.played ?? 0;
    const cooldown = row.byOutcome.blocked_cooldown ?? 0;
    if (cooldown >= COOLDOWN_MIN && cooldown > eventPlayed) {
      errors.push({
        code: 'runtime_cooldown_swallowed',
        eventId,
        message:
          `event '${eventId}' was blocked by cooldown ${cooldown} time(s) and played ${eventPlayed}. `
          + 'Pass gameObjectId on emit, or set cooldownMs to 0',
      });
    } else if (row.total > 0 && eventPlayed <= 0 && (row.byOutcome.context_locked ?? 0) <= 0) {
      errors.push({
        code: 'runtime_event_silent',
        eventId,
        message: `event '${eventId}' was emitted ${row.total} time(s) but never played`,
      });
    }
  }

  return { errors, warnings };
}
