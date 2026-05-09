FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apparmor-profiles \
    bubblewrap \
    ca-certificates \
    curl \
    dnsutils \
    gcc \
    git \
    libseccomp-dev \
    netcat-openbsd \
    openssh-client \
    procps \
    python3 \
    ripgrep \
    socat \
    wget \
    zsh \
  && rm -rf /var/lib/apt/lists/* \
  && chmod u+s /usr/bin/bwrap

RUN npm install -g bun@1.3.1 \
  && useradd -m -s /bin/bash tester \
  && mkdir -p /work \
  && chown tester:tester /work

USER tester
WORKDIR /work

ENV npm_config_cache=/home/tester/.npm
