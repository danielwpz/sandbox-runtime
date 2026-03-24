# Pokeclaw Fork Notes

## 2026-03-24

- upstream branch: `origin/main`
- upstream base: `62e61c0e749bf8433d23b9e6bebca88fb594ca18`
- local branch: `pokeclaw/fork`
- local commit: `0e0eea0953d8840ed171d092161f9b123876431f`
- change:
  - `src/utils/ripgrep.ts`
- reason:
  - replaced `node:stream/consumers` usage when reading ripgrep child
    stdout/stderr
  - fixes Bun compatibility for spawned ripgrep output reading
- validation:
  - `npm run lint:check`
  - `npm run build`
  - `npm test -- test/utils/ripgrep.test.ts`

## 2026-03-24 Issue 1: surface sandbox permission failures to Node callers

- upstream branch: `origin/main`
- upstream base: `62e61c0e749bf8433d23b9e6bebca88fb594ca18`
- local branch: `pokeclaw/permission-error`
- local commit: `worktree pending`
- change:
  - `src/index.ts`
  - `src/sandbox/sandbox-exec.ts`
  - `src/sandbox/sandbox-manager.ts`
  - `src/sandbox/sandbox-network-event-store.ts`
  - `src/sandbox/sandbox-permission-error.ts`
  - `src/sandbox/sandbox-scoped-network.ts`
  - `src/sandbox/http-proxy.ts`
  - `src/sandbox/socks-proxy.ts`
  - `test/sandbox/sandbox-exec.test.ts`
- reason:
  - added `executeSandboxedCommand()` as a Node-facing helper that can throw
    structured `SandboxPermissionError`
  - fs permission failures are parsed from macOS sandbox violation logs
  - network permission failures are collected from a per-exec scoped proxy on
    macOS so the current command can be attributed precisely
  - shell success is preserved: if the command exits `0`, no permission error is
    thrown even if earlier subcommands failed
- validation:
  - `npm run typecheck`
  - `npm run build`
  - `npm run lint:check`
  - `node POKECLAW_PROBE.mjs`
  - `npm run test:node-runtime`

## 2026-03-24 Issue 2: separate Bun test coverage from real Node proxy runtime

- upstream branch: `origin/main`
- upstream base: `62e61c0e749bf8433d23b9e6bebca88fb594ca18`
- local branch: `pokeclaw/permission-error`
- local commit: `worktree pending`
- change:
  - `package.json`
  - `src/sandbox/http-proxy.ts`
  - `test/node-runtime/network-runtime.test.mjs`
  - `test/sandbox/http-proxy.test.ts`
  - `test/sandbox/sandbox-exec.test.ts`
  - `test/sandbox/update-config.test.ts`
- reason:
  - Bun's `node:http` CONNECT server path returned `400 Bad Request` before
    `server.on('connect')` fired, so Bun could not be trusted to validate real
    proxy runtime behavior
  - CONNECT target parsing was tightened to accept Node and Bun request shapes
    when the handler is actually reached
  - proxy and network permission behavior was moved to a Node-only runtime test
    entrypoint
  - Bun keeps fast coverage for parser and non-runtime tests, while runtime
    proxy assertions now run under Node
- validation:
  - `npm run typecheck`
  - `npm run build`
  - `npm run lint:check`
  - `npm test -- test/sandbox/http-proxy.test.ts test/sandbox/sandbox-exec.test.ts test/sandbox/update-config.test.ts`
  - `npm run test:node-runtime`
