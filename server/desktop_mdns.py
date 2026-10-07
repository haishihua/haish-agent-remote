"""Bounded macOS resolver fallback for WebKit's local ICE names.

The OS resolver uses the active interfaces; aioice's IPv4 multicast socket can
miss WebKit advertisements on the interface currently providing a hotspot.
Only candidate host fields are changed. Credentials/addresses are never logged.
"""
import asyncio
import ipaddress
import re
import socket
import sys

_NAME = re.compile(r'^[a-zA-Z0-9-]{1,63}\.local\.?$')


async def resolve_local_candidates(sdp):
    if sys.platform != 'darwin':
        return sdp
    lines = sdp.splitlines(keepends=True)
    hosts = set()
    for line in lines:
        fields = line.split()
        if line.startswith('a=candidate:') and len(fields) >= 8 and _NAME.fullmatch(fields[4]):
            hosts.add(fields[4])
    if not hosts or len(hosts) > 8:
        return sdp  # retain normal aioice handling of unusual/flooded offers

    async def resolve(host):
        try:
            records = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(
                host, None, family=socket.AF_UNSPEC, type=socket.SOCK_DGRAM), 1)
            # Prefer IPv4 when available; retain valid IPv6-only discovery.
            records.sort(key=lambda r: r[0] != socket.AF_INET)
            address = str(ipaddress.ip_address(records[0][4][0]))
            return host, address
        except (OSError, TimeoutError, ValueError, IndexError):
            return host, None

    resolved = dict(await asyncio.gather(*(resolve(host) for host in hosts)))
    for index, line in enumerate(lines):
        fields = line.split()
        if line.startswith('a=candidate:') and len(fields) >= 8 and resolved.get(fields[4]):
            # Preserve SDP framing; don't substitute matching strings in ufrag,
            # extensions, or other unrelated SDP attributes.
            ending = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
            fields[4] = resolved[fields[4]]
            lines[index] = ' '.join(fields) + ending
    return ''.join(lines)
