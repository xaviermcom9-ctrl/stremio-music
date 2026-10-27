#!/bin/sh
# Throwaway Navidrome with a generated test library, for recording the navidrome source's fixtures:
#   scripts/dev/navidrome-fixture.sh <workdir>     (needs docker; joins media-stack_default)
# Then: test:sources -- --record navidrome  (with fixtures.json settings pointing at sm-nd-fixture)
set -eu
WORK="${1:?usage: navidrome-fixture.sh <workdir>}"
LIB="$WORK/music"; DATA="$WORK/data"
mkdir -p "$LIB/Test Artist A/Alpha (2019)" "$LIB/Test Artist B/Beta (2022)" "$DATA"
docker run --rm -u "$(id -u):$(id -g)" -v "$LIB:/library" stremio-music-dev:26.04 sh -c '
set -e
cd /library
ffmpeg -loglevel error -y -f lavfi -i testsrc=size=600x600:rate=1 -frames:v 1 "Test Artist A/Alpha (2019)/cover.jpg"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=600x600:rate=1 -frames:v 1 "Test Artist B/Beta (2022)/cover.jpg"
n=0; for t in "First Spark" "Second Wind" "Third Rail"; do n=$((n+1))
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$((220*n)):duration=$((20+n))" -c:a flac \
    -metadata title="$t" -metadata artist="Test Artist A" -metadata album_artist="Test Artist A" -metadata album="Alpha" \
    -metadata track="$n/3" -metadata disc=1 -metadata date=2019 -metadata genre=Rock \
    -metadata MUSICBRAINZ_ALBUMID=11111111-1111-4111-8111-111111111111 \
    "Test Artist A/Alpha (2019)/0$n - $t.flac"
done
n=0; for t in "Blue Hour" "Late Set"; do n=$((n+1))
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$((330*n)):duration=$((15+n))" -c:a libmp3lame -b:a 192k -id3v2_version 3 \
    -metadata title="$t" -metadata artist="Test Artist B" -metadata album_artist="Test Artist B" -metadata album="Beta" \
    -metadata track="$n/2" -metadata date=2022 -metadata genre=Jazz \
    "Test Artist B/Beta (2022)/0$n - $t.mp3"
done'
docker rm -f sm-nd-fixture >/dev/null 2>&1 || true
docker run -d --name sm-nd-fixture --network media-stack_default -u "$(id -u):$(id -g)" \
  -e ND_SCANSCHEDULE=0 -e ND_LOGLEVEL=warn -v "$LIB:/music:ro" -v "$DATA:/data" deluan/navidrome:0.64.2 >/dev/null
echo "waiting for Navidrome…"
for i in $(seq 1 30); do
  docker run --rm --network media-stack_default curlimages/curl:8.11.1 -sf -o /dev/null http://sm-nd-fixture:4533/ping && break; sleep 1
done
# first user becomes admin; a second, non-admin user for per-user tests
docker run --rm --network media-stack_default curlimages/curl:8.11.1 -s -X POST -H 'content-type: application/json' \
  -d '{"username":"demo","password":"demo-password"}' http://sm-nd-fixture:4533/auth/createAdmin >/dev/null
echo "Navidrome fixture at http://sm-nd-fixture:4533 (demo / demo-password)"
