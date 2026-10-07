import asyncio
import socket
import unittest
from unittest.mock import AsyncMock, patch
from server.desktop_mdns import resolve_local_candidates


class MDNSTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolves_candidate_only_and_deduplicates(self):
        sdp = 'a=ice-ufrag:phone.local\r\na=candidate:1 1 UDP 123 phone.local 5000 typ host\r\na=candidate:2 1 TCP 123 phone.local 5001 typ host\r\n'
        records = [(socket.AF_INET, socket.SOCK_DGRAM, 17, '', ('192.0.2.1', 0))]
        resolver = AsyncMock(return_value=records)
        with patch('server.desktop_mdns.sys.platform','darwin'), patch.object(asyncio.get_running_loop(),'getaddrinfo',resolver):
            result = await resolve_local_candidates(sdp)
        resolver.assert_awaited_once()
        self.assertIn('a=ice-ufrag:phone.local\r\n',result)
        self.assertEqual(result.count('192.0.2.1'),2)
        self.assertEqual(result.count('\r\n'),3)

    async def test_failure_non_mac_and_unrelated_hosts_unchanged(self):
        sdp='a=candidate:1 1 UDP 123 phone.local 5000 typ host\r\n'
        resolver=AsyncMock(side_effect=socket.gaierror())
        with patch('server.desktop_mdns.sys.platform','darwin'), patch.object(asyncio.get_running_loop(),'getaddrinfo',resolver):
            self.assertEqual(await resolve_local_candidates(sdp),sdp)
        with patch('server.desktop_mdns.sys.platform','linux'), patch.object(asyncio.get_running_loop(),'getaddrinfo',resolver):
            self.assertEqual(await resolve_local_candidates(sdp),sdp)
        resolver=AsyncMock()
        with patch('server.desktop_mdns.sys.platform','darwin'), patch.object(asyncio.get_running_loop(),'getaddrinfo',resolver):
            self.assertEqual(await resolve_local_candidates(sdp.replace('phone.local','example.com')),sdp.replace('phone.local','example.com'))
        resolver.assert_not_awaited()

    async def test_lookup_timeout_preserves_offer(self):
        sdp='a=candidate:1 1 UDP 123 phone.local 5000 typ host\n'
        async def blocked(*args,**kwargs):await asyncio.Event().wait()
        with patch('server.desktop_mdns.sys.platform','darwin'), patch.object(asyncio.get_running_loop(),'getaddrinfo',blocked):
            self.assertEqual(await asyncio.wait_for(resolve_local_candidates(sdp),1.5),sdp)
