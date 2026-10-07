"""Separate loopback-only listener; never mounted on the FRP-facing adapter."""
import secrets
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, StrictBool


class EnableRequest(BaseModel):
    enabled: StrictBool


def create_management_app(manager, port=8767):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    csrf = secrets.token_urlsafe(32)
    hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}

    @app.middleware('http')
    async def local_only(request: Request, call_next):
        if (not request.client or request.client.host not in {'127.0.0.1', '::1', 'testclient'} or
                request.headers.get('host') not in hosts or
                any(k in request.headers for k in ('forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto')) or
                request.headers.get('sec-fetch-site') in {'cross-site', 'same-site'}):
            return JSONResponse({'detail': 'Local management only.'}, status_code=403)
        origin = request.headers.get('origin')
        if origin and origin != f'http://{request.headers.get("host")}':
            return JSONResponse({'detail': 'Local origin required.'}, status_code=403)
        if request.method != 'GET' and (origin != f'http://{request.headers.get("host")}' or
                                        not secrets.compare_digest(request.headers.get('x-desktop-csrf', ''), csrf)):
            return JSONResponse({'detail': 'Local management token required.'}, status_code=403)
        response = await call_next(request)
        response.headers['cache-control'] = 'no-store'
        response.headers['x-frame-options'] = 'DENY'
        response.headers['x-content-type-options'] = 'nosniff'
        return response

    @app.get('/')
    async def page():
        nonce = secrets.token_urlsafe(24)
        html = '''<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Haish Remote Desktop — Local management</title><body>
<h1>Haish Remote Desktop</h1><p>Only paired devices can control this computer after you enable desktop access. Default: off.</p>
<p>Requires an awake, logged-in, unlocked Apple Silicon Mac on macOS 14.8.9 or later. Lock-screen unlock is not supported.</p>
<p>System Settings → Privacy &amp; Security → Screen Recording and Accessibility. Grant both to the adapter, then retry. Permissions may require restarting the adapter.</p>
<pre id="status"></pre><button id="enable">Enable</button> <button id="disable">Disable and disconnect</button>
<button id="permissions">Request system permissions</button> <button id="retry">Refresh / retry</button>
<p id="error" role="alert"></p>
<script nonce="NONCE">
const token = 'TOKEN';
async function call(path, body) {
 try {
 const r = await fetch(path, body ? {method:'POST', headers:{'Content-Type':'application/json','X-Desktop-CSRF':token},body:JSON.stringify(body)} : {});
 if (!r.ok) throw new Error('Management request failed ('+r.status+')');
 document.getElementById('error').textContent='';
 document.getElementById('status').textContent=JSON.stringify(await r.json(),null,2);
 } catch(e) {document.getElementById('error').textContent=e.message;}
}
document.getElementById('enable').onclick=()=>call('/enabled',{enabled:true});
document.getElementById('disable').onclick=()=>call('/enabled',{enabled:false});
document.getElementById('permissions').onclick=()=>call('/permissions',{});
document.getElementById('retry').onclick=()=>call('/status');
call('/status');
</script></body></html>'''.replace('NONCE', nonce).replace('TOKEN', csrf)
        return HTMLResponse(html, headers={'content-security-policy': f"default-src 'none'; script-src 'nonce-{nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"})

    @app.get('/status')
    async def status():
        return manager.status()

    @app.get('/diagnostics')
    async def diagnostics():
        session = manager.session
        return {'input': dict(session.input_diagnostics) if session else None,
                'active': bool(session and session.active()),
                'media': manager.media_diagnostics.snapshot()}

    @app.post('/enabled')
    async def enabled(payload: EnableRequest):
        await manager.set_enabled(payload.enabled)
        return manager.status()

    @app.post('/permissions')
    async def permissions():
        manager.backend.request_permissions()
        return manager.status()

    return app
