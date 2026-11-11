// strategy.ts — a rules-based Werewolf player for werewolf-agent-01.
//
// No model calls: every decision is a pure function of the env's view of one
// game and the trial seed, so a trial replays byte for byte. No wall clock,
// no Math.random; all randomness comes from a seeded PRNG (trial seed +
// game + day + decision kind + seat).
//
// Ideas, in short:
// - Village: track suspicion from the public record. Voting a revealed
//   villager (or a power role) out is wolfy; voting a revealed wolf out is
//   villager-y; accusations and defences are scored the same way once the
//   target's role is revealed; a seer claim is scored by whether its checks
//   were right. Vote the most suspicious living seat, and use the public
//   vote tally to steer a plurality away from a trusted player.
// - Seer: inspect the most suspicious seat; when a check finds a wolf, claim
//   it in the debate at once, with the night named. Counter-claim a fake seer
//   whose check is provably wrong.
// - Doctor: protect the seer claimant (never twice in a row, never yourself),
//   else the most valuable villager.
// - Wolf: coordinate the kill. When the partner has already named a victim
//   for the night, match it — a kill needs both wolves to agree. When voting
//   first, name the most obvious victim (a seer claimant, else the village's
//   most dangerous player) so the partner is likeliest to follow. In the
//   debate, join the crowd against a villager, deflect suspicion off the
//   partner, and never volunteer a role claim.

export type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
export type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

export interface Player {
  seat: number;
  name: string;
  alive: boolean;
  role: string | null;
}

export interface Pending {
  game: number;
  decision: DecisionKind;
  options?: number[];
  max_chars?: number;
  view: View;
}

export interface View {
  day: number;
  phase: string;
  you: {
    seat: number;
    name: string;
    role: string;
    alive: boolean;
    partner: { seat: number; name: string; alive: boolean } | null;
  };
  players: Player[];
  seerResults: { night: number; seat: number; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: number | null } | null;
  wolfVotes: { night: number; seat: number; target: number | null }[] | null;
  log: LogEntry[];
  [k: string]: unknown;
}

export interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: number;
  target?: number | null;
  text?: string;
  round?: number;
  died?: number | null;
  role?: string;
  tally?: { seat: number; votes: number }[];
  order?: number[];
  winner?: string | null;
  [k: string]: unknown;
}

/** A tiny deterministic PRNG (mulberry32) fed by a string hash (FNV-1a). */
export function rngFor(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;

const isSeat = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 8;

export interface GameState {
  view: View;
  me: View['you'];
  role: Role;
  day: number;
  players: Player[];
  living: Player[];
  livingSeats: number[];
  revealed: Map<number, string>; // seat -> role, once revealed by death/exile
  deaths: { day: number; seat: number; role: string }[];
  exiles: { day: number; seat: number; role: string }[];
  votesByDay: Map<number, { seat: number; target: number | null }[]>;
  statements: { day: number; round: number; seat: number; text: string }[];
  passes: { day: number; round: number; seat: number }[];
  /** Seer claims parsed from statements: claimer says seat X is / is not a wolf. */
  claims: { seat: number; kind: 'seer' | 'doctor'; day: number; target: number | null; werewolf: boolean | null; text: string }[];
  myChecks: { night: number; seat: number; werewolf: boolean }[];
  myLastProtect: { night: number; seat: number | null } | null;
  myWolfVotes: { night: number; seat: number; target: number | null }[];
  /** Seats I have already announced as a wolf (as the seer). */
  announcedWolves: number[];
  announcedSeer: boolean;
}

const SEAT_MENTION = /seat\s+(\d+)/g;
const ACCUSE_WORDS = /\b(wolf|werewolf|suspicious|sus|guilty|vote|exile|kill|lying|liar|fake|impostor)\b/i;
const DEFEND_WORDS = /\b(trust|innocent|not a wolf|not the wolf|defend|believe|clear|villager)\b/i;
const SEER_CLAIM = /\b(i am|i'm|im)\s+(the\s+)?seer\b/i;
const DOCTOR_CLAIM = /\b(i am|i'm|im)\s+(the\s+)?doctor\b/i;
const CHECK_WOLF = /seat\s+(\d+)[^.;]{0,60}\b(is a|is the|is|was)\b[^.;]{0,20}\b(wolf|werewolf)\b/i;
const CHECK_NOT_WOLF = /seat\s+(\d+)[^.;]{0,60}\b(is not|isn't|not a|not the)\b[^.;]{0,20}\b(wolf|werewolf)\b/i;

/** Derive everything the decisions need from one view. */
export function parseView(view: View): GameState {
  const st: GameState = {
    view,
    me: view.you,
    role: view.you.role as Role,
    day: view.day,
    players: view.players,
    living: view.players.filter((p) => p.alive),
    livingSeats: view.players.filter((p) => p.alive).map((p) => p.seat),
    revealed: new Map(),
    deaths: [],
    exiles: [],
    votesByDay: new Map(),
    statements: [],
    passes: [],
    claims: [],
    myChecks: view.seerResults ?? [],
    myLastProtect: view.lastProtect,
    myWolfVotes: view.wolfVotes ?? [],
    announcedWolves: [],
    announcedSeer: false,
  };
  for (const p of view.players) if (!p.alive && p.role) st.revealed.set(p.seat, p.role);
  for (const e of view.log) {
    if (e.kind === 'dawn' && e.died !== null && e.died !== undefined && e.role) {
      st.deaths.push({ day: e.day, seat: e.died, role: e.role });
      st.revealed.set(e.died, e.role);
    } else if (e.kind === 'exile' && e.seat !== null && e.seat !== undefined && e.role) {
      st.exiles.push({ day: e.day, seat: e.seat, role: e.role });
      st.revealed.set(e.seat, e.role);
    } else if (e.kind === 'vote' && isSeat(e.seat)) {
      const day = e.day;
      const arr = st.votesByDay.get(day) ?? [];
      arr.push({ seat: e.seat as number, target: isSeat(e.target) ? (e.target as number) : null });
      st.votesByDay.set(day, arr);
    } else if (e.kind === 'speech' && isSeat(e.seat) && typeof e.text === 'string') {
      st.statements.push({ day: e.day, round: e.round ?? 1, seat: e.seat as number, text: e.text });
    } else if (e.kind === 'pass' && isSeat(e.seat)) {
      st.passes.push({ day: e.day, round: e.round ?? 1, seat: e.seat as number });
    }
  }
  // Parse claims and checks from statements.
  for (const s of st.statements) {
    const isSeerClaim = SEER_CLAIM.test(s.text);
    const isDoctorClaim = DOCTOR_CLAIM.test(s.text);
    if (!isSeerClaim && !isDoctorClaim) continue;
    let target: number | null = null;
    let werewolf: boolean | null = null;
    const mWolf = CHECK_WOLF.exec(s.text);
    const mNot = CHECK_NOT_WOLF.exec(s.text);
    if (mWolf) {
      target = Number(mWolf[1]);
      werewolf = true;
    } else if (mNot) {
      target = Number(mNot[1]);
      werewolf = false;
    }
    st.claims.push({
      seat: s.seat,
      kind: isSeerClaim ? 'seer' : 'doctor',
      day: s.day,
      target: isSeat(target) ? target : null,
      werewolf,
      text: s.text,
    });
    if (isSeerClaim && s.seat === st.me.seat) {
      st.announcedSeer = true;
      if (target !== null && werewolf) st.announcedWolves.push(target);
    }
  }
  return st;
}

/** Suspicion per living seat, from the public record. Higher = more wolfy. */
export function suspicion(st: GameState): Map<number, number> {
  const s = new Map<number, number>();
  for (const p of st.living) s.set(p.seat, 0);
  const add = (seat: number, v: number) => {
    if (s.has(seat)) s.set(seat, (s.get(seat) as number) + v);
  };
  // Votes: exiling a revealed villager / power role is wolfy; exiling a wolf is villager-y.
  for (const votes of st.votesByDay.values()) {
    for (const v of votes) {
      if (v.target === null) continue;
      const role = st.revealed.get(v.target);
      if (role === 'villager') add(v.seat, 2);
      else if (role === 'seer' || role === 'doctor') add(v.seat, 2.5);
      else if (role === 'werewolf') add(v.seat, -2.5);
    }
  }
  // Statements: accusing / defending, scored once the target's role is revealed.
  for (const stmt of st.statements) {
    const accused = new Set<number>();
    const defended = new Set<number>();
    let m: RegExpExecArray | null;
    SEAT_MENTION.lastIndex = 0;
    const mentioned: number[] = [];
    while ((m = SEAT_MENTION.exec(stmt.text)) !== null) {
      const seat = Number(m[1]);
      if (isSeat(seat) && seat !== stmt.seat) mentioned.push(seat);
    }
    if (mentioned.length === 0) continue;
    const accuses = ACCUSE_WORDS.test(stmt.text);
    const defends = DEFEND_WORDS.test(stmt.text);
    if (accuses && !defends) for (const t of mentioned) accused.add(t);
    else if (defends && !accuses) for (const t of mentioned) defended.add(t);
    else if (accuses && defends) {
      // Mixed: the first mention after an accuse word counts as accused.
      for (const t of mentioned) accused.add(t);
    }
    for (const t of accused) {
      const role = st.revealed.get(t);
      if (role === 'villager' || role === 'seer' || role === 'doctor') add(stmt.seat, 1);
      else if (role === 'werewolf') add(stmt.seat, -2);
    }
    for (const t of defended) {
      const role = st.revealed.get(t);
      if (role === 'werewolf') add(stmt.seat, 2);
      else if (role === 'villager' || role === 'seer' || role === 'doctor') add(stmt.seat, -1);
    }
  }
  // Seer claims: a claim whose check was right is villager-y, wrong is wolfy.
  for (const c of st.claims) {
    if (c.kind !== 'seer' || c.target === null || c.werewolf === null) continue;
    const role = st.revealed.get(c.target);
    if (!role) continue;
    const right = (role === 'werewolf') === c.werewolf;
    add(c.seat, right ? -3 : 3);
  }
  // Quiet players: a pass in each debate round is mildly wolfy (wolves hide).
  const passCount = new Map<number, number>();
  for (const p of st.passes) passCount.set(p.seat, (passCount.get(p.seat) ?? 0) + 1);
  for (const [seat, n] of passCount) add(seat, Math.min(n, 4) * 0.25);
  // A seer claim with no check shared at all is a cheap claim.
  for (const c of st.claims) {
    if (c.kind === 'seer' && c.target === null) add(c.seat, 0.5);
  }
  return s;
}

/** How dangerous a villager is to the wolves: right accusations, wolf votes, and being trusted. */
export function danger(st: GameState, sus: Map<number, number>): Map<number, number> {
  const d = new Map<number, number>();
  for (const p of st.living) d.set(p.seat, 0);
  const add = (seat: number, v: number) => {
    if (d.has(seat)) d.set(seat, (d.get(seat) as number) + v);
  };
  for (const stmt of st.statements) {
    let m: RegExpExecArray | null;
    SEAT_MENTION.lastIndex = 0;
    const mentioned: number[] = [];
    while ((m = SEAT_MENTION.exec(stmt.text)) !== null) {
      const seat = Number(m[1]);
      if (isSeat(seat) && seat !== stmt.seat) mentioned.push(seat);
    }
    if (!ACCUSE_WORDS.test(stmt.text)) continue;
    for (const t of mentioned) if (st.revealed.get(t) === 'werewolf') add(stmt.seat, 2);
  }
  for (const votes of st.votesByDay.values()) {
    for (const v of votes) {
      if (v.target !== null && st.revealed.get(v.target) === 'werewolf') add(v.seat, 1.5);
    }
  }
  for (const p of st.living) {
    const susScore = sus.get(p.seat) ?? 0;
    d.set(p.seat, (d.get(p.seat) ?? 0) - susScore * 0.5 + (st.statements.filter((s) => s.seat === p.seat).length * 0.1));
  }
  return d;
}

/** The most credible living seer claimant (not me), if any. */
export function seerClaimant(st: GameState): number | null {
  const claimants = st.claims.filter((c) => c.kind === 'seer' && c.seat !== st.me.seat);
  if (claimants.length === 0) return null;
  // A claimant whose check was proven wrong is a faker, not the seer.
  const credible = claimants.filter((c) => {
    if (c.target === null || c.werewolf === null) return true;
    const role = st.revealed.get(c.target);
    if (!role) return true;
    return (role === 'werewolf') === c.werewolf;
  });
  if (credible.length === 0) return null;
  return credible[credible.length - 1].seat;
}

/** A living seer claimant whose check is provably wrong: a fake seer, i.e. a wolf. */
export function fakeSeerClaimant(st: GameState): number | null {
  for (const c of st.claims) {
    if (c.kind !== 'seer' || c.seat === st.me.seat || c.target === null || c.werewolf === null) continue;
    const role = st.revealed.get(c.target);
    if (role && (role === 'werewolf') !== c.werewolf) return c.seat;
  }
  return null;
}

/** The living seats I may act on, in the decision's options when given. */
const inOptions = (options: number[] | undefined, seats: number[]): number[] =>
  options && options.length > 0 ? seats.filter((s) => options.includes(s)) : seats;

const livingNonSelf = (st: GameState): number[] => st.livingSeats.filter((s) => s !== st.me.seat);
const livingNonWolves = (st: GameState): number[] =>
  st.livingSeats.filter((s) => s !== st.me.seat && !(st.me.partner && s === st.me.partner.seat));

const maxBy = (seats: number[], score: Map<number, number>): number | null => {
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const s of seats) {
    const v = score.get(s) ?? 0;
    if (v > bestScore || (v === bestScore && best !== null && s < best)) {
      bestScore = v;
      best = s;
    }
  }
  return best;
};

/** The wolf kill: match the partner's pick when it is already named, else the obvious victim. */
export function decideKill(st: GameState, p: Pending, rng: () => number): number | null {
  const options = inOptions(p.options, livingNonWolves(st));
  if (options.length === 0) return null;
  const tonight = st.myWolfVotes.filter((v) => v.night === st.day);
  const partnerPick = tonight.find((v) => st.me.partner && v.seat === st.me.partner.seat);
  if (partnerPick && partnerPick.target !== null && options.includes(partnerPick.target)) {
    return partnerPick.target; // both wolves agree: the kill lands
  }
  // First to vote: name the victim the partner is likeliest to follow.
  const seer = seerClaimant(st);
  if (seer !== null && options.includes(seer)) return seer;
  const sus = suspicion(st);
  const dang = danger(st, sus);
  const best = maxBy(options, dang);
  if (best !== null && (dang.get(best) ?? 0) > 0.5) return best;
  // No clear danger: the lowest living non-wolf, a steady Schelling point.
  return Math.min(...options);
}

/** The doctor's protect: the seer claimant first, else the most valuable villager. */
export function decideProtect(st: GameState, p: Pending): number | null {
  const options = inOptions(p.options, livingNonSelf(st));
  if (options.length === 0) return null;
  const last = st.myLastProtect?.seat ?? null;
  const usable = options.filter((s) => s !== last);
  const pool = usable.length > 0 ? usable : options;
  const seer = seerClaimant(st);
  if (seer !== null && pool.includes(seer)) return seer;
  const sus = suspicion(st);
  const dang = danger(st, sus);
  // Most valuable = most dangerous to the wolves and least suspicious.
  const value = new Map<number, number>();
  for (const s of pool) value.set(s, (dang.get(s) ?? 0) - (sus.get(s) ?? 0));
  const best = maxBy(pool, value);
  if (best !== null && (value.get(best) ?? 0) > 0) return best;
  return pool[0];
}

/** The seer's inspect: the most suspicious seat not yet inspected. */
export function decideInspect(st: GameState, p: Pending): number | null {
  const options = inOptions(p.options, livingNonSelf(st));
  if (options.length === 0) return null;
  const inspected = new Set(st.myChecks.map((c) => c.seat));
  const fresh = options.filter((s) => !inspected.has(s));
  const pool = fresh.length > 0 ? fresh : options;
  const sus = suspicion(st);
  const best = maxBy(pool, sus);
  return best;
}

export interface VoteContext {
  /** Votes cast so far today, in order. */
  tally: Map<number, number>;
  leader: number | null;
  leaderVotes: number;
}

/** Today's vote tally so far, from the log. */
export function voteContext(st: GameState): VoteContext {
  const tally = new Map<number, number>();
  const votes = st.votesByDay.get(st.day) ?? [];
  for (const v of votes) if (v.target !== null) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
  let leader: number | null = null;
  let leaderVotes = 0;
  for (const [seat, n] of tally) {
    if (n > leaderVotes || (n === leaderVotes && leader !== null && seat < leader)) {
      leader = seat;
      leaderVotes = n;
    }
  }
  return { tally, leader, leaderVotes };
}

/** The village vote: a known wolf first, else the most suspicious seat the tally can save or crown. */
export function decideVillageVote(st: GameState, p: Pending, sus: Map<number, number>): number | null {
  const options = inOptions(p.options, livingNonSelf(st));
  if (options.length === 0) return null;
  // A wolf I found as the seer, or a fake seer claimant, is the vote.
  const knownWolf = st.myChecks.find((c) => c.werewolf && st.livingSeats.includes(c.seat));
  if (knownWolf && options.includes(knownWolf.seat)) return knownWolf.seat;
  const fake = fakeSeerClaimant(st);
  if (fake !== null && options.includes(fake)) return fake;
  const ctx = voteContext(st);
  const best = maxBy(options, sus);
  const bestSus = best !== null ? (sus.get(best) ?? 0) : 0;
  // No signal at all: abstain rather than exile at random.
  if (bestSus < 1) return null;
  // If a trusted player leads the tally, vote the most suspicious seat to try to overtake them.
  if (ctx.leader !== null && ctx.leader !== best && (sus.get(ctx.leader) ?? 0) < 1) return best;
  return best;
}

/**
 * The wolf vote. The village scores a vote retrospectively: voting out a
 * revealed villager is the strongest wolf tell there is (+2), while voting
 * out a revealed wolf reads as villager-y (-2.5) — and every other living
 * player IS a villager to a wolf, so a vote for anyone but the partner is a
 * vote for a villager. So the wolf abstains by default and votes only to
 * shape the outcome: to save a partner who leads the tally (overtake or
 * tie the vote with a villager), or to bus a partner whose exile no
 * remaining voter can stop (the -2.5 for "catching" a wolf buys the
 * surviving wolf's cover). A partner who is merely the most suspicious
 * player is protected the same way, by building a competing plurality.
 */
export function decideWolfVote(st: GameState, p: Pending, sus: Map<number, number>): number | null {
  // The env's vote options are every living seat but mine — the partner
  // included, which is what makes bussing possible.
  const voteOptions = inOptions(p.options, livingNonSelf(st));
  if (voteOptions.length === 0) return null;
  const partner = st.me.partner?.seat ?? null;
  if (partner === null || !voteOptions.includes(partner)) return null;
  const villagerOptions = voteOptions.filter((s) => s !== partner);
  if (villagerOptions.length === 0) return null;
  const ctx = voteContext(st);
  const votesToday = st.votesByDay.get(st.day) ?? [];
  const votedSoFar = new Set(votesToday.map((v) => v.seat));
  const remainingAfterMe = st.livingSeats.filter((s) => !votedSoFar.has(s)).length - 1;
  const partnerVotes = ctx.tally.get(partner) ?? 0;
  // The best villager target: the most-voted non-partner, else the most suspicious.
  let rival: number | null = null;
  let rivalVotes = 0;
  for (const [seat, n] of ctx.tally) {
    if (seat === partner) continue;
    if (n > rivalVotes || (n === rivalVotes && rival !== null && seat < rival)) {
      rival = seat;
      rivalVotes = n;
    }
  }
  const bestVillager = maxBy(villagerOptions, sus);
  if (partnerVotes > 0 && partnerVotes >= rivalVotes) {
    // The partner leads the tally.
    if (partnerVotes > rivalVotes + remainingAfterMe) {
      return partner; // no remaining voter can stop it: bus, and take the cover
    }
    // Overtake or tie it with a villager.
    if (rival !== null && villagerOptions.includes(rival)) return rival;
    return bestVillager;
  }
  // The partner does not lead yet. If they are the most suspicious living
  // player the village is likeliest to come for them: build a rival plurality.
  const partnerSus = sus.get(partner) ?? 0;
  const othersMax = Math.max(0, ...st.livingSeats.filter((s) => s !== partner).map((s) => sus.get(s) ?? 0));
  if (partnerSus > othersMax) return bestVillager;
  return null; // abstain: let the village exile whom it will, without my name on it
}

export function decideVote(st: GameState, p: Pending): number | null {
  const sus = suspicion(st);
  return st.role === 'werewolf' ? decideWolfVote(st, p, sus) : decideVillageVote(st, p, sus);
}

// ---------------------------------------------------------------------------
// Debate statements
// ---------------------------------------------------------------------------

const nameOf = (st: GameState, seat: number): string => {
  const pl = st.players.find((p) => p.seat === seat);
  return pl ? `${pl.name} (seat ${seat})` : `seat ${seat}`;
};

const REASONS = {
  votedVillager: (st: GameState, seat: number): string | null => {
    for (const votes of st.votesByDay.values()) {
      for (const v of votes) {
        if (v.seat === seat && v.target !== null && st.revealed.get(v.target) === 'villager') {
          return `they voted to exile ${nameOf(st, v.target)}, who turned out a villager`;
        }
      }
    }
    return null;
  },
  votedPower: (st: GameState, seat: number): string | null => {
    for (const votes of st.votesByDay.values()) {
      for (const v of votes) {
        if (v.seat === seat && v.target !== null && (st.revealed.get(v.target) === 'seer' || st.revealed.get(v.target) === 'doctor')) {
          return `they voted to exile ${nameOf(st, v.target)}, who was the ${st.revealed.get(v.target)}`;
        }
      }
    }
    return null;
  },
  defendedWolf: (st: GameState, seat: number): string | null => {
    for (const s of st.statements) {
      if (s.seat !== seat) continue;
      let m: RegExpExecArray | null;
      SEAT_MENTION.lastIndex = 0;
      while ((m = SEAT_MENTION.exec(s.text)) !== null) {
        const t = Number(m[1]);
        if (st.revealed.get(t) === 'werewolf' && DEFEND_WORDS.test(s.text)) {
          return `they defended ${nameOf(st, t)}, who turned out a werewolf`;
        }
      }
    }
    return null;
  },
  accusedVillager: (st: GameState, seat: number): string | null => {
    for (const s of st.statements) {
      if (s.seat !== seat) continue;
      let m: RegExpExecArray | null;
      SEAT_MENTION.lastIndex = 0;
      while ((m = SEAT_MENTION.exec(s.text)) !== null) {
        const t = Number(m[1]);
        if ((st.revealed.get(t) === 'villager' || st.revealed.get(t) === 'seer' || st.revealed.get(t) === 'doctor') && ACCUSE_WORDS.test(s.text)) {
          return `they pushed suspicion on ${nameOf(st, t)}, who turned out ${st.revealed.get(t) === 'villager' ? 'a villager' : `the ${st.revealed.get(t)}`}`;
        }
      }
    }
    return null;
  },
  quiet: (st: GameState, seat: number): string | null => {
    const passes = st.passes.filter((x) => x.seat === seat).length;
    const said = st.statements.filter((x) => x.seat === seat).length;
    if (passes >= 2 && said === 0) return 'they have said almost nothing while villagers died';
    return null;
  },
};

const reasonFor = (st: GameState, seat: number): string => {
  for (const fn of [REASONS.votedPower, REASONS.votedVillager, REASONS.defendedWolf, REASONS.accusedVillager, REASONS.quiet]) {
    const r = fn(st, seat);
    if (r) return r;
  }
  return 'their story does not add up';
};

/** Have I already said this (or its gist) in this game? Avoid repeating myself. */
const saidBefore = (st: GameState, needle: string): boolean =>
  st.statements.some((s) => s.seat === st.me.seat && s.text.includes(needle));

/**
 * The debate statement, or null to pass. The seer claims a found wolf at
 * once; everyone else accuses with a reason, or stays quiet when there is
 * nothing to say.
 */
export function decideSpeak(st: GameState, p: Pending, rng: () => number): string | null {
  const max = p.max_chars ?? 500;
  const sus = suspicion(st);
  const round = currentRound(st);
  const cut = (s: string): string => {
    const chars = [...s];
    return chars.length > max ? chars.slice(0, max).join('').trim() : s;
  };

  // The seer, with a wolf found and not yet announced: claim it, round 1.
  if (st.role === 'seer') {
    const found = st.myChecks.find((c) => c.werewolf && st.livingSeats.includes(c.seat) && !st.announcedWolves.includes(c.seat));
    if (found) {
      const lines = [
        `I am the seer. I checked ${nameOf(st, found.seat)} on night ${found.night}: they are a werewolf. Vote ${nameOf(st, found.seat)}.`,
        `I am the seer, and I checked ${nameOf(st, found.seat)} on night ${found.night}. They are a werewolf. That is my check, vote them out.`,
      ];
      return cut(pick(rng, lines));
    }
    // A fake seer is claiming: counter-claim with my own checks.
    const fake = fakeSeerClaimant(st);
    if (fake !== null && !st.announcedSeer) {
      const myVillagerCheck = st.myChecks.find((c) => !c.werewolf && st.livingSeats.includes(c.seat));
      if (myVillagerCheck) {
        return cut(
          `I am the real seer. ${nameOf(st, fake)} claims to be the seer, but I checked ${nameOf(st, myVillagerCheck.seat)} on night ${myVillagerCheck.night} and they are not a wolf. ${nameOf(st, fake)} is lying.`,
        );
      }
      return cut(`I am the seer, and ${nameOf(st, fake)} is not. Do not trust their claim.`);
    }
  }

  // The village's accusation: the most suspicious living seat, with a reason.
  const target = maxBy(livingNonSelf(st), sus);
  const targetSus = target !== null ? (sus.get(target) ?? 0) : 0;

  if (st.role === 'werewolf') {
    // The push target is never my partner: deflect off them, push a villager.
    const pushTarget = maxBy(livingNonWolves(st), sus);
    const pushSus = pushTarget !== null ? (sus.get(pushTarget) ?? 0) : 0;
    // A reader who tracks votes and speech catches a wolf that hides behind
    // generic lines or stays quiet, so the wolf always speaks with a
    // specific accusation, from round 1. A pass costs suspicion while a
    // content-free line costs the same, so there is no safe silence.
    // Deflect off the partner first.
    const partner = st.me.partner?.seat ?? null;
    if (partner !== null && (sus.get(partner) ?? 0) >= 1 && pushTarget !== null) {
      const lines = [
        `I do not think ${nameOf(st, partner)} is a wolf. Look at ${nameOf(st, pushTarget)} instead.`,
        `${nameOf(st, partner)} has just been quiet, that is not wolf behaviour. I am more suspicious of ${nameOf(st, pushTarget)}: ${reasonFor(st, pushTarget)}.`,
      ];
      return cut(pick(rng, lines));
    }
    // I am the one accused: deny, counter-accuse.
    if ((sus.get(st.me.seat) ?? 0) >= 2 && pushTarget !== null) {
      return cut(`I am not a wolf. ${nameOf(st, pushTarget)} is the one to look at: ${reasonFor(st, pushTarget)}.`);
    }
    // Push the most suspicious villager with a reason, from round 1.
    if (pushTarget !== null && pushSus >= 0.5) {
      const lines = [
        `I agree with the suspicion on ${nameOf(st, pushTarget)}: ${reasonFor(st, pushTarget)}.`,
        `${nameOf(st, pushTarget)} looks like a wolf to me: ${reasonFor(st, pushTarget)}.`,
        `Let us look at ${nameOf(st, pushTarget)}. ${reasonFor(st, pushTarget)} — that is wolf behaviour.`,
      ];
      return cut(pick(rng, lines));
    }
    // No push target yet: a specific observation, never a generic line.
    const passer = st.passes.find((x) => x.day === st.day && x.seat !== st.me.seat);
    if (passer) {
      return cut(`${nameOf(st, passer.seat)} passed instead of speaking. I want to hear from them before we vote.`);
    }
    const quiet = livingNonWolves(st).find((s) => st.statements.filter((x) => x.seat === s).length === 0);
    if (quiet !== undefined) {
      return cut(`${nameOf(st, quiet)} has said nothing while villagers died. That is where I am looking.`);
    }
    if (pushTarget !== null) {
      return cut(`I am suspicious of ${nameOf(st, pushTarget)}: ${reasonFor(st, pushTarget)}.`);
    }
    return cut('Let us look at the votes so far: someone here voted for a villager who turned out innocent.');
  }

  // Village roles (seer without a find, doctor, villager).
  if (target !== null && targetSus >= 1.5) {
    const lines =
      round === 1
        ? [
            `I think ${nameOf(st, target)} is a wolf: ${reasonFor(st, target)}.`,
            `${nameOf(st, target)} is my suspicion: ${reasonFor(st, target)}.`,
            `Look at ${nameOf(st, target)}. ${reasonFor(st, target)}.`,
          ]
        : [
            `Vote ${nameOf(st, target)}. ${reasonFor(st, target)} — that is the wolf.`,
            `I am voting ${nameOf(st, target)}: ${reasonFor(st, target)}.`,
          ];
    return cut(pick(rng, lines));
  }
  if (target !== null && targetSus >= 1 && round === 2) {
    return cut(`I am leaning ${nameOf(st, target)}: ${reasonFor(st, target)}.`);
  }
  // No strong read: a specific observation, not a generic line.
  const passer = st.passes.find((x) => x.day === st.day && x.seat !== st.me.seat);
  if (passer) {
    return cut(`${nameOf(st, passer.seat)} passed instead of speaking. I want to hear from them before we vote.`);
  }
  const quiet = livingNonSelf(st).find((s) => st.statements.filter((x) => x.seat === s).length === 0);
  if (quiet !== undefined) {
    return cut(`${nameOf(st, quiet)} has not spoken yet. Let us hear from them before we decide.`);
  }
  // The doctor never claims; the seer without a find stays low-key.
  if (rng() < 0.5) return null;
  return cut('I have no clear wolf yet, but I am watching the votes: someone here voted for a villager who turned out innocent.');
}

/** Which debate round is this speak decision in? */
function currentRound(st: GameState): number {
  const day = st.day;
  const speeches = st.statements.filter((s) => s.day === day);
  const passes = st.passes.filter((s) => s.day === day);
  const maxRound = Math.max(1, ...speeches.map((s) => s.round), ...passes.map((s) => s.round));
  return maxRound;
}

/** The one decision for a pending item: speak text, a target, or a pass/abstain. */
export function decide(st: GameState, p: Pending, seed: string): { act: Record<string, unknown>; note: string } {
  const rng = rngFor(`${seed}:${p.game}:${st.day}:${p.decision}:${st.me.seat}`);
  switch (p.decision) {
    case 'speak': {
      const text = decideSpeak(st, p, rng);
      if (text === null) return { act: { game: p.game, decision: 'speak', pass: true }, note: 'pass' };
      return { act: { game: p.game, decision: 'speak', text }, note: `say: ${text.slice(0, 60)}` };
    }
    case 'vote': {
      const target = decideVote(st, p);
      return { act: { game: p.game, decision: 'vote', target }, note: target === null ? 'abstain' : `vote seat ${target}` };
    }
    case 'kill': {
      const target = decideKill(st, p, rng);
      return { act: { game: p.game, decision: 'kill', target }, note: target === null ? 'no kill' : `kill seat ${target}` };
    }
    case 'protect': {
      const target = decideProtect(st, p);
      return { act: { game: p.game, decision: 'protect', target }, note: target === null ? 'no protect' : `protect seat ${target}` };
    }
    case 'inspect': {
      const target = decideInspect(st, p);
      return { act: { game: p.game, decision: 'inspect', target }, note: target === null ? 'no inspect' : `inspect seat ${target}` };
    }
  }
}
