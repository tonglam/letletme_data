import { describe, expect, test } from 'bun:test';

const SOURCE_ROOT = new URL('../../src/', import.meta.url).pathname;

type Module = {
  readonly path: string;
  readonly imports: readonly { path: string; runtime: boolean }[];
};

function sourceFiles(): string[] {
  return Array.from(new Bun.Glob('**/*.ts').scanSync({ cwd: SOURCE_ROOT, absolute: true })).sort();
}

function resolveImport(from: string, specifier: string): string | null {
  const base = new URL(specifier, new URL(`file://${from}`)).pathname;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((candidate) => Bun.file(candidate).size > 0) ?? null;
}

async function modules(): Promise<Module[]> {
  const importPattern =
    /((?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  return Promise.all(
    sourceFiles().map(async (path) => {
      const text = await Bun.file(path).text();
      const imports: { path: string; runtime: boolean }[] = [];
      for (const match of text.matchAll(importPattern)) {
        const resolved = resolveImport(path, match[2]);
        if (!resolved) continue;
        const declaration = match[0];
        imports.push({
          path: resolved,
          runtime: !/^(?:import|export)\s+type\s/.test(declaration),
        });
      }
      return { path, imports };
    }),
  );
}

function relativePath(path: string): string {
  return path.startsWith(SOURCE_ROOT) ? path.slice(SOURCE_ROOT.length) : path;
}

function stronglyConnectedComponents(graph: Map<string, Set<string>>): string[][] {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const child of graph.get(node) ?? []) {
      if (!indexes.has(child)) {
        visit(child);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(child)!));
      } else if (onStack.has(child)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indexes.get(child)!));
      }
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  };

  for (const node of graph.keys()) if (!indexes.has(node)) visit(node);
  return components;
}

describe('architecture boundaries', () => {
  test('domain has no runtime infrastructure imports', async () => {
    const graphModules = await modules();
    const violations = graphModules.flatMap((module) => {
      if (!relativePath(module.path).startsWith('domain/')) return [];
      return module.imports
        .filter(
          ({ path, runtime }) =>
            runtime && /\/(repositories|services|api|workers|clients|cache|db)\//.test(path),
        )
        .map(({ path }) => `${relativePath(module.path)} -> ${relativePath(path)}`);
    });
    expect(violations).toEqual([]);
  });

  test('repositories do not depend on service, API, worker or job orchestration', async () => {
    const graphModules = await modules();
    const violations = graphModules.flatMap((module) => {
      if (!relativePath(module.path).startsWith('repositories/')) return [];
      return module.imports
        .filter(({ path, runtime }) => runtime && /\/(services|api|workers|jobs)\//.test(path))
        .map(({ path }) => `${relativePath(module.path)} -> ${relativePath(path)}`);
    });
    expect(violations).toEqual([]);
  });

  test('services do not depend on API handlers', async () => {
    const graphModules = await modules();
    const violations = graphModules.flatMap((module) => {
      if (!relativePath(module.path).startsWith('services/')) return [];
      return module.imports
        .filter(({ path, runtime }) => runtime && /\/api\//.test(path))
        .map(({ path }) => `${relativePath(module.path)} -> ${relativePath(path)}`);
    });
    expect(violations).toEqual([]);
  });

  test('manager-live orchestration reaches infrastructure only through injected ports', async () => {
    const graphModules = await modules();
    const violations = graphModules.flatMap((module) => {
      if (relativePath(module.path) !== 'services/manager-live/orchestration.ts') return [];
      return module.imports
        .filter(
          ({ path, runtime }) =>
            runtime && /\/(repositories|clients|cache|db|queues|workers|jobs)\//.test(path),
        )
        .map(({ path }) => `${relativePath(module.path)} -> ${relativePath(path)}`);
    });
    expect(violations).toEqual([]);
  });

  test('runtime import graph has no strongly connected components', async () => {
    const graphModules = await modules();
    const graph = new Map<string, Set<string>>();
    for (const module of graphModules) {
      const key = relativePath(module.path);
      graph.set(
        key,
        new Set(
          module.imports.filter((item) => item.runtime).map((item) => relativePath(item.path)),
        ),
      );
    }
    const cycles = stronglyConnectedComponents(graph)
      .filter((component) => component.length > 1)
      .map((component) => component.sort());
    expect(cycles).toEqual([]);
  });
});
