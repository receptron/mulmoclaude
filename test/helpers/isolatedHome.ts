// Points HOME / USERPROFILE at a test's temp folder so `workspacePath` resolves under it. A set
// MULMOCLAUDE_WORKSPACE_PATH wins over HOME, which would aim the test's writes and deletes at a real
// workspace, so it is cleared too. Call before importing anything that reads `workspacePath`; the
// returned function puts all three back.
const ISOLATED_VARIABLES = ["HOME", "USERPROFILE", "MULMOCLAUDE_WORKSPACE_PATH"] as const;

export function isolateHome(tmpRoot: string): () => void {
  const saved = ISOLATED_VARIABLES.map((name) => [name, process.env[name]] as const);
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  delete process.env.MULMOCLAUDE_WORKSPACE_PATH;
  return () =>
    saved.forEach(([name, value]) => {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    });
}
