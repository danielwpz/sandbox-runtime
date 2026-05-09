#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${SANDBOX_RUNTIME_LINUX_IMAGE:-sandbox-runtime-linux-dev:bookworm}"
PLATFORM="${SANDBOX_RUNTIME_LINUX_PLATFORM:-}"
DOCKER_FLAGS="${SANDBOX_RUNTIME_LINUX_DOCKER_FLAGS:---privileged}"

if [[ -z "${PLATFORM}" ]]; then
  case "$(uname -m)" in
    arm64 | aarch64)
      PLATFORM="linux/arm64"
      ;;
    x86_64 | amd64)
      PLATFORM="linux/amd64"
      ;;
    *)
      PLATFORM="linux/arm64"
      ;;
  esac
fi

usage() {
  cat <<'EOF'
Usage: scripts/linux-docker.sh <command>

Commands:
  build          Build the reusable Linux dev/test image.
  shell          Open a Linux shell in the repository.
  test           Run build + all Bun tests + node-runtime tests.
  unit           Run sandbox-runtime unit tests.
  integration    Run real Linux sandbox integration tests.
  node-runtime   Run Node runtime tests.
  run -- <cmd>   Run an arbitrary command in the Linux container.
  clean-volumes  Remove Docker volumes used for Linux dependencies.

Environment:
  SANDBOX_RUNTIME_LINUX_PLATFORM      Default: host arch mapped to linux/arm64 or linux/amd64
  SANDBOX_RUNTIME_LINUX_IMAGE         Default: sandbox-runtime-linux-dev:bookworm
  SANDBOX_RUNTIME_LINUX_DOCKER_FLAGS  Default: --privileged
EOF
}

DOCKER_PLATFORM_ARGS=(--platform "${PLATFORM}")

build_image() {
  docker build \
    "${DOCKER_PLATFORM_ARGS[@]}" \
    -t "${IMAGE}" \
    -f "${REPO_ROOT}/.docker/linux/Dockerfile" \
    "${REPO_ROOT}"
}

run_in_container() {
  local command="$1"
  local tester_command="cd /work && ${command}"
  local escaped_tester_command
  local tty_args=(-i)
  if [[ -t 1 ]]; then
    tty_args=(-it)
  fi

  printf -v escaped_tester_command "%q" "${tester_command}"

  docker run --rm "${tty_args[@]}" \
    "${DOCKER_PLATFORM_ARGS[@]}" \
    ${DOCKER_FLAGS} \
    --user root \
    -v "${REPO_ROOT}:/work" \
    -v sandbox-runtime-linux-node-modules:/work/node_modules \
    -v sandbox-runtime-linux-npm-cache:/home/tester/.npm \
    -w /work \
    "${IMAGE}" \
    bash -lc "mkdir -p /work/node_modules /home/tester/.npm && chown -R tester:tester /work/node_modules /home/tester/.npm && su tester -c ${escaped_tester_command}"
}

ensure_image() {
  if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    build_image
  fi
}

case "${1:-}" in
  build)
    build_image
    ;;
  shell)
    ensure_image
    run_in_container "bash"
    ;;
  test)
    ensure_image
    run_in_container "npm ci && npm run build && find test -name '*.test.ts' -print | sort | while IFS= read -r test_file; do bun test \"\${test_file}\"; done && npm run test:node-runtime"
    ;;
  unit)
    ensure_image
    run_in_container "npm ci && npm run test:unit"
    ;;
  integration)
    ensure_image
    run_in_container "npm ci && npm run build && npm run test:integration"
    ;;
  node-runtime)
    ensure_image
    run_in_container "npm ci && npm run test:node-runtime"
    ;;
  run)
    shift
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    if [[ $# -eq 0 ]]; then
      usage >&2
      exit 2
    fi
    ensure_image
    run_in_container "$*"
    ;;
  clean-volumes)
    docker volume rm sandbox-runtime-linux-node-modules sandbox-runtime-linux-npm-cache
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
