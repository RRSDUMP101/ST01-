import sys

if len(sys.argv) > 1 and sys.argv[1] == "--cad-import":
    # The built program started by itself to read one STEP / IGES file (core.cad_import.read_cad_isolated):
    # no window, no Qt. A program built as a window has no standard output on Windows.
    import os

    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))  # noqa: SIM115 - for the life of the process
        else:  # they go to a file of the program that started this one: every line at once, a crash must not take it
            try:
                getattr(sys, name).reconfigure(line_buffering=True)
            except (AttributeError, ValueError):
                pass
    from partlist_studio.core.cad_import import _child

    sys.exit(_child(sys.argv[2:]))

if len(sys.argv) > 1 and sys.argv[1] == "--cad-check":  # for the test of a build: is the STEP / IGES reader in it?
    from partlist_studio.core.cad_import import have_ocp

    sys.exit(0 if have_ocp() else 3)

from partlist_studio.app import main

sys.exit(main())
