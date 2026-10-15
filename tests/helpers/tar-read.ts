/** One entry of a ustar archive; the prefix field is joined back onto the name and `mode` is the octal permission field. */
export interface TarItem {
  path: string;
  type: "file" | "symlink" | "dir";
  mode: number;
  linkName: string;
  data: Buffer;
}

const field = (block: Buffer, start: number, length: number): string =>
  block.toString("utf8", start, start + length).split("\0")[0] ?? "";

/** A minimal ustar reader (what `tarOfEntries` writes), so a tarball assertion does not depend on the host `tar`. */
export function readTar(tar: Buffer): TarItem[] {
  const items: TarItem[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    const size = Number.parseInt(field(block, 124, 12).trim(), 8);
    const flag = String.fromCharCode(block[156] ?? 0);
    items.push({
      path: prefix === "" ? name : `${prefix}/${name}`,
      type: flag === "2" ? "symlink" : flag === "5" ? "dir" : "file",
      mode: Number.parseInt(field(block, 100, 8).trim(), 8),
      linkName: field(block, 157, 100),
      data: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return items;
}
