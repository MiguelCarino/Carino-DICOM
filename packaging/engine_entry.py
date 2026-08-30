"""PyInstaller entry point — runs the Carino DICOM CLI as a frozen binary.

    pacs-engine serve --host H --port P

behaves exactly like `python -m pacs serve ...`. The Electron desktop app
launches this binary in packaged builds instead of requiring a Python install.

Which DICOM services come up is decided by the enabled flags in the config the
setup chooser writes; --receive/--watch and friends remain explicit overrides.
"""

import sys

from pacs.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
