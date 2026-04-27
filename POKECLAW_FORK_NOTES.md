# Pokeclaw Fork Notes

## 2026-04-27 Issue POK-10: add write deny-only policy mode

- upstream branch: `origin/main`
- upstream base: `7a725a3df560b91b48d1c3860e8d9b16be306a1a`
- local branch: `pok-10-sandbox-write-deny-only`
- local commit: `worktree pending`
- change:
  - `src/sandbox/sandbox-config.ts`
  - `src/sandbox/sandbox-exec.ts`
  - `src/sandbox/sandbox-manager.ts`
  - `src/sandbox/sandbox-schemas.ts`
  - `src/sandbox/linux-sandbox-utils.ts`
  - `src/sandbox/macos-sandbox-utils.ts`
  - `test/config-validation.test.ts`
  - `test/sandbox/wrap-with-sandbox.test.ts`
  - `test/sandbox/writable-fs-operations.test.ts`
- reason:
  - added `filesystem.writeMode = "deny_only"` so callers can allow writes by
    default while still blocking configured deny paths and mandatory deny paths
  - keeps legacy write behavior unchanged when `writeMode` is omitted
  - enables Pokoclaw bash full-access execution to run inside a high-permission
    sandbox instead of bypassing sandbox-runtime
- validation:
  - `npm run typecheck`
  - `bun test test/config-validation.test.ts test/sandbox/wrap-with-sandbox.test.ts test/sandbox/writable-fs-operations.test.ts`

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

## 2026-03-24 Issue 3: add additive policy modes for pokeclaw permission semantics

- upstream branch: `origin/main`
- upstream base: `62e61c0e749bf8433d23b9e6bebca88fb594ca18`
- local branch: `pokeclaw/fork`
- local commit: `worktree pending`
- change:
  - `src/sandbox/sandbox-config.ts`
  - `src/sandbox/sandbox-exec.ts`
  - `src/sandbox/sandbox-manager.ts`
  - `src/sandbox/sandbox-schemas.ts`
  - `src/sandbox/sandbox-scoped-network.ts`
  - `test/config-validation.test.ts`
  - `test/node-runtime/network-runtime.test.mjs`
  - `test/sandbox/update-config.test.ts`
- reason:
  - added additive policy modes without changing default upstream behavior
  - filesystem now supports `filesystem.readMode = "allow_only"` in addition to
    the legacy `denyRead + allowRead` mode
  - network now supports `network.mode = "deny_only"` in addition to the legacy
    allowlist-first mode
  - `SandboxManager`, scoped proxy handling, and effective-config merging now
    propagate the selected mode all the way through runtime execution
  - network deny events now distinguish `blocked-by-allowlist` vs
    `blocked-by-denylist`
- validation:
  - `npm run typecheck`
  - `npm run build`
  - `npm run lint:check`
  - `npm test`
  - `npm run test:node-runtime`

## 2026-03-24 Issue 4: implement allow_only read enforcement for pokeclaw-style user roots

- upstream branch: `origin/main`
- upstream base: `62e61c0e749bf8433d23b9e6bebca88fb594ca18`
- local branch: `pokeclaw/fork`
- local commit: `worktree pending`
- change:
  - `src/sandbox/linux-sandbox-utils.ts`
  - `src/sandbox/macos-sandbox-utils.ts`
  - `test/sandbox/allow-read.test.ts`
  - `test/sandbox/wrap-with-sandbox.test.ts`
- reason:
  - `allow_only` read mode is implemented by masking protected user roots and
    binding allowed paths back in
  - this keeps upstream defaults unchanged while making pokeclaw's grant-based
    read model directly representable for HOME/workspace style paths
  - both macOS Seatbelt and Linux bubblewrap paths now recognize `allow_only`
    as an actual read restriction mode
- validation:
  - `npm run typecheck`
  - `npm run build`
  - `npm run lint:check`
  - `npm test -- test/sandbox/allow-read.test.ts test/sandbox/wrap-with-sandbox.test.ts`
  - `npm test`
