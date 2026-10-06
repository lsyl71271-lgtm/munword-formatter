"""Regenerate desktop/macos/dmg-layout.DS_Store: the Finder window of the mounted disk image shows the app
on the left and the Applications folder on the right (drag to install), readme below, no toolbar.

    python3 -m pip install ds_store && python3 desktop/macos/make-dmg-layout.py

The file only describes names, positions and view options, so it does not change between versions.
"""
from pathlib import Path

from ds_store import DSStore

OUT = Path(__file__).resolve().parent / "dmg-layout.DS_Store"
OUT.unlink(missing_ok=True)
with DSStore.open(str(OUT), "w+") as store:
    store["."]["bwsp"] = {
        "WindowBounds": "{{240, 160}, {640, 440}}", "ShowStatusBar": False, "ShowToolbar": False,
        "ShowPathbar": False, "ShowSidebar": False, "ContainerShowSidebar": False, "ShowTabView": False,
        "PreviewPaneVisibility": False, "SidebarWidth": 0,
    }
    store["."]["icvp"] = {
        "viewOptionsVersion": 1, "backgroundType": 0, "arrangeBy": "none", "iconSize": 112.0, "textSize": 13.0,
        "labelOnBottom": True, "showItemInfo": False, "showIconPreview": True, "gridSpacing": 100.0,
        "gridOffsetX": 0.0, "gridOffsetY": 0.0, "scrollPositionX": 0.0, "scrollPositionY": 0.0,
    }
    store["."]["vSrn"] = ("long", 1)
    store["PKUNMUN2026.app"]["Iloc"] = (170, 180)
    store["Applications"]["Iloc"] = (470, 180)
    store["安装说明.txt"]["Iloc"] = (320, 350)
print("wrote", OUT.name, OUT.stat().st_size, "bytes")
