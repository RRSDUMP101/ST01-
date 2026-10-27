"""Application entry point."""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication

from . import APP_NAME, ORG_NAME, __version__


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    app = QApplication(argv)
    app.setOrganizationName(ORG_NAME)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(__version__)
    app.setWindowIcon(QIcon(str(Path(__file__).with_name("resources") / "app.png")))

    from .ui import theme
    from .ui.main_window import MainWindow

    app.setStyle("Fusion")  # same look on Windows and macOS
    app.setFont(theme.app_font())
    app.setStyleSheet(theme.STYLE_SHEET)
    window = MainWindow()
    window.restore_session()  # the size, place and page it was left with (maximized on a laptop screen)
    window.show()
    for arg in argv[1:]:
        if arg.endswith(".rrspl"):
            window.actions.open(arg)
            break
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
