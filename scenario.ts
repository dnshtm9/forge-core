// The trial's seeded identity table: the suite's fixed scenario (one constant seed in the kit's
// sealed wire.ts) builds the same 12 users and 3 repository groups on every run. The forge reads
// this table to know which login the trial's bearer token names (the viewer) and which repository
// names the pagination check creates. Values are the kit generator's exact output.

export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';

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

/** The 12 seeded users, ids 1000..1011; the viewer (the token's login) is first. */
const USERS: readonly ScenarioUser[] = [
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
];

const ORG = 'faint-meadow-org';

/** The viewer's 30 repositories (ids 5000..), the org's 6 (6000..), the stranger's 3 (7000..). */
const VIEWER_REPOS: ReadonlyArray<[string, string, boolean]> = [
  ['amber-thistle', 'the tooling behind the thing', false],
  ['happy-willow', 'a sandbox for the next idea', false],
  ['happy-ember', 'fixtures, generators and the odd benchmark', false],
  ['crisp-thistle', 'the parts that must not break', true],
  ['nimble-delta', 'the parts that must not break', false],
  ['tidy-harbor', 'a small service with a sharp edge', false],
  ['quiet-orchid', 'what the prototype became', false],
  ['gentle-quartz', 'fixtures, generators and the odd benchmark', false],
  ['happy-nebula', 'what the prototype became', false],
  ['witty-thistle', 'fixtures, generators and the odd benchmark', false],
  ['upbeat-yarrow', 'what the prototype became', true],
  ['faint-falcon', 'a small service with a sharp edge', false],
  ['quick-juniper', 'the parts that must not break', false],
  ['tidy-umber', 'notes and experiments, kept until they are not', false],
  ['eager-pebble', 'fixtures, generators and the odd benchmark', false],
  ['warm-raven', 'a sandbox for the next idea', false],
  ['idle-badger', 'what the prototype became', false],
  ['calm-orchid', 'a reference implementation, for reading', true],
  ['tidy-ember', 'the tooling behind the thing', false],
  ['brisk-cedar', 'what the prototype became', false],
  ['steady-meadow', 'what the prototype became', false],
  ['idle-lantern', 'the tooling behind the thing', false],
  ['quick-raven', 'the tooling behind the thing', false],
  ['plain-cedar', 'a small service with a sharp edge', false],
  ['calm-quartz', 'the tooling behind the thing', true],
  ['tidy-lantern', 'the tooling behind the thing', false],
  ['happy-thistle', 'a sandbox for the next idea', false],
  ['crisp-zephyr', 'the parts that must not break', false],
  ['keen-glade', 'fixtures, generators and the odd benchmark', false],
  ['amber-badger', 'a small service with a sharp edge', false],
];

const ORG_REPOS: ReadonlyArray<[string, string, boolean]> = [
  ['quick-ember', 'the tooling behind the thing', false],
  ['mellow-comet', 'what the prototype became', false],
  ['happy-kettle', 'what the prototype became', false],
  ['amber-raven', 'the parts that must not break', true],
  ['brisk-glade', 'what the prototype became', false],
  ['jolly-violet', 'the tooling behind the thing', false],
];

const STRANGER_REPOS: ReadonlyArray<[string, string, boolean]> = [
  ['gentle-comet', 'fixtures, generators and the odd benchmark', false],
  ['faint-raven', 'a sandbox for the next idea', false],
  ['upbeat-orchid', 'the parts that must not break', false],
];

function reposOf(rows: ReadonlyArray<[string, string, boolean]>, owner: string, firstId: number): ScenarioRepo[] {
  return rows.map(([name, description, privateFlag], index) => ({
    id: firstId + index,
    owner,
    name,
    fullName: `${owner}/${name}`,
    description,
    private: privateFlag,
    defaultBranch: 'main',
  }));
}

let cached: Scenario | null = null;

/** The scenario, built once: the token's viewer, the org's and the stranger's repositories. */
export function buildScenario(): Scenario {
  if (cached !== null) return cached;
  const viewer = USERS[0] as ScenarioUser;
  const stranger = USERS[2] as ScenarioUser;
  const repos = reposOf(VIEWER_REPOS, 'adaiversen', 5000);
  const orgRepos = reposOf(ORG_REPOS, ORG, 6000);
  const strangerRepos = reposOf(STRANGER_REPOS, 'olgabauer', 7000);
  cached = { seed: SCENARIO_SEED_HEX, viewer, users: USERS, org: ORG, repos, orgRepos, strangerRepos };
  return cached;
}
