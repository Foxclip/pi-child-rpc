# pi-supervisor container image (3-layer docker setup).
# Hosted layers: hypervisor.mjs (host) -> supervisor.mjs (container) -> child pi (container).
# The skill scripts are MOUNTED at runtime (/opt/pi-supervisor), so updating the
# skill never requires an image rebuild. Only the pi package itself is baked in.
FROM node:24-bookworm-slim
RUN npm install -g @earendil-works/pi-coding-agent
WORKDIR /work
