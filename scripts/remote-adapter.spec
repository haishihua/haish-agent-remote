"""Onefile adapter with the separately built, pinned PyAV native image."""
import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, copy_metadata

root = Path.cwd()
media = Path(os.environ.get('HAISH_PACKAGED_MEDIA', 'build/packaged-media/package')).resolve()
package = media / 'av'
if not (package / 'native-modules.json').is_file():
    raise SystemExit('Run scripts/build-packaged-media.py before freezing')
binaries = [(str(package / '_native.so'), 'av')]
binaries += [(str(p), 'av/.dylibs') for p in (package / '.dylibs').glob('*.dylib')]
datas = [(str(p), str(p.parent.relative_to(media))) for p in package.rglob('*') if p.is_file() and p.suffix != '.dylib' and p.name != '_native.so']
datas += [(str(media / 'native-build.json'), '.'), (str(media / 'PyAV-LICENSE.txt'), '.')]
datas += copy_metadata('haish-agent-remote') + copy_metadata('av')
hiddenimports = sum([collect_submodules(name) for name in ('uvicorn', 'aiortc', 'Quartz', 'Cocoa', 'ApplicationServices')], [])
a = Analysis([str(root / 'server/app.py')], pathex=[str(root)], binaries=binaries, datas=datas, hiddenimports=hiddenimports, excludes=['av'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name='haish-remote-adapter', debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=True)
