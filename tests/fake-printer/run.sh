#!/bin/sh
# Start the fake printer and its RTSPS camera sidecar; print the address.
set -e
cd "$(dirname "$0")"
docker build -q -t fake-bambu . >/dev/null
docker rm -f fake-printer fake-printer-rtsp >/dev/null 2>&1 || true
docker run -d --name fake-printer fake-bambu >/dev/null
certs=$(mktemp -d)
docker cp fake-printer:/etc/fake/server.crt "$certs/" && docker cp fake-printer:/etc/fake/server.key "$certs/"
chmod 644 "$certs"/*
docker run -d --name fake-printer-rtsp --network container:fake-printer \
  -v "$PWD/mediamtx.yml:/mediamtx.yml:ro" -v "$certs:/certs:ro" \
  bluenviron/mediamtx:latest-ffmpeg >/dev/null
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' fake-printer
