"""Serve the TokoTally web app on the local network.

Browsers block IndexedDB (and ES modules) on file:// pages, so the app
needs to come off an http server even on this machine. This is that
server, and it binds every interface so an iPhone on the same Wi-Fi can
open it too.

Run:   python serve.py            (port 8000)
       python serve.py 9000       (any other port)
"""

from __future__ import annotations

import http.server
import os
import socket
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler with the couple of headers this app needs."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=HERE, **kwargs)

    def end_headers(self) -> None:
        # The whole point of the dev server is to see edits immediately;
        # a cached index.html or module would hide them.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # One tidy line per request instead of the default noise.
        sys.stderr.write("  %s\n" % (fmt % args))


def lan_ip() -> str:
    """This machine's LAN address, for opening the app on a phone."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packet is actually sent; this just picks the outbound route.
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # Mimetypes for the two extensions Windows often has no registry
    # entry for; a wrong Content-Type stops modules loading outright.
    Handler.extensions_map[".js"] = "text/javascript"
    Handler.extensions_map[".webmanifest"] = "application/manifest+json"

    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("TokoTally is serving:")
    print(f"  this PC     http://localhost:{port}/")
    print(f"  your phone  http://{lan_ip()}:{port}/   (same Wi-Fi)")
    print("\nCtrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
