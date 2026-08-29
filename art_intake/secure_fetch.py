"""Bounded HTTPS fetch helper for Windows profiles with broken Schannel.

The PowerShell server validates URLs too. This helper independently validates
every DNS answer and redirect, writes at most the requested byte limit, and
uses only Python's standard library. Its request JSON is a local temporary file
so API keys never appear in the process command line.
"""

from __future__ import annotations

import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def validate_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Use an absolute http or https URL.")
    if parsed.username or parsed.password:
        raise ValueError("URL credentials are not allowed.")
    addresses = {
        entry[4][0]
        for entry in socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    }
    if not addresses:
        raise ValueError("The URL host did not resolve.")
    for text in addresses:
        address = ipaddress.ip_address(text)
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise ValueError("Local and private-network URLs are not allowed.")
    return urllib.parse.urlunsplit(parsed)


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):  # noqa: ANN001
        redirects = int(getattr(request, "art_desk_redirects", 0)) + 1
        if redirects > 5:
            raise urllib.error.HTTPError(new_url, code, "Too many redirects", headers, fp)
        target = validate_url(urllib.parse.urljoin(request.full_url, new_url))
        redirected = super().redirect_request(request, fp, code, message, headers, target)
        if redirected is not None:
            redirected.art_desk_redirects = redirects
        return redirected


def fetch(request_path: Path) -> dict[str, object]:
    specification = json.loads(request_path.read_text(encoding="utf-8"))
    url = validate_url(str(specification["url"]))
    output = Path(str(specification["output"])).resolve()
    maximum = int(specification.get("max_bytes", 25 * 1024 * 1024))
    if maximum < 1 or maximum > 64 * 1024 * 1024:
        raise ValueError("Invalid response size limit.")
    headers = {str(key): str(value) for key, value in dict(specification.get("headers", {})).items()}
    headers.setdefault("User-Agent", "MarvelSnapArtDesk/2.0 (local personal review tool)")
    request = urllib.request.Request(url, headers=headers, method="GET")
    opener = urllib.request.build_opener(SafeRedirectHandler())

    with opener.open(request, timeout=30) as response, output.open("wb") as destination:
        length_header = response.headers.get("Content-Length")
        if length_header and int(length_header) > maximum:
            raise ValueError(f"Response exceeds the {maximum}-byte limit.")
        total = 0
        while True:
            chunk = response.read(min(128 * 1024, maximum - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise ValueError(f"Response exceeds the {maximum}-byte limit.")
            destination.write(chunk)
        return {
            "ok": True,
            "status": int(getattr(response, "status", 200)),
            "final_url": response.geturl(),
            "content_type": response.headers.get_content_type(),
            "length": total,
        }


def main() -> int:
    if len(sys.argv) != 2:
        print("Expected one request JSON path.", file=sys.stderr)
        return 2
    try:
        result = fetch(Path(sys.argv[1]).resolve())
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:  # concise error is returned to the local UI
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
