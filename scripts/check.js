// Fast static check used by CI and before a release:  npm run check
//   every JavaScript file parses,
//   no module in src/ or scripts/ imports a name it never uses,
//   package.json and the newest CHANGELOG entry agree on the version.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "data"].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

// The names a file imports, as [localName, statementText]
export function importedNames(source) {
  const found = [];
  const re = /^import\s+([^;]*?)\s+from\s+["'][^"']+["'];?\s*$/gm;
  let m;
  while ((m = re.exec(source))) {
    const clause = m[1];
    const statement = m[0];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        const local = part.split(/\s+as\s+/).pop().trim();
        found.push([local, statement]);
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      if (token === "*" || token === "as") continue;
      found.push([token, statement]);
    }
  }
  return found;
}

export function unusedImports(source) {
  const unused = [];
  for (const [name, statement] of importedNames(source)) {
    const body = source.replace(statement, "");
    // A name counts as used when it appears as a word, not as a property (a.name), but a spread (...name) is a use
    if (!new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${name.replace(/\$/g, "\\$")}($|[^\\w$])`).test(body)) unused.push(name);
  }
  return unused;
}

export function checkAll() {
  const problems = [];
  const files = walk(root);
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) problems.push(`${path.relative(root, file)}: ${result.stderr.trim().split("\n")[0]}`);
  }
  for (const file of files.filter((f) => /[\\/](src|scripts)[\\/]/.test(f))) {
    const unused = unusedImports(readFileSync(file, "utf8"));
    if (unused.length) problems.push(`${path.relative(root, file)}: unused import ${unused.join(", ")}`);
  }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const latest = /^## (\d+\.\d+\.\d+(?:-[\w.]+)?)/m.exec(changelog)?.[1];
  if (latest !== pkg.version) problems.push(`package.json says ${pkg.version} but the newest CHANGELOG entry is ${latest}`);
  return { problems, files: files.length, version: pkg.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, files, version } = checkAll();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`Checked ${files} files, version ${version}.`);
}
