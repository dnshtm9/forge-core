// A faithful port of the kit's sealed scenario generator (program/env/src/wire.ts): one fixed seed
// builds every user, repository, path, blob, commit message and issue/PR template the suite sends.
// The entry needs it to know which login the trial's bearer token names (the scenario's viewer) and
// to prebuild nothing else — the forge's own state is built from what actually arrives over the wire.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error(`nextInt ${String(maxExclusive)}`);
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  chance(probability: number): boolean {
    return this.nextU32() / 4_294_967_296 < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = swap;
    }
    return copy;
  }
}

const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
const REPO_ADJECTIVES = ['amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat', 'vivid', 'warm', 'witty', 'young', 'zesty'];
const REPO_NOUNS = ['acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor', 'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven', 'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr'];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface ScenarioRepo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

export interface Scenario {
  readonly seed: string;
  readonly viewer: ScenarioUser;
  readonly users: readonly ScenarioUser[];
  readonly org: string;
  readonly repos: readonly ScenarioRepo[];
  readonly orgRepos: readonly ScenarioRepo[];
  readonly strangerRepos: readonly ScenarioRepo[];
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

function generateRepos(rng: Rng, owner: string, count: number, firstId = 5000): ScenarioRepo[] {
  const used = new Set<string>();
  const repos: ScenarioRepo[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    repos.push({
      id: firstId + i,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: rng.pick(['a small service with a sharp edge', 'notes and experiments, kept until they are not', 'the tooling behind the thing', 'a reference implementation, for reading', 'what the prototype became', 'fixtures, generators and the odd benchmark', 'the parts that must not break', 'a sandbox for the next idea']),
      private: i % 7 === 3,
      defaultBranch: 'main',
    });
  }
  return repos;
}

let cached: Scenario | null = null;

export function buildScenario(): Scenario {
  if (cached !== null) return cached;
  const users = generateUsers(new Rng(scenarioSeedFor('users')), 12);
  const viewer = users[0] as ScenarioUser;
  const stranger = users[2] as ScenarioUser;
  const orgRng = new Rng(scenarioSeedFor('org'));
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  const repos = generateRepos(new Rng(scenarioSeedFor('repos.viewer')), viewer.login, 30, 5000);
  const orgRepos = generateRepos(new Rng(scenarioSeedFor('repos.org')), org, 6, 6000);
  const strangerRepos = generateRepos(new Rng(scenarioSeedFor('repos.stranger')), stranger.login, 3, 7000);
  cached = { seed: SCENARIO_SEED_HEX, viewer, users, org, repos, orgRepos, strangerRepos, stranger };
  return cached;
}
