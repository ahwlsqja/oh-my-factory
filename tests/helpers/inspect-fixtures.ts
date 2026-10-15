// Fixtures for the isolation tests: one `docker inspect` document of a healthy implementer container, and
// (added with the evaluator) the golden values M3g pins for that stage. Every path is invented. Nothing
// here reads or writes the real home.
export const HOME = "/home/dev";
export const OMF_HOME = "/home/dev/.omf";
export const WORKTREE = "/home/dev/.omf/projects/p-1/worktrees/w-0123456789ab";
export const SCENARIOS = "/home/dev/.omf/projects/p-1/scenarios/s-1";

export type InspectDoc = {
  Id: string;
  Config: Record<string, unknown>;
  Mounts: unknown[];
  HostConfig: Record<string, unknown>;
};

/** A fresh copy on every call, so a test may mutate it. List fields use null where Docker prints null. */
export function goldenInspect(): InspectDoc {
  return {
    Id: "c0ffee",
    Config: {
      Image: "omf-implementer:1",
      User: "10001:10001",
      Env: ["PATH=/usr/bin", "HOME=/home/agent", "OMF_STAGE=implementer"],
    },
    Mounts: [
      { Type: "bind", Source: WORKTREE, Destination: "/work", Mode: "rw", RW: true, Propagation: "rprivate" },
      { Type: "bind", Source: SCENARIOS, Destination: "/scenarios", Mode: "ro", RW: false, Propagation: "rprivate" },
      { Type: "tmpfs", Source: "", Destination: "/tmp", Mode: "", RW: true },
    ],
    HostConfig: {
      Binds: [`${WORKTREE}:/work:rw`, `${SCENARIOS}:/scenarios:ro`],
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      NetworkMode: "none",
      PidMode: "",
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Devices: [],
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      VolumesFrom: null,
      Sysctls: {},
      Runtime: "runc",
    },
  };
}
