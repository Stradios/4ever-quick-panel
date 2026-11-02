# 4ever Quick Panel

A small add-on for GNOME Shell that gives the quick settings panel (network, volume, brightness and the other
tiles) a rounder, accent-colored look, and lets you hide the tiles and sliders you never use.
It is a separate extension from [4ever](https://github.com/Stradios/4ever-extension) on purpose: if a GNOME update
ever breaks it, the panel simply goes back to GNOME's own look and your taskbar keeps working.

> **AI disclaimer:** This extension was created with the help of Claude, an AI assistant made by Anthropic.
> The design, testing and direction are by the repository owner. Review the code before relying on it.

<!-- Add a screenshot: put an image at screenshots/preview.png (or change the path below). -->
![4ever Quick Panel preview](screenshots/preview.png)

Works with GNOME Shell 50 and 51. It is not tied to 4ever and also works on its own.

## Features

- Rounded panel with tiles that fill with an accent color when on (orange by default, with a color palette and
  a custom color picker).
- Follows the system light or dark style.
- Adjustable opacity and corner radius.
- Switches to hide any tile or slider. The list is read from the panel itself, so it matches your computer
  (for example the brightness slider on a laptop).
- Optional name and picture at the top, and date and time at the bottom.
- Experimental: three tiles per row instead of two.
- If anything goes wrong while loading, it undoes its changes and leaves GNOME's panel alone.

## Install

```sh
./build.sh
gnome-extensions install --force 4ever-quick-panel.zip
```

Log out and back in (on Wayland, new extensions load at login), then enable it:

```sh
gnome-extensions enable 4ever-quick-panel@4ever-quick-panel.stradios
```

Open the settings from the extension manager.

## Upcoming

- A Shortcuts row (your own apps and links) in the panel.
- Pages inside the panel, such as a theme page with accent swatches.

These are plans, not promises.

## Notes

- The panel is part of GNOME Shell's own code and is not a stable interface. This add-on checks what it finds
  before changing anything.
- Hiding a tile only hides it. The service behind it keeps running.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
