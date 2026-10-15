export interface FakeCall {
  argv: string[];
  context: string | null;
  stdin_b64: string | null;
  /** Set by the PATH shim only: the names of the environment the docker client saw. */
  env_keys?: string[];
  docker_config?: string | null;
}
export interface FakeImage {
  id: string;
  tags: string[];
  env: string[];
  user: string;
  volumes: string[];
  labels: Record<string, string>;
}
export type FakeImageOptions = Partial<Omit<FakeImage, "id" | "tags">>;
export interface FakeContainer {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  [field: string]: unknown;
}
export interface FakeState {
  daemon_down: boolean;
  server_version: string;
  contexts: Record<string, string>;
  build_env: string[];
  build_volumes: string[];
  images: Record<string, FakeImage>;
  registry: Record<string, FakeImageOptions>;
  containers: Record<string, FakeContainer>;
  serial: number;
  calls: FakeCall[];
}
export interface FakeResult {
  status: number;
  stdout: string;
  stderr: string;
}
export interface FakeExecCall {
  name: string;
  argv: string[];
  stdin: Buffer | null;
  workdir: string | null;
  env: Record<string, string>;
}
export interface FakeHooks {
  exec?: (call: FakeExecCall) => FakeResult;
  inspect?: (doc: Record<string, unknown>, container: { name: string; labels: Record<string, string> }) => void;
}
export function newState(options?: { contexts?: Record<string, string> }): FakeState;
export function addImage(state: FakeState, ref: string, options?: FakeImageOptions): string;
export function addRegistryImage(state: FakeState, ref: string, options?: FakeImageOptions): void;
export function handle(
  state: FakeState,
  argv: readonly string[],
  stdin?: string | Uint8Array | null,
  hooks?: FakeHooks,
): FakeResult;
