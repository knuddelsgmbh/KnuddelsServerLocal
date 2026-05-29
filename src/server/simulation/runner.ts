import { world, SimUser, DEFAULT_KNUDDEL } from '../state/world.js';
import { dispatchPublicMessage, dispatchUserJoined, dispatchUserLeft } from './dispatch.js';
import {
  NICK_POOL,
  PERSONALITIES,
  Personality,
  PersonalityId,
  pickRandom,
  renderPhrase,
} from './personalities.js';

export type SimulationConfig = {
  /** Target number of simulated users that should be in the channel. */
  targetUsers: number;
  /** Fraction of users that should be troublemakers (0..1). */
  troublemakerRatio: number;
  /** Optional explicit weights per personality. Overrides troublemakerRatio if given. */
  weights?: Partial<Record<PersonalityId, number>>;
};

export type SimulationStatus = {
  running: boolean;
  config: SimulationConfig | null;
  activeUsers: { userId: number; nick: string; personality: PersonalityId; inChannel: boolean }[];
  joinedSinceStart: number;
  leftSinceStart: number;
  messagesSinceStart: number;
};

type AgentState = {
  userId: number;
  personalityId: PersonalityId;
  joinAt: number;
  /** Has the agent already greeted? */
  greeted: boolean;
  /** Earliest time at which the agent is allowed to leave on its own (avoid instant churn). */
  notLeavingBefore: number;
  /** Earliest time at which the agent may post the next message (per-user cooldown). */
  nextSpeakAt: number;
};

const TICK_MS = 1000;

class SimulationRunner {
  private timer: NodeJS.Timeout | null = null;
  private config: SimulationConfig | null = null;
  private agents = new Map<number, AgentState>();
  private joined = 0;
  private left = 0;
  private messages = 0;

  start(config: SimulationConfig): void {
    if (this.timer) this.stop();
    this.config = sanitize(config);
    this.agents.clear();
    this.joined = 0;
    this.left = 0;
    this.messages = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Trigger one immediate tick so the first user joins without delay.
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Remove every simulated user from the channel and from the world.
    for (const agent of this.agents.values()) {
      const sim = world.users.get(agent.userId);
      if (!sim) continue;
      if (sim.isInChannel) dispatchUserLeft(agent.userId);
      // Notify apps that the simulated user is being deleted (privacy event),
      // then force-purge any leftover user-scoped persistence keys so that
      // apps which don't clean up themselves don't leak data across sim runs.
      // Both steps run isolated per-app: a throw in one app must not skip the
      // next app or block `world.users.delete` — otherwise we'd leave behind
      // either stale user records (with no agent driver) or orphan persistence
      // entries for non-existent users.
      for (const app of world.apps.values()) {
        try { app.app?.onUserDeleted?.(agent.userId, app.persistence); }
        catch (e: any) {
          world.log({ ts: Date.now(), appId: app.appId, level: 'error', msg: `onUserDeleted threw: ${e?.message ?? e}` });
        }
        try { app.persistence.deleteAllForUser(agent.userId); }
        catch (e: any) {
          world.log({ ts: Date.now(), appId: app.appId, level: 'error', msg: `deleteAllForUser threw for user ${agent.userId}: ${e?.message ?? e}` });
        }
      }
      world.users.delete(agent.userId);
    }
    this.agents.clear();
    world.emitChange();
    this.config = null;
  }

  status(): SimulationStatus {
    const list: SimulationStatus['activeUsers'] = [];
    for (const agent of this.agents.values()) {
      const sim = world.users.get(agent.userId);
      if (!sim) continue;
      list.push({
        userId: agent.userId,
        nick: sim.nick,
        personality: agent.personalityId,
        inChannel: sim.isInChannel,
      });
    }
    return {
      running: this.timer !== null,
      config: this.config,
      activeUsers: list,
      joinedSinceStart: this.joined,
      leftSinceStart: this.left,
      messagesSinceStart: this.messages,
    };
  }

  private tick(): void {
    if (!this.config) return;

    // 1) Top up the channel until target reached. Soft pace: max one join per tick.
    const inChannelCount = countInChannel(this.agents);
    if (inChannelCount < this.config.targetUsers) {
      this.spawnAgent();
    }

    // 2) Per-agent decisions.
    for (const agent of [...this.agents.values()]) {
      const sim = world.users.get(agent.userId);
      if (!sim) {
        this.agents.delete(agent.userId);
        continue;
      }
      if (!sim.isInChannel) continue;
      const personality = PERSONALITIES[agent.personalityId];

      if (!agent.greeted) {
        agent.greeted = true;
        const greet = personality.greetings ? pickRandom(personality.greetings) : null;
        if (greet) {
          dispatchPublicMessage(agent.userId, greet);
          this.messages++;
          agent.nextSpeakAt = Date.now() + cooldownMs(personality.minMessageGapSec);
        }
        continue;
      }

      const now = Date.now();

      // Decide: leave?
      if (now >= agent.notLeavingBefore && Math.random() < personality.leavePerSec) {
        const farewell = personality.farewells ? pickRandom(personality.farewells) : null;
        if (farewell) {
          dispatchPublicMessage(agent.userId, farewell);
          this.messages++;
        }
        // Keep the user record in world.users so getUserId(nick) still resolves them
        // after they leave the channel — matches production behavior.
        dispatchUserLeft(agent.userId);
        this.agents.delete(agent.userId);
        this.left++;
        continue;
      }

      // Decide: post a message? Respects the per-user cooldown so even chatty users feel realistic.
      if (now >= agent.nextSpeakAt && Math.random() < personality.chatPerSec) {
        const text = this.composeMessage(personality, agent.userId);
        if (text) {
          dispatchPublicMessage(agent.userId, text);
          this.messages++;
          agent.nextSpeakAt = now + cooldownMs(personality.minMessageGapSec);
        }
      }
    }
  }

  private spawnAgent(): void {
    if (!this.config) return;
    const personalityId = pickPersonality(this.config);
    const nick = uniqueNick();
    const id = world.nextUserId++;
    const sim: SimUser = {
      userId: id,
      nick,
      gender: pickRandom(['Male', 'Female', 'Unknown'] as const),
      age: 18 + Math.floor(Math.random() * 35),
      status: 'Stammi',
      userType: 'Human',
      isInChannel: false,
      isChannelOwner: false,
      isAppManager: false,
      knuddel: DEFAULT_KNUDDEL,
    };
    world.users.set(id, sim);
    const personality = PERSONALITIES[personalityId];
    const minStay = Math.max(15_000, personality.meanStaySec * 200);
    const now = Date.now();
    this.agents.set(id, {
      userId: id,
      personalityId,
      joinAt: now,
      greeted: false,
      notLeavingBefore: now + minStay,
      // First message is the greeting; the cooldown is set after greeting.
      nextSpeakAt: now,
    });
    const r = dispatchUserJoined(id);
    if (!r.joined) {
      world.users.delete(id);
      this.agents.delete(id);
      world.emitChange();
      return;
    }
    this.joined++;
  }

  private composeMessage(personality: Personality, selfUserId: number): string | null {
    const template = pickRandom(personality.phrases);
    const otherNick = personality.repliesToOthers ? pickOtherNick(selfUserId) : null;
    return renderPhrase(template, otherNick);
  }
}

/** Randomize the gap a bit (±40%) so messages don't fall on a metronome. */
function cooldownMs(baseSec: number): number {
  const jitter = 0.6 + Math.random() * 0.8;
  return Math.round(baseSec * 1000 * jitter);
}

function sanitize(c: SimulationConfig): SimulationConfig {
  const target = Math.max(0, Math.min(50, Math.floor(c.targetUsers)));
  const troublemakerRatio = Math.max(0, Math.min(1, c.troublemakerRatio));
  return { targetUsers: target, troublemakerRatio, weights: c.weights };
}

function countInChannel(agents: Map<number, AgentState>): number {
  let n = 0;
  for (const a of agents.values()) {
    if (world.users.get(a.userId)?.isInChannel) n++;
  }
  return n;
}

function pickPersonality(config: SimulationConfig): PersonalityId {
  if (config.weights) {
    const entries = Object.entries(config.weights).filter(([, w]) => (w ?? 0) > 0) as [PersonalityId, number][];
    if (entries.length > 0) return weightedPick(entries);
  }
  // Fall back to troublemakerRatio split.
  const isTrouble = Math.random() < config.troublemakerRatio;
  const pool = (Object.values(PERSONALITIES) as Personality[]).filter(p =>
    isTrouble ? p.category === 'troublemaker' : p.category === 'normal',
  );
  return pickRandom(pool).id;
}

function weightedPick(entries: [PersonalityId, number][]): PersonalityId {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [id, w] of entries) {
    r -= w;
    if (r <= 0) return id;
  }
  return entries[entries.length - 1][0];
}

function uniqueNick(): string {
  const taken = new Set(Array.from(world.users.values()).map(u => u.nick.toLowerCase()));
  for (let i = 0; i < 50; i++) {
    const base = pickRandom(NICK_POOL);
    const candidate = taken.has(base.toLowerCase()) ? `${base}${Math.floor(Math.random() * 99) + 1}` : base;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `Gast${world.nextUserId}`;
}

function pickOtherNick(selfUserId: number): string | null {
  const others: string[] = [];
  for (const u of world.users.values()) {
    if (!u.isInChannel) continue;
    if (u.userId === selfUserId) continue;
    others.push(u.nick);
  }
  if (others.length === 0) return null;
  return pickRandom(others);
}

export const simulationRunner = new SimulationRunner();
