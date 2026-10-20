// An in-memory Docker daemon: parses the same argv the real client sends and answers from JSON-serializable state.
// Shared by FakeDocker (in process) and tests/helpers/fake-docker-bin/docker.mjs (one process per call, state in a file).
// It refuses what the real client refuses (an unknown flag, a missing local image, a name in use, a build with a network)
// and builds `container inspect` from the create flags it saw, so a golden argv yields golden facts and a test can model a
// deviation through `hooks.inspect`. Nothing here starts a process or touches the file system.
import { createHash } from "node:crypto";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const BASE_ENV = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
const out = (stdout = "", status = 0, stderr = "") => ({ status, stdout, stderr });
const fail = (message, status = 1) => out("", status, `${message}\n`);
const splitPair = (text, separator) => {
  const at = text.indexOf(separator);
  return [text.slice(0, at), text.slice(at + 1)];
};

export function newState(options = {}) {
  return {
    daemon_down: false,
    server_version: "29.0.0",
    contexts: options.contexts ?? {
      fake: "unix:///var/run/omf-fake.sock",
      "colima-omf-m3f": "unix:///var/run/omf-fake-colima.sock",
    },
    build_env: BASE_ENV,
    build_volumes: [],
    images: {},
    registry: {},
    containers: {},
    serial: 0,
    calls: [],
  };
}

function makeImage(state, ref, options) {
  state.serial += 1;
  const id = `sha256:${sha(`${ref}:${state.serial}`)}`;
  const image = {
    id,
    tags: [ref],
    env: options.env ?? BASE_ENV,
    user: options.user ?? "",
    volumes: options.volumes ?? [],
    labels: options.labels ?? {},
  };
  state.images[id] = image;
  return image;
}

export function addImage(state, ref, options = {}) {
  return makeImage(state, ref, options).id;
}

/** An image the daemon can pull by digest reference but does not hold yet. */
export function addRegistryImage(state, ref, options = {}) {
  state.registry[ref] = options;
}

const findImage = (state, ref) =>
  Object.values(state.images).find((image) => image.id === ref || image.tags.includes(ref));

const imageDoc = (image) => ({
  Id: image.id,
  RepoTags: image.tags,
  Config: {
    Env: image.env,
    User: image.user,
    Volumes: image.volumes.length === 0 ? null : Object.fromEntries(image.volumes.map((path) => [path, {}])),
    Labels: image.labels,
  },
});

/** Docker parses flags up to the first non-flag and passes the rest through untouched (`exec NAME --privileged` runs `--privileged`). */
function parseFlags(args, spec) {
  const flags = [];
  let at = 0;
  for (; at < args.length; at += 1) {
    const arg = args[at];
    if (!arg.startsWith("-")) break;
    const joined = arg.startsWith("--") && arg.includes("=");
    const name = joined ? arg.slice(0, arg.indexOf("=")) : arg;
    if (spec.bool.has(name)) {
      flags.push([name, "true"]);
      continue;
    }
    if (spec.value.has(name)) {
      const value = joined ? arg.slice(arg.indexOf("=") + 1) : args[++at];
      if (value === undefined) return { error: `flag needs an argument: ${name}` };
      flags.push([name, value]);
      continue;
    }
    return { error: `unknown flag: ${name}` };
  }
  return { flags, rest: args.slice(at) };
}

const valuesOf = (parsed, name) => parsed.flags.filter(([flag]) => flag === name).map(([, value]) => value);
const labelsOf = (parsed) => Object.fromEntries(valuesOf(parsed, "--label").map((label) => splitPair(label, "=")));

const CREATE = {
  value: new Set([
    "--name",
    "--pull",
    "--label",
    "--network",
    "--cap-drop",
    "--security-opt",
    "--user",
    "--pids-limit",
    "--memory",
    "--cpus",
    "--stop-timeout",
    "--init",
    "--env",
    "--tmpfs",
    "--entrypoint",
  ]),
  bool: new Set(["--read-only"]),
};
const BUILD = { value: new Set(["--network", "--pull", "--label", "--tag"]), bool: new Set(["--no-cache"]) };
const EXEC = { value: new Set(["--workdir", "--env"]), bool: new Set(["-i"]) };
const REMOVE = { value: new Set(), bool: new Set(["--force", "--volumes", "-f", "-v"]) };
const LISTING = { value: new Set(["--filter", "--format"]), bool: new Set(["--all", "-a"]) };
const IMAGE_REMOVE = { value: new Set(), bool: new Set(["--force", "-f"]) };
const PULL = { value: new Set(), bool: new Set(["--quiet", "-q"]) };

function create(state, args) {
  const parsed = parseFlags(args, CREATE);
  if (parsed.error) return fail(parsed.error, 125);
  const [ref, ...cmd] = parsed.rest;
  const one = (flag, fallback) => valuesOf(parsed, flag).at(-1) ?? fallback;
  const name = one("--name", null);
  if (name === null) return fail("fake: --name is required", 125);
  if (state.containers[name] !== undefined)
    return fail(`Conflict. The container name "/${name}" is already in use`, 125);
  const image = ref === undefined ? undefined : findImage(state, ref);
  if (image === undefined) return fail(`Unable to find image '${ref}' locally`, 125);
  state.serial += 1;
  const container = {
    id: sha(`${name}:${state.serial}`),
    name,
    image_id: image.id,
    image_ref: ref,
    labels: labelsOf(parsed),
    network: one("--network", "bridge"),
    cap_drop: valuesOf(parsed, "--cap-drop"),
    security_opt: valuesOf(parsed, "--security-opt"),
    init: one("--init", null),
    read_only: parsed.flags.some(([flag]) => flag === "--read-only"),
    user: one("--user", ""),
    env: valuesOf(parsed, "--env"),
    tmpfs: valuesOf(parsed, "--tmpfs").map((text) => {
      const [destination, options] = splitPair(text, ":");
      return { destination, options };
    }),
    entrypoint: one("--entrypoint", null),
    cmd,
    running: false,
  };
  state.containers[name] = container;
  return out(`${container.id}\n`);
}

function build(state, args) {
  const parsed = parseFlags(args, BUILD);
  if (parsed.error) return fail(parsed.error, 125);
  const [directory] = parsed.rest;
  const tag = valuesOf(parsed, "--tag").at(-1);
  if (directory === undefined || tag === undefined) return fail("fake: build needs --tag and a context directory", 125);
  if (valuesOf(parsed, "--network").at(-1) !== "none") return fail("fake: build must run with --network none", 125);
  if (valuesOf(parsed, "--pull").at(-1) !== "false" || !parsed.flags.some(([flag]) => flag === "--no-cache")) {
    return fail("fake: build must run with --pull=false --no-cache", 125);
  }
  makeImage(state, tag, { env: state.build_env, volumes: state.build_volumes, labels: labelsOf(parsed) });
  return out();
}

function inspectDoc(state, container, hooks) {
  const image = state.images[container.image_id];
  const doc = {
    Id: container.id,
    Name: `/${container.name}`,
    State: { Status: container.running ? "running" : "created", Running: container.running },
    Config: {
      Image: container.image_ref,
      User: container.user === "" ? image.user : container.user,
      Env: [...image.env, ...container.env],
      Entrypoint: container.entrypoint === null ? null : [container.entrypoint],
      Cmd: container.cmd,
      Labels: { ...image.labels, ...container.labels },
    },
    Mounts: container.tmpfs.map((tmpfs) => ({
      Type: "tmpfs",
      Source: "",
      Destination: tmpfs.destination,
      Mode: "",
      RW: !tmpfs.options.split(",").includes("ro"),
      Propagation: "",
    })),
    HostConfig: {
      Binds: null,
      Privileged: false,
      CapAdd: null,
      CapDrop: container.cap_drop.length === 0 ? null : container.cap_drop,
      NetworkMode: container.network,
      PidMode: "",
      ReadonlyRootfs: container.read_only,
      SecurityOpt: container.security_opt.length === 0 ? null : container.security_opt,
      Devices: [],
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      VolumesFrom: null,
      Runtime: "runc",
      ...(container.init === null ? {} : { Init: container.init === "true" }),
      Tmpfs: Object.fromEntries(container.tmpfs.map((tmpfs) => [tmpfs.destination, tmpfs.options])),
    },
  };
  if (hooks.inspect) hooks.inspect(doc, { name: container.name, labels: container.labels });
  return doc;
}

function exec(state, args, stdin, hooks, clientEnv) {
  const parsed = parseFlags(args, EXEC);
  if (parsed.error) return fail(parsed.error, 125);
  const [name, ...argv] = parsed.rest;
  const container = state.containers[name];
  if (container === undefined) return fail(`Error response from daemon: No such container: ${name}`);
  if (!container.running) return fail(`Error response from daemon: container ${name} is not running`);
  if (argv.length === 0) return fail("fake: exec needs a command", 125);
  // Docker resolves a name-only `--env NAME` from the client's own environment and drops it when unset.
  const env = {};
  for (const pair of valuesOf(parsed, "--env")) {
    if (pair.includes("=")) {
      const [key, value] = splitPair(pair, "=");
      env[key] = value;
    } else if (Object.hasOwn(clientEnv, pair)) {
      env[pair] = clientEnv[pair];
    }
  }
  const call = { name, argv, stdin, workdir: valuesOf(parsed, "--workdir").at(-1) ?? null, env };
  return hooks.exec ? hooks.exec(call) : out();
}

/**
 * Runs one docker command line (the argv after the program name). `stdin` is a Buffer, a string or null; `hooks.exec`
 * answers `docker exec` (default: exit 0, no output) and `hooks.inspect` may edit a container's inspect document.
 * `clientEnv` is the docker client's environment, read only for a name-only `--env`.
 */
export function handle(state, argv, stdin = null, hooks = {}, clientEnv = {}) {
  const input = stdin === null ? null : Buffer.from(stdin);
  const args = [...argv];
  let context = null;
  if (args[0] === "--context") {
    context = args[1] ?? "";
    args.splice(0, 2);
  }
  state.calls.push({ argv: [...argv], context, stdin_b64: input === null ? null : input.toString("base64") });
  const [verb, ...rest] = args;
  if (verb === "--version") return out("Docker version 29.0.0, build fake\n");
  if (verb === "context" && rest[0] === "inspect") {
    if (!Object.hasOwn(state.contexts, rest[1])) return fail(`context "${rest[1]}": context not found`);
    return out(`${JSON.stringify([{ Name: rest[1], Endpoints: { docker: { Host: state.contexts[rest[1]] } } }])}\n`);
  }
  if (context !== null && !Object.hasOwn(state.contexts, context))
    return fail(`context "${context}": context not found`);
  if (state.daemon_down) {
    return fail("Cannot connect to the Docker daemon at unix:///var/run/omf-fake.sock. Is the docker daemon running?");
  }
  switch (verb) {
    case "info":
      return out(`${state.server_version}\n`);
    case "pull": {
      const parsed = parseFlags(rest, PULL);
      const ref = parsed.rest?.[0];
      if (parsed.error || ref === undefined || !Object.hasOwn(state.registry, ref)) {
        return fail(`Error response from daemon: manifest for ${ref} not found: manifest unknown`);
      }
      if (findImage(state, ref) === undefined) makeImage(state, ref, state.registry[ref]);
      return out(`${ref}\n`);
    }
    case "build":
      return build(state, rest);
    case "create":
      return create(state, rest);
    case "start": {
      const container = state.containers[rest[0]];
      if (container === undefined) return fail(`Error response from daemon: No such container: ${rest[0]}`);
      container.running = true;
      return out(`${rest[0]}\n`);
    }
    case "container": {
      const container = rest[0] === "inspect" ? state.containers[rest[1]] : undefined;
      return container === undefined
        ? { status: 1, stdout: "[]\n", stderr: `Error: No such container: ${rest[1]}\n` }
        : out(`${JSON.stringify([inspectDoc(state, container, hooks)])}\n`);
    }
    case "ps": {
      const parsed = parseFlags(rest, LISTING);
      if (parsed.error) return fail(parsed.error, 125);
      const wanted = valuesOf(parsed, "--filter")
        .filter((f) => f.startsWith("label="))
        .map((f) => f.slice(6));
      const lines = Object.values(state.containers)
        .filter((c) => wanted.every((w) => c.labels[w.split("=")[0]] === w.split("=")[1]))
        .map((c) => `${c.name}\t${c.labels["omf.run"] ?? ""}\t${c.labels["omf.work"] ?? ""}`);
      return out(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    }
    case "image": {
      if (rest[0] === "ls") {
        const parsed = parseFlags(rest.slice(1), LISTING);
        if (parsed.error) return fail(parsed.error, 125);
        const wanted = valuesOf(parsed, "--filter")
          .filter((f) => f.startsWith("label="))
          .map((f) => f.slice(6));
        const lines = Object.values(state.images)
          .filter((i) => wanted.every((w) => i.labels[w.split("=")[0]] === w.split("=")[1]))
          .flatMap((i) => i.tags);
        return out(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
      }
      if (rest[0] === "rm") {
        const parsed = parseFlags(rest.slice(1), IMAGE_REMOVE);
        if (parsed.error) return fail(parsed.error, 125);
        for (const id of parsed.rest) {
          for (const [key, image] of Object.entries(state.images)) {
            if (image.id === id || image.tags.includes(id)) delete state.images[key];
          }
        }
        return out(`${parsed.rest.join("\n")}\n`);
      }
      const image = rest[0] === "inspect" ? findImage(state, rest[1]) : undefined;
      return image === undefined
        ? { status: 1, stdout: "[]\n", stderr: `Error: No such image: ${rest[1]}\n` }
        : out(`${JSON.stringify([imageDoc(image)])}\n`);
    }
    case "exec":
      return exec(state, rest, input, hooks, clientEnv);
    case "rm": {
      const parsed = parseFlags(rest, REMOVE);
      if (parsed.error) return fail(parsed.error, 125);
      // `rm --force` ignores a missing container, which is what makes removal idempotent.
      for (const name of parsed.rest) delete state.containers[name];
      return out(`${parsed.rest.join("\n")}\n`);
    }
    default:
      return fail(`docker: '${verb}' is not a docker command`, 125);
  }
}
