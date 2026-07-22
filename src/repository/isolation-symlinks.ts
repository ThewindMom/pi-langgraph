import { readlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export async function assertContainedSymlinks(
  root: string,
  entries: ReadonlyMap<string, Readonly<{ kind: string }>>,
  fail: (path: string) => Error,
): Promise<void> {
  const resolvedRoot = resolve(root);
  for (const [path, entry] of entries) {
    if (entry.kind !== "symlink") continue;
    const target = resolve(dirname(join(resolvedRoot, path)), await readlink(join(resolvedRoot, path)));
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) throw fail(path);
  }
}
