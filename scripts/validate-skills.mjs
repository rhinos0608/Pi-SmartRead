// Validates skills/<kebab-case>/SKILL.md convention. No deps.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", "skills"));
let fail = 0;
const names = new Map();

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return fm;
}

const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = d.name;
  const file = path.join(root, dir, "SKILL.md");
  const errs = [];
  if (!existsSync(file)) {
    console.log(`FAIL ${dir}: missing SKILL.md`);
    fail++;
    continue;
  }
  const raw = readFileSync(file, "utf-8");
  const fm = parseFrontmatter(raw);
  if (!fm) errs.push("missing frontmatter --- block");
  else {
    if (!fm.name?.trim()) errs.push("frontmatter name missing");
    if (!fm.description?.trim()) errs.push("frontmatter description missing");
    if (fm.name && fm.name !== dir) errs.push(`dir/name mismatch: dir=${dir} name=${fm.name}`);
    if (fm.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) errs.push("name not kebab-case");
    if (fm.name) {
      if (names.has(fm.name)) errs.push(`duplicate name (also in ${names.get(fm.name)})`);
      else names.set(fm.name, dir);
    }
  }
  for (const section of ["## WHEN", "## WHEN NOT", "## EXAMPLE"]) {
    if (!raw.includes(section)) errs.push(`missing ${section} section`);
  }
  if (errs.length) {
    console.log(`FAIL ${dir}:\n  - ${errs.join("\n  - ")}`);
    fail++;
  } else {
    console.log(`ok ${dir}`);
  }
}
console.log(fail ? `\n${fail} skill(s) failed` : `\nAll ${dirs.length} skills pass`);
process.exit(fail ? 1 : 0);
