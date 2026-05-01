/**
 * Special/priority files — comprehensive list of important config files
 * that should always be included in repo maps.
 *
 * Ported from Aider's special.py (aider/special.py).
 * These files are prepended to ranked output so they always appear
 * in the repo map regardless of PageRank score.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

const ROOT_IMPORTANT_FILES = [
  // Version Control
  ".gitignore",
  ".gitattributes",
  ".gitmodules",

  // Documentation
  "README",
  "README.md",
  "README.txt",
  "README.rst",
  "CONTRIBUTING",
  "CONTRIBUTING.md",
  "CONTRIBUTING.txt",
  "CONTRIBUTING.rst",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "CHANGELOG",
  "CHANGELOG.md",
  "CHANGELOG.txt",
  "CHANGELOG.rst",
  "SECURITY",
  "SECURITY.md",
  "SECURITY.txt",
  "CODEOWNERS",

  // Package Management and Dependencies
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "build.sbt",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "mix.exs",
  "rebar.config",
  "project.clj",
  "Podfile",
  "Cartfile",
  "dub.json",
  "dub.sdl",

  // Configuration and Settings
  ".env",
  ".env.example",
  ".editorconfig",
  "tsconfig.json",
  "jsconfig.json",
  ".babelrc",
  "babel.config.js",
  ".eslintrc",
  ".eslintignore",
  ".prettierrc",
  ".stylelintrc",
  "tslint.json",
  ".pylintrc",
  ".flake8",
  ".rubocop.yml",
  ".scalafmt.conf",
  ".dockerignore",
  ".gitpod.yml",
  "sonar-project.properties",
  "renovate.json",
  "dependabot.yml",
  ".pre-commit-config.yaml",
  "mypy.ini",
  "tox.ini",
  ".yamllint",
  "pyrightconfig.json",

  // Build and Compilation
  "webpack.config.js",
  "rollup.config.js",
  "parcel.config.js",
  "gulpfile.js",
  "Gruntfile.js",
  "build.xml",
  "build.boot",
  "project.json",
  "build.cake",
  "MANIFEST.in",
  "Makefile",
  "CMakeLists.txt",

  // Testing
  "pytest.ini",
  "phpunit.xml",
  "karma.conf.js",
  "jest.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  "cypress.json",
  ".nycrc",
  ".nycrc.json",

  // CI/CD
  ".travis.yml",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "appveyor.yml",
  "circle.yml",
  ".circleci/config.yml",
  ".github/dependabot.yml",
  "codecov.yml",
  ".coveragerc",

  // Docker and Containers
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.override.yml",

  // Cloud and Serverless
  "serverless.yml",
  "firebase.json",
  "now.json",
  "netlify.toml",
  "vercel.json",
  "app.yaml",
  "terraform.tf",
  "main.tf",
  "cloudformation.yaml",
  "cloudformation.json",
  "ansible.cfg",
  "kubernetes.yaml",
  "k8s.yaml",

  // Database
  "schema.sql",
  "liquibase.properties",
  "flyway.conf",

  // Framework-specific
  "next.config.js",
  "next.config.ts",
  "nuxt.config.js",
  "vue.config.js",
  "angular.json",
  "gatsby-config.js",
  "gridsome.config.js",
  "svelte.config.js",

  // API Documentation
  "swagger.yaml",
  "swagger.json",
  "openapi.yaml",
  "openapi.json",

  // Development environment
  ".nvmrc",
  ".ruby-version",
  ".python-version",
  "Vagrantfile",
  ".node-version",

  // Quality and metrics
  ".codeclimate.yml",

  // Documentation site config
  "mkdocs.yml",
  "_config.yml",
  "book.toml",
  "readthedocs.yml",
  ".readthedocs.yaml",

  // Package registries
  ".npmrc",
  ".yarnrc",

  // Linting and formatting
  ".isort.cfg",
  ".markdownlint.json",
  ".markdownlint.yaml",

  // Security
  ".bandit",
  ".secrets.baseline",

  // Misc
  ".pypirc",
  ".gitkeep",
  ".npmignore",
  ".nixpacks",
  "docker-entrypoint.sh",
] as const;

/** Normalize once for fast lookup */
const NORMALIZED_IMPORTANT = new Set(
  ROOT_IMPORTANT_FILES.map((p) => normalize(p)),
);

/**
 * Check if a file path matches any known important config/root file.
 * Also detects GitHub Actions workflow files.
 */
export function isImportantFile(filePath: string): boolean {
  const normalized = normalize(filePath).replace(/\\/g, "/");
  const dirName = normalized.includes("/")
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : ".";
  const fileName = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;

  // GitHub Actions workflow files
  if (
    (dirName === normalize(".github/workflows") ||
      dirName.endsWith("/.github/workflows")) &&
    fileName.endsWith(".yml")
  ) {
    return true;
  }

  return NORMALIZED_IMPORTANT.has(normalized);
}

/**
 * Filter a list of relative file paths to return only important config files.
 * These are typically prepended to ranked repo map output.
 */
export function filterImportantFiles(filePaths: string[]): string[] {
  return filePaths.filter(isImportantFile);
}

/**
 * Discover important config files in a repo directory.
 * Returns absolute paths for files that actually exist.
 */
export function discoverImportantFiles(
  root: string,
  allFiles?: string[],
): string[] {
  if (allFiles) {
    // Fast path: filter from known files
    const relFiles = allFiles.map((f) => relative(resolve(root), f));
    return filterImportantFiles(relFiles).map((f) => join(resolve(root), f));
  }

  // Slow path: check each known important file
  const found: string[] = [];
  for (const relPath of ROOT_IMPORTANT_FILES) {
    const absPath = join(resolve(root), relPath);
    if (existsSync(absPath)) {
      found.push(absPath);
    }
  }
  return found;
}
