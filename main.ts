// main.ts — a rules-based Werewolf agent for werewolf-agent-01.
//
// The run: POST /observe, and every decision it lists that is not already
// being answered is decided by strategy.ts from that one game's view alone
// and posted to /act. Then /observe again. The run exits once "done".
//
// No model calls, no wall clock, no Math.random: every answer is a function
// of the brief, the views the env served and MAKEFUN_TRIAL_SEED, so the live
// pass and its replay play the same games. Run by the grader as
// `node /bot/main.ts` with this directory at /bot; Node 22's standard
// library only.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decide, parseView, type Pending, type View } from './strategy.ts';

/** The most decisions in flight at once: the env's live games, each waiting on at most one decision. */
export const CONCURRENCY = 10;

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A statement folded to one line the env's way. */
export function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

/** The pass or abstention for a decision. */
export function fallbackFor(p: Pick<Pending, 'game' | 'decision'>): Record<string, unknown> {
  return p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
}

export interface RunOptions {
  envUrl?: string;
  /** The trial seed; read from MAKEFUN_TRIAL_SEED when omitted. */
  seed?: string;
  /** Where the run's summary goes (stdout by default). */
  log?: (line: string) => void;
}

export interface RunSummary {
  decisions: number;
  /** Decisions answered from the strategy (not the fallback). */
  answered: number;
  /** Decisions that fell back to a pass or an abstention. */
  fallbacks: number;
  /** Games whose outcome the agent won, by role (read from the final /observe). */
  games: number;
  finished: number;
}

export async function run(o: RunOptions = {}): Promise<RunSummary> {
  const env = process.env;
  const envUrl = (o.envUrl ?? env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const seed = o.seed ?? env.MAKEFUN_TRIAL_SEED ?? 'werewolf-agent-01';
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  const summary: RunSummary = { decisions: 0, answered: 0, fallbacks: 0, games: 0, finished: 0 };

  const envPost = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let body2: unknown = null;
    try {
      body2 = JSON.parse(text);
    } catch {
      body2 = text;
    }
    return { status: res.status, body: body2 };
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** One decision: the strategy's answer posted, the fallback posted should the env refuse it. */
  const decideOne = async (p: Pending): Promise<void> => {
    summary.decisions += 1;
    let act: Record<string, unknown> = fallbackFor(p);
    let ok = false;
    try {
      const st = parseView(p.view as View);
      const { act: chosen } = decide(st, p, seed);
      act = chosen;
      ok = true;
    } catch {
      // A strategy error never stalls a game: fall back.
      act = fallbackFor(p);
      ok = false;
    }
    let posted = await envPost('/act', act);
    if (posted.status === 400 && JSON.stringify(act) !== JSON.stringify(fallbackFor(p))) {
      ok = false;
      posted = await envPost('/act', fallbackFor(p));
    }
    if (ok && posted.status === 200) summary.answered += 1;
    else summary.fallbacks += 1;
  };

  // A decision is known by its game, its kind and how far its game's log has come: the same decision is
  // listed again on every /observe until it is answered, and never started twice.
  const keyOf = (p: Pending): string => `${p.game}:${p.decision}:${p.view.log.length}`;
  const inFlight = new Map<string, Promise<void>>();
  const started = new Set<string>();
  const errors: string[] = [];
  let lastObserved: Observed | null = null;
  for (;;) {
    const r = await envPost('/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    lastObserved = obs;
    if (obs.done) break;
    for (const p of obs.pending) {
      const key = keyOf(p);
      if (started.has(key) || inFlight.size >= CONCURRENCY) continue;
      started.add(key);
      const task = decideOne(p)
        .catch((err: unknown) => {
          errors.push(`game ${p.game}: ${(err as Error).message}`);
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, task);
    }
    const waiting = obs.pending.some((p) => !started.has(keyOf(p)));
    if (inFlight.size > 0 && (inFlight.size >= CONCURRENCY || !waiting)) await Promise.race(inFlight.values());
    else if (inFlight.size === 0 && obs.pending.length > 0 && !waiting) await sleep(250); // listed, answered, not yet moved on
    // Only the env can fail a decision (a strategy error falls back): the env gone ends the run.
    if (errors.length > 0) break;
  }
  await Promise.all(inFlight.values());
  if (errors.length > 0) throw new Error(`the env failed: ${errors.join('; ')}`);
  summary.games = lastObserved?.games ?? 0;
  summary.finished = lastObserved?.finished ?? 0;
  log(`werewolf-agent: ${summary.decisions} decisions, ${summary.answered} answered by strategy, ${summary.fallbacks} fell back; ${summary.finished}/${summary.games} games finished`);
  return summary;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // The brief is read for the trial seed's context only; the strategy works
  // from each game's view, so a missing prompt file does not stop the run.
  try {
    const promptFile = process.env.MAKEFUN_PROMPT_FILE ?? '';
    if (promptFile !== '') readFileSync(promptFile, 'utf8');
  } catch {
    // Not needed for play.
  }
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
