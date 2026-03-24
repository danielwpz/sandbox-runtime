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
