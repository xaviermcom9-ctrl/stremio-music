# Dev/test image matching the runtime base: Ubuntu 26.04 + distro Node 22 + ffmpeg. Used by scripts/node.
FROM ubuntu:26.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm ffmpeg ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
