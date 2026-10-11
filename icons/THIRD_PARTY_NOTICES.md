# Third-party notices: skald-icons image

The `skald-icons` image contains Skald's own `extract.py` (Apache-2.0) and the
Python packages below, installed from PyPI with `pip install --no-deps`. Each
package's full licence text ships inside the image, in its `*.dist-info`
directory under `/usr/local/lib/python3.14/site-packages/`. The base image is
the official `python:3.14-slim` (Python Software Foundation License, Debian
packages under their own licences).

| Package | Version | Licence | Source |
|---|---|---|---|
| UnityPy | 1.25.4 | MIT | https://github.com/K0lb3/UnityPy |
| texture2ddecoder | 1.0.6 | MIT | https://github.com/K0lb3/texture2ddecoder |
| astc_encoder_py | 0.1.12 | MIT; bundles ARM astc-encoder, Apache-2.0 | https://github.com/K0lb3/astc-encoder-py |
| tpk_ar | 0.2.4 | MIT | https://github.com/K0lb3/tpk_ar |
| lz4 | 4.4.5 | BSD-3-Clause | https://github.com/python-lz4/python-lz4 |
| Pillow | 12.3.0 | MIT-CMU (HPND) | https://github.com/python-pillow/Pillow |
| fsspec | 2026.9.0 | BSD-3-Clause | https://github.com/fsspec/filesystem_spec |
| attrs | 26.1.0 | MIT | https://github.com/python-attrs/attrs |
| brotli | 1.2.0 | MIT | https://github.com/google/brotli |
| archspec | 0.2.6 | Apache-2.0 OR MIT | https://github.com/archspec/archspec |

Left out on purpose: `fmod_toolkit`, a UnityPy dependency whose wheel bundles
the proprietary FMOD library. It is never installed; `extract.py` replaces the
module with an empty stub because it never reads audio.

No Valheim files are part of the image. The extractor reads the operator's own
server installation at run time and writes its output to the operator's own
volume.
