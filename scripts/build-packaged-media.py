#!/usr/bin/env python3
"""Build pinned PyAV into one Mach-O, retaining its wheel's FFmpeg libraries.

Only used by the adapter freezer. No dependency installed/replaced in this
interpreter. Public source archives are SHA256 checked before safe extraction.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import tarfile
import urllib.request

SOURCES = {
    'av-16.1.0.tar.gz': ('https://files.pythonhosted.org/packages/source/a/av/av-16.1.0.tar.gz', 'a094b4fd87a3721dacf02794d3d2c82b8d712c85b9534437e82a8a978c175ffd'),
    'ffmpeg-8.0.tar.xz': ('https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz', 'b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e'),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', default='build/packaged-media')
    parser.add_argument('--archives', help='Optional directory with the pinned source archives')
    args = parser.parse_args()
    if sys.platform != 'darwin' or os.uname().machine != 'arm64':
        raise SystemExit('Packaged media requires macOS arm64')
    for package, expected in [('av', '16.1.0'), ('Cython', '3.1.4')]:
        if importlib.metadata.version(package) != expected:
            raise SystemExit(f'Expected {package} {expected}')
    work = Path(args.work_dir).resolve()
    work.mkdir(parents=True, exist_ok=True)
    extracted = work / 'sources'
    extracted.mkdir(exist_ok=True)
    archive_dir = Path(args.archives).resolve() if args.archives else work / 'archives'
    archive_dir.mkdir(parents=True, exist_ok=True)
    for filename, (url, digest) in SOURCES.items():
        archive = archive_dir / filename
        if not archive.exists():
            with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as output:
                shutil.copyfileobj(response, output)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            raise SystemExit(f'Source checksum mismatch: {filename}')
        with tarfile.open(archive) as source:
            source.extractall(extracted, filter='data')
    src = extracted / 'av-16.1.0'
    headers = extracted / 'ffmpeg-8.0'
    # Generate the public version/config headers only; FFmpeg itself is NOT
    # built. Its ABI comes from the pinned upstream PyAV wheel below.
    with (work / 'headers.log').open('w') as log:
        subprocess.run(['./configure', '--disable-everything', '--disable-programs', '--disable-doc', '--disable-x86asm'], cwd=headers, stdout=log, stderr=subprocess.STDOUT, check=True)
    dist = importlib.metadata.distribution('av')
    original = Path(dist.locate_file('av')).resolve()
    libs = original / '.dylibs'
    if not libs.is_dir():
        raise SystemExit('Expected the macOS PyAV wheel with bundled FFmpeg')
    basenames = ('avformat', 'avcodec', 'avdevice', 'avutil', 'avfilter', 'swscale', 'swresample')
    libfiles = [next(libs.glob('lib' + name + '.*.dylib')) for name in basenames]
    expected_majors = {'avformat': 62, 'avcodec': 62, 'avdevice': 62, 'avutil': 60, 'avfilter': 11, 'swscale': 9, 'swresample': 6}
    for name, lib in zip(basenames, libfiles):
        if lib.name.split('.')[1] != str(expected_majors[name]):
            raise SystemExit('Unexpected FFmpeg ABI in PyAV wheel')
    from Cython.Build import cythonize
    from setuptools import Extension
    os.chdir(src)
    extensions = []
    for p in sorted(Path('av').rglob('*')):
        if p.suffix not in ('.py', '.pyx') or p.name in ('__init__.py', '__main__.py', 'about.py', 'datasets.py'):
            continue
        name = '.'.join(p.with_suffix('').parts)
        sources = [str(p)]
        if name == 'av.filter.loudnorm':
            sources.append('av/filter/loudnorm_impl.c')
        extensions.extend(cythonize(Extension(name, sources=sources), build_dir=str(work / 'generated'), include_path=['include'], compiler_directives={'c_string_type': 'str', 'c_string_encoding': 'ascii', 'embedsignature': True, 'binding': False, 'language_level': 3, 'freethreading_compatible': True}, quiet=True))
    if len(extensions) != 49:
        raise SystemExit('Unexpected PyAV module inventory')
    objects = work / 'objects'
    objects.mkdir(exist_ok=True)
    target = '14.0'
    includes = ['-I' + sysconfig.get_path('include'), '-I' + str(headers), '-I' + str(src / 'av/filter')]

    def compile_module(extension):
        leaf = extension.name.rsplit('.', 1)[-1]
        entry = 'haish_' + extension.name.replace('.', '_')
        outputs = []
        for index, filename in enumerate(extension.sources):
            path = Path(filename)
            if not path.is_absolute():
                path = src / path
            text = path.read_text()
            # Unique exported symbols are necessary: frame/format/context etc.
            # have duplicate leaf names. All qualified Cython names stay intact.
            text = text.replace('PyInit_' + leaf, 'PyInit_' + entry)
            source = objects / f'{entry}-{index}.c'
            source.write_text(text)
            obj = source.with_suffix('.o')
            with source.with_suffix('.log').open('w') as log:
                subprocess.run(['clang', '-c', '-O2', '-fPIC', '-fvisibility=hidden', '-mmacosx-version-min=' + target, *includes, str(source), '-o', str(obj)], stdout=log, stderr=subprocess.STDOUT, check=True)
            outputs.append(str(obj))
        return extension.name, entry, outputs

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(compile_module, extensions))
    output = work / 'package'
    output.mkdir(exist_ok=True)
    package = output / 'av'
    shutil.copytree(src / 'av', package, dirs_exist_ok=True)
    # Keep only Python package stubs/docs, not Cython source masquerading as
    # runtime .py implementations. No old native image remains in the package.
    for p in package.rglob('*'):
        if p.is_file() and p.suffix in ('.c', '.pyx', '.pxd', '.so'):
            p.unlink()
        elif p.is_file() and p.suffix == '.py' and p.name not in ('__init__.py', '__main__.py', 'about.py', 'datasets.py'):
            p.unlink()
    shutil.copytree(libs, package / '.dylibs', dirs_exist_ok=True)
    image = package / '_native.so'
    subprocess.run(['clang', '-shared', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=' + target, *[obj for _, _, objs in records for obj in objs], *map(str, libfiles), '-o', str(image)], check=True)
    for lib in libfiles:
        install_name = subprocess.check_output(['otool', '-D', str(lib)], text=True).splitlines()[1].strip()
        subprocess.run(['install_name_tool', '-change', install_name, '@loader_path/.dylibs/' + lib.name, str(image)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', str(image)], check=True)
    subprocess.run(['codesign', '--verify', '--strict', str(image)], check=True)
    (package / 'native-modules.json').write_text(json.dumps({'schema': 1, 'version': '16.1.0', 'modules': {name: entry for name, entry, _ in records}}, sort_keys=True) + '\n')
    shutil.copy2(src / 'LICENSE.txt', output / 'PyAV-LICENSE.txt')
    provenance = {'sources': {name: digest for name, (_, digest) in SOURCES.items()}, 'cython': '3.1.4', 'av': '16.1.0', 'target': target, 'modules': len(records), 'image_sha256': hashlib.sha256(image.read_bytes()).hexdigest(), 'wheel_libraries': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in libs.glob('*.dylib')}}
    (output / 'native-build.json').write_text(json.dumps(provenance, indent=2, sort_keys=True) + '\n')
    print('Packaged media:', output, 'modules:', len(records), 'bytes:', image.stat().st_size)


if __name__ == '__main__':
    main()
