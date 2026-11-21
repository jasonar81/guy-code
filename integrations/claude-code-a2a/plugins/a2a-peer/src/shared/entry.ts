/**
 * "Am I the script node was started with?" for the bundled entry points.
 *
 * Each of dist/daemon.js, dist/mcp.js, dist/hook.js and dist/cli.js both
 * exports its logic (the tests import it) and runs `main()` when launched.
 * The check matches the script's final path segment on EITHER separator by
 * hand: node:path `basename` is platform-specific, and that exact mistake
 * broke Linux and macOS CI in v1.10.0.
 */
export function isEntry(name: string): boolean {
  const script = String(process.argv[1] ?? '');
  const last = script.split(/[\\/]/).pop() ?? '';
  return last === `${name}.js` || last === `${name}.cjs`;
}
