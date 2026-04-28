import { fdir } from "fdir";
import { resolve } from "node:path";

export interface DirectoryResolution {
  paths: string[];
  capped: boolean;
  countBeforeCap: number;
}

export function resolveDirectory(directory: string, cap = 20): DirectoryResolution {
  const resolved = resolve(directory);

  const all = (
    new fdir()
      .withFullPaths()
      .crawlWithOptions(resolved, { maxDepth: 0, excludeSymlinks: true })
      .sync() as string[]
  ).sort((a, b) => a.localeCompare(b));

  return {
    paths: all.slice(0, cap),
    capped: all.length > cap,
    countBeforeCap: all.length,
  };
}