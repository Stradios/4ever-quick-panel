// SPDX-License-Identifier: GPL-3.0-or-later
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TAG = '[4ever-quick-panel]';

// Friendly names for sliders and other items that have no title of their own
const FRIENDLY_NAMES = [
    ['OutputStream', 'Volume'],
    ['InputStream', 'Microphone'],
    ['Brightness', 'Brightness'],
    ['SystemItem', 'Top row (battery, settings, lock, power)'],
];

function defer(fn) {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            fn();
        } catch (e) {
            console.error(`${TAG} ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    });
}

function mix(hex, toward, amount) {
    const parse = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const a = parse(hex);
    const b = toward === 'white' ? [255, 255, 255] : [0, 0, 0];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(', ')})`;
}

export default class FourEverQuickPanel extends Extension {
    enable() {
        this._gs = this.getSettings();
        this._signals = [];
        this._items = new Map();
        this._originalColumns = undefined;
        this._extras = [];

        const quickSettings = Main.panel.statusArea.quickSettings;
        const menu = quickSettings?.menu;
        const grid = menu?._grid;
        if (!menu || !grid) {
            // GNOME changed the panel in a way this version does not know.
            // Do nothing: the normal panel keeps working.
            console.error(`${TAG} could not find the quick settings panel; leaving it as it is`);
            return;
        }
        this._menu = menu;
        this._grid = grid;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        try {
            this._setup();
        } catch (e) {
            console.error(`${TAG} setup failed, undoing everything: ${e.message}`);
            this._teardown();
        }
    }

    disable() {
        this._teardown();
        this._gs = null;
        this._iface = null;
    }

    _connect(obj, name, callback) {
        this._signals.push([obj, obj.connect(name, callback)]);
    }

    _setup() {
        this._menu.actor.add_style_class_name('fqp');
        this._menu.box.add_style_class_name('fqp');

        this._connect(this._iface, 'changed::color-scheme', () => this._applyLook());
        this._connect(this._gs, 'changed', (_s, key) => this._onSettingChanged(key));
        this._connect(this._menu, 'open-state-changed', (_m, open) => this._onOpen(open));
        this._connect(this._grid, 'child-added', () => this._queueScan());

        this._applyLook();
        this._buildExtras();
        this._scan();
        this._applyColumns();
    }

    _teardown() {
        for (const [obj, id] of this._signals ?? []) {
            try {
                obj.disconnect(id);
            } catch (_e) {
                // object is gone
            }
        }
        this._signals = [];

        if (this._scanId) {
            GLib.source_remove(this._scanId);
            this._scanId = 0;
        }
        this._stopClock();
        this._teardownExtras();

        // Show everything we hid again
        for (const [child, info] of this._items ?? []) {
            if (info.hidden) {
                try {
                    child.disconnect(info.sig);
                    child.visible = info.gnomeVisible;
                } catch (_e) {
                    // widget is gone
                }
            }
        }
        this._items = new Map();

        try {
            this._restoreColumns();
        } catch (_e) {
            // layout is gone
        }
        this._unloadStyle();

        if (this._menu) {
            this._menu.actor.remove_style_class_name('fqp');
            this._menu.actor.remove_style_class_name('fqp-light');
            this._menu.box.remove_style_class_name('fqp');
            this._menu.box.remove_style_class_name('fqp-light');
            this._menu.box.style = '';
        }
        this._menu = null;
        this._grid = null;
    }

    _onSettingChanged(key) {
        switch (key) {
        case 'accent-color':
        case 'opacity':
        case 'corner-radius':
            this._applyLook();
            break;
        case 'columns':
            this._applyColumns();
            break;
        case 'show-header':
        case 'show-footer':
            this._buildExtras();
            break;
        case 'hidden-items':
            this._applyHidden();
            break;
        default:
            break;
        }
    }

    // ---- look --------------------------------------------------------

    _isLight() {
        const scheme = this._iface?.get_string('color-scheme');
        return scheme === 'default' || scheme === 'prefer-light';
    }

    _accent() {
        const value = this._gs.get_string('accent-color').trim();
        return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ff5722';
    }

    _applyLook() {
        if (!this._menu)
            return;
        const light = this._isLight();
        for (const actor of [this._menu.actor, this._menu.box]) {
            if (light)
                actor.add_style_class_name('fqp-light');
            else
                actor.remove_style_class_name('fqp-light');
        }

        const [r, g, b] = light ? [243, 243, 243] : [36, 36, 36];
        const alpha = this._gs.get_int('opacity') / 100;
        const radius = this._gs.get_int('corner-radius');
        this._menu.box.style = `background-color: rgba(${r}, ${g}, ${b}, ${alpha}); ` +
            `border-radius: ${radius}px; color: ${light ? '#1b1b1b' : '#ffffff'};`;

        this._loadStyle();
    }

    // The accent color is a setting, so these rules are written to a file
    // and loaded as an extra stylesheet.
    _loadStyle() {
        const accent = this._accent();
        const hover = mix(accent, 'white', 0.12);
        const css = `
.fqp .quick-toggle {
  border-radius: 16px;
  background-color: rgba(255, 255, 255, 0.09);
}
.fqp .quick-toggle:hover,
.fqp .quick-toggle:focus {
  background-color: rgba(255, 255, 255, 0.15);
}
.fqp .quick-toggle:checked {
  background-color: ${accent};
  color: #ffffff;
}
.fqp .quick-toggle:checked:hover,
.fqp .quick-toggle:checked:focus {
  background-color: ${hover};
}
.fqp .quick-toggle-arrow {
  border-radius: 99px;
}
.fqp .icon-button {
  background-color: rgba(255, 255, 255, 0.09);
}
.fqp .icon-button:hover,
.fqp .icon-button:focus {
  background-color: rgba(255, 255, 255, 0.16);
}
.fqp .quick-slider .slider,
.fqp .slider {
  color: ${accent};
  -slider-height: 6px;
  -slider-handle-radius: 9px;
  -slider-background-color: rgba(255, 255, 255, 0.2);
  -slider-active-background-color: ${accent};
  -barlevel-active-background-color: ${accent};
}
.fqp-light .quick-toggle {
  background-color: rgba(0, 0, 0, 0.07);
  color: #1b1b1b;
}
.fqp-light .quick-toggle:hover,
.fqp-light .quick-toggle:focus {
  background-color: rgba(0, 0, 0, 0.12);
}
.fqp-light .quick-toggle:checked {
  background-color: ${accent};
  color: #ffffff;
}
.fqp-light .quick-toggle:checked:hover,
.fqp-light .quick-toggle:checked:focus {
  background-color: ${hover};
}
.fqp-light .icon-button {
  background-color: rgba(0, 0, 0, 0.07);
  color: #1b1b1b;
}
.fqp-light .icon-button:hover,
.fqp-light .icon-button:focus {
  background-color: rgba(0, 0, 0, 0.13);
}
.fqp-light .slider {
  -slider-background-color: rgba(0, 0, 0, 0.18);
}
`;
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), '4ever-quick-panel']);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, 'style.css']);
        GLib.file_set_contents(path, css);

        this._unloadStyle();
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._styleFile = Gio.File.new_for_path(path);
        theme.load_stylesheet(this._styleFile);
    }

    _unloadStyle() {
        if (!this._styleFile)
            return;
        try {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._styleFile);
        } catch (_e) {
            // theme is gone
        }
        this._styleFile = null;
    }

    // ---- header and footer ----------------------------------------------

    _avatarPath() {
        const user = GLib.get_user_name();
        const candidates = [
            `/var/lib/AccountsService/icons/${user}`,
            GLib.build_filenamev([GLib.get_home_dir(), '.face']),
            GLib.build_filenamev([GLib.get_home_dir(), '.face.icon']),
        ];
        return candidates.find(path => GLib.file_test(path, GLib.FileTest.IS_REGULAR)) ?? null;
    }

    _makeAvatar(size) {
        const path = this._avatarPath();
        if (path) {
            return new St.Widget({
                style: `width: ${size}px; height: ${size}px; border-radius: ${size}px; ` +
                    `background-image: url("file://${path}"); background-size: ${size}px ${size}px;`,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }
        return new St.Icon({
            icon_name: 'avatar-default-symbolic',
            style_class: 'fqp-avatar',
            icon_size: size - 12,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _teardownExtras() {
        for (const actor of this._extras ?? [])
            actor.destroy();
        this._extras = [];
        this._dateLabel = null;
    }

    _buildExtras() {
        this._teardownExtras();
        const parent = this._grid?.get_parent();
        // Only add to a plain vertical box; anything else, skip rather than guess
        if (!parent || !(parent instanceof St.BoxLayout))
            return;

        if (this._gs.get_boolean('show-header')) {
            const header = new St.BoxLayout({style_class: 'fqp-header', x_expand: true});
            const name = GLib.get_real_name();
            const pill = new St.Button({
                style_class: 'fqp-pill',
                reactive: true,
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
            });
            const row = new St.BoxLayout({style: 'spacing: 8px;'});
            row.add_child(this._makeAvatar(30));
            row.add_child(new St.Label({
                text: name && name !== 'Unknown' ? name : GLib.get_user_name(),
                style_class: 'fqp-pill-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            pill.child = row;
            pill.connect('clicked', () => {
                this._menu.close();
                try {
                    Gio.Subprocess.new(['gnome-control-center', 'system'], Gio.SubprocessFlags.NONE);
                } catch (e) {
                    console.error(`${TAG} could not open settings: ${e.message}`);
                }
            });
            header.add_child(pill);
            parent.insert_child_below(header, this._grid);
            this._extras.push(header);
        }

        if (this._gs.get_boolean('show-footer')) {
            const footer = new St.BoxLayout({style_class: 'fqp-footer', x_expand: true});
            const pill = new St.BoxLayout({style_class: 'fqp-pill fqp-pill-date', x_align: Clutter.ActorAlign.START});
            this._dateLabel = new St.Label({style_class: 'fqp-pill-label', y_align: Clutter.ActorAlign.CENTER});
            pill.add_child(this._dateLabel);
            footer.add_child(pill);
            parent.insert_child_above(footer, this._grid);
            this._extras.push(footer);
            this._updateClock();
        }
    }

    _updateClock() {
        if (this._dateLabel)
            this._dateLabel.text = GLib.DateTime.new_now_local().format('%d.%m.%Y - %H:%M:%S') ?? '';
    }

    _stopClock() {
        if (this._clockId) {
            GLib.source_remove(this._clockId);
            this._clockId = 0;
        }
    }

    _onOpen(open) {
        this._stopClock();
        if (!open)
            return;
        this._updateClock();
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- tiles and sliders -----------------------------------------------

    _queueScan() {
        if (this._scanId)
            return;
        this._scanId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scanId = 0;
            try {
                this._scan();
            } catch (e) {
                console.error(`${TAG} ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _friendlyName(child, className) {
        if (typeof child.title === 'string' && child.title)
            return child.title;
        const match = FRIENDLY_NAMES.find(([part]) => className.includes(part));
        return match ? match[1] : className.replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    // Find what the panel contains, remember it for the settings window, and
    // apply the "hide" choices.
    _scan() {
        if (!this._grid)
            return;
        const children = this._grid.get_children();
        const seen = new Map();
        const known = [];

        for (const child of children) {
            const className = child.constructor?.name ?? 'Item';
            const index = seen.get(className) ?? 0;
            seen.set(className, index + 1);

            let info = this._items.get(child);
            if (!info) {
                info = {gnomeVisible: child.visible, hidden: false, self: false, sig: 0};
                this._items.set(child, info);
            }
            info.id = index === 0 ? className : `${className}:${index}`;
            info.title = this._friendlyName(child, className);
            known.push(`${info.id}|${info.title}`);
        }

        // Forget widgets that are no longer in the panel
        for (const child of [...this._items.keys()]) {
            if (!children.includes(child))
                this._items.delete(child);
        }

        const current = this._gs.get_strv('known-items');
        if (current.length !== known.length || current.some((v, i) => v !== known[i]))
            this._gs.set_strv('known-items', known);

        this._applyHidden();
    }

    _applyHidden() {
        if (!this._gs)
            return;
        const hidden = new Set(this._gs.get_strv('hidden-items'));
        for (const [child, info] of this._items) {
            const shouldHide = hidden.has(info.id);
            if (shouldHide && !info.hidden) {
                info.hidden = true;
                info.gnomeVisible = child.visible;
                // GNOME shows and hides its own items; keep ours hidden
                info.sig = child.connect('notify::visible', () => {
                    if (info.self)
                        return;
                    info.gnomeVisible = child.visible;
                    if (child.visible) {
                        info.self = true;
                        child.hide();
                        info.self = false;
                    }
                });
                info.self = true;
                child.hide();
                info.self = false;
            } else if (!shouldHide && info.hidden) {
                info.hidden = false;
                child.disconnect(info.sig);
                info.sig = 0;
                child.visible = info.gnomeVisible;
            }
        }
    }

    // ---- columns (experimental) ----------------------------------------------

    _isToggle(child) {
        return 'checked' in child && 'title' in child;
    }

    _setColumns(count) {
        const layout = this._grid.layout_manager;
        if (!layout || !('nColumns' in layout))
            throw new Error('the panel layout has no column setting');
        layout.nColumns = count;
        // Sliders and the top row stretch over the whole row
        for (const child of this._grid.get_children()) {
            if (!this._isToggle(child))
                layout.child_set_property(this._grid, child, 'column-span', count);
        }
    }

    _applyColumns() {
        const layout = this._grid?.layout_manager;
        if (!layout || !('nColumns' in layout))
            return;
        if (this._originalColumns === undefined)
            this._originalColumns = layout.nColumns;
        const wanted = this._gs.get_int('columns') === 3 ? 3 : this._originalColumns;
        if (layout.nColumns === wanted)
            return;
        const before = layout.nColumns;
        try {
            this._setColumns(wanted);
        } catch (e) {
            console.error(`${TAG} could not change the columns, putting them back: ${e.message}`);
            try {
                this._setColumns(before);
            } catch (_e) {
                // nothing more to do
            }
        }
    }

    _restoreColumns() {
        if (this._originalColumns === undefined || !this._grid)
            return;
        if (this._grid.layout_manager.nColumns !== this._originalColumns)
            this._setColumns(this._originalColumns);
    }
}
