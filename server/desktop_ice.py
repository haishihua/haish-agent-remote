"""Private persistent ICE configuration; credentials are never returned by status."""
import json
import os
from pathlib import Path
import stat

from fastapi import HTTPException


def turn_settings(data_dir=None, env=None):
    env = os.environ if env is None else env
    if 'HAISH_DESKTOP_TURN_URLS' in env or 'HAISH_DESKTOP_TURN_SECRET' in env:
        urls = env.get('HAISH_DESKTOP_TURN_URLS', '')
        secret = env.get('HAISH_DESKTOP_TURN_SECRET', '')
    else:
        root = Path(data_dir or env.get('HAISH_REMOTE_DATA_DIR', '~/.haish-remote')).expanduser()
        path = root / 'desktop-turn.json'
        try:
            with path.open() as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                    raise ValueError('Unsafe configuration permissions')
                config = json.load(handle)
            urls, secret = config.get('urls', []), config.get('secret', '')
        except FileNotFoundError:
            return [], ''
        except (OSError, ValueError, AttributeError, TypeError):
            raise HTTPException(503, 'Invalid private TURN configuration on the computer.') from None
    if isinstance(urls, str):
        urls = [u.strip() for u in urls.split(',') if u.strip()]
    if not urls or not secret:
        return [], ''
    if (not isinstance(urls, list) or not isinstance(secret, str) or
            not all(isinstance(u, str) and u.startswith(('turn:', 'turns:')) and
                    '@' not in u and not any(c.isspace() for c in u) for u in urls)):
        raise HTTPException(503, 'Invalid TURN configuration on the computer.')
    return urls, secret


def turn_configured(data_dir=None):
    try:
        urls, secret = turn_settings(data_dir)
        return bool(urls and secret)
    except HTTPException:
        return False
