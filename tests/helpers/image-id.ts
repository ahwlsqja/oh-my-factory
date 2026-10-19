import { createHash } from "node:crypto";

/** A stable image id for a round image the memory doubles list by name only, as a daemon would report one. */
export const imageIdFor = (name: string): string => `sha256:${createHash("sha256").update(name).digest("hex")}`;
