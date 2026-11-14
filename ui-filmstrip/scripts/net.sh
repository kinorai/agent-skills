#!/bin/sh
# Puts Toxiproxy between the browser and the app, so record.mjs's `net` can
# hang, cut or slow the network at the TCP level (the browser's navigation
# preload included, which Playwright's routing can't hold).
# Usage: net.sh start <listenPort> <appPort> | net.sh stop
set -e
case "$1" in
  start)
    docker run -d --rm --name ui-filmstrip-toxi --network host ghcr.io/shopify/toxiproxy:latest >/dev/null
    until curl -sf localhost:8474/version >/dev/null; do sleep 1; done
    curl -sf -XPOST localhost:8474/proxies \
      -d "{\"name\":\"app\",\"listen\":\"127.0.0.1:$2\",\"upstream\":\"127.0.0.1:$3\"}" >/dev/null
    echo "app on http://localhost:$2 -> :$3 (Toxiproxy API :8474)" ;;
  stop) docker stop ui-filmstrip-toxi >/dev/null ;;
  *) echo "usage: $0 start <listenPort> <appPort> | stop" >&2; exit 1 ;;
esac
