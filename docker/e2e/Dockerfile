FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git gh procps \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash agent
USER agent
ENV HOME=/home/agent

RUN npm config set prefix /home/agent/.npm-global \
    && npm install -g @anthropic-ai/claude-code@2.1.331
ENV PATH="/home/agent/.local/bin:/home/agent/.npm-global/bin:${PATH}"

RUN printf '%s\n' \
    '{"firstStartTime":"2026-01-01T00:00:00.000Z",' \
    '"numStartups":10,' \
    '"installMethod":"npm",' \
    '"autoUpdates":false,' \
    '"hasCompletedOnboarding":true,' \
    '"lastOnboardingVersion":"2.1.331",' \
    '"hasTrustDialogAccepted":true,' \
    '"hasCompletedProjectOnboarding":true,' \
    '"customApiKeyResponses":{"approved":["e2e-test-key"],"rejected":[]},' \
    '"projects":{"/home/agent/work":{"hasTrustDialogAccepted":true,"hasTrustDialogHooksAccepted":true,"hasCompletedProjectOnboarding":true}}}' \
    > /home/agent/.claude.json

RUN mkdir -p /home/agent/.local/bin /home/agent/work \
    && ln -sf /workspace/bin/cccm.js /home/agent/.local/bin/cccm \
    && git -C /home/agent/work init -q

WORKDIR /workspace
