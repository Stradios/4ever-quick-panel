// SPDX-License-Identifier: GPL-3.0-or-later
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const TAG = '[4ever-quick-panel]';
const ARROW_SIZE = 30;

// Friendly names. The first part that matches the class name wins, so the
// more specific parts come first.
const FRIENDLY_NAMES = [
    ['SystemItem', 'Top row (battery, settings, lock, power)'],
    ['OutputStream', 'Volume'],
    ['InputStream', 'Microphone'],
    ['KeyboardBrightness', 'Keyboard backlight'],
    ['Brightness', 'Brightness'],
    ['NMWired', 'Wired network'],
    ['NMWireless', 'Wi-Fi'],
    ['NMModem', 'Mobile data'],
    ['NMBluetooth', 'Bluetooth tethering'],
    ['NMVpn', 'VPN'],
    ['NMHotspot', 'Hotspot'],
    ['PowerProfile', 'Power mode'],
    ['NightLight', 'Night Light'],
    ['DarkMode', 'Dark style'],
    ['RFKill', 'Airplane mode'],
    ['Airplane', 'Airplane mode'],
    ['Rotat', 'Auto-rotate'],
    ['DoNotDisturb', 'Do Not Disturb'],
    ['Dnd', 'Do Not Disturb'],
    ['BackgroundApps', 'Background apps'],
    ['Thunderbolt', 'Thunderbolt'],
    ['Bluetooth', 'Bluetooth'],
    ['Remote', 'Screen sharing'],
    ['Unsafe', 'Unsafe mode'],
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

function clamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
}

export default class FourEverQuickPanel extends Extension {
    enable() {
        this._gs = this.getSettings();
        this._signals = [];
        this._items = new Map();
        this._own = new Set();
        this._originalColumns = undefined;
        this._extras = [];
        this._page = null;
        this._errors = [];
        this._baseHeight = 0;

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

    _err(message) {
        console.error(`${TAG} ${message}`);
        this._errors?.push(message);
        // also kept in a file, so a problem can be read without the journal
        try {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), '4ever-quick-panel']);
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(GLib.build_filenamev([dir, 'errors.txt']), (this._errors ?? []).join('\n') + '\n');
        } catch (_e) {
            // nothing more to do
        }
    }

    // GNOME has changed how a notification's actions are stored over time, so
    // try the ways they are known to work. If none does, write down what the
    // action looks like.
    _runAction(action, notification) {
        if (typeof action.callback === 'function') {
            action.callback();
            return;
        }
        for (const name of ['activate', 'invoke', 'run', 'click', 'trigger']) {
            if (typeof action[name] === 'function') {
                action[name]();
                return;
            }
        }
        if (typeof action.emit === 'function') {
            for (const [signal, args] of [['clicked', [0]], ['activate', []], ['activated', []]]) {
                try {
                    action.emit(signal, ...args);
                    return;
                } catch (_e) {
                    // not that signal
                }
            }
        }
        const own = Object.keys(action);
        const inherited = [];
        for (let proto = Object.getPrototypeOf(action); proto && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto))
            inherited.push(...Object.getOwnPropertyNames(proto).filter(n => !n.startsWith('_')).slice(0, 40));
        const notificationKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(notification))
            .filter(n => /action|activate|invoke/i.test(n));
        throw new Error(`cannot run action "${action.label}": type ${action.constructor?.name}, ` +
            `own [${own.join(', ')}], inherited [${inherited.join(', ')}], ` +
            `notification members [${notificationKeys.join(', ')}]`);
    }

    // Close the panel first, then run something: apps opened while the panel
    // still holds the keyboard and mouse may not come to the front
    _afterClose(callback) {
        this._menu?.close();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            try {
                callback();
            } catch (e) {
                this._err(`notification: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _connect(obj, name, callback) {
        this._signals.push([obj, obj.connect(name, callback)]);
    }

    _setup() {
        this._menu.actor.add_style_class_name('fqp');
        this._menu.box.add_style_class_name('fqp');

        this._connect(this._iface, 'changed::color-scheme', () => this._applyLook());
        this._connect(this._iface, 'changed::text-scaling-factor', () => this._resize());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._resize());
        this._connect(this._gs, 'changed', (_s, key) => this._onSettingChanged(key));
        this._connect(this._menu, 'open-state-changed', (_m, open) => this._onOpen(open));
        this._connect(this._grid, 'child-added', () => this._queueScan());

        this._applyLook();
        this._buildExtras();
        this._applyColumns();
        this._buildGridExtras();
        this._scan();
        this._setupNotifications();
        this._patchDateMenu();
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
        if (this._pageTimer) {
            GLib.source_remove(this._pageTimer);
            this._pageTimer = 0;
        }
        this._stopClock();
        // Pages first: a tile page holds one of GNOME's own widgets
        try {
            this._closePage(true);
        } catch (_e) {
            // widget is gone
        }
        this._unpatchDateMenu();
        this._teardownNotifications();
        this._teardownGridExtras();
        this._teardownExtras();

        // Give every item back to GNOME
        for (const [child, info] of this._items ?? []) {
            try {
                if (info.sig)
                    child.disconnect(info.sig);
                if (info.menuSig && info.menuObj)
                    info.menuObj.disconnect(info.menuSig);
                if (info.menuActorSig)
                    info.menuActor.disconnect(info.menuActorSig);
                child.visible = info.gnomeVisible;
                if (info.checkedSig)
                    child.disconnect(info.checkedSig);
                for (const [part, id] of info.hoverSigs ?? [])
                    part.disconnect(id);
                child.remove_style_class_name('fqp-checked');
                child.remove_style_class_name('fqp-hover');
                if (info.styled) {
                    child.style = info.origStyle ?? '';
                    if (info.inner)
                        info.inner.style = info.origInner ?? '';
                    if (info.sep)
                        info.sep.style = info.origSep ?? '';
                    if (info.arrow) {
                        info.arrow.style = info.origArrowStyle ?? '';
                        info.arrow.y_align = info.origArrowAlign;
                        info.arrow.y_expand = info.origArrowExpand;
                    }
                }
            } catch (_e) {
                // widget is gone
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
        case 'width':
            this._resize();
            break;
        case 'tile-radius':
        case 'tile-height':
            this._loadStyle();
            this._styleTiles();
            break;
        case 'tile-columns':
            this._applyColumns();
            break;
        case 'show-header':
        case 'show-footer':
            this._closePage(true);
            this._buildExtras();
            break;
        case 'show-headings':
        case 'show-shortcuts':
        case 'shortcuts':
            this._closePage(true);
            this._buildGridExtras();
            this._arrange();
            break;
        case 'show-notifications':
            this._teardownNotifications();
            this._setupNotifications();
            break;
        case 'keep-transient':
            this._hookTransient();
            break;
        case 'clock-opens-panel':
            this._unpatchDateMenu();
            this._patchDateMenu();
            break;
        case 'week-start':
            if (this._page?.calendar)
                this._page.calendar();
            break;
        case 'hidden-items':
            this._applyPolicies();
            break;
        default:
            break;
        }
    }

    // ---- diagnostics -----------------------------------------------------
    // Writes what the panel looks like inside to a text file, so a problem
    // can be understood without guessing.
    _describe(actor, depth, lines) {
        const pad = '  '.repeat(depth);
        let classes = '';
        try {
            classes = actor.get_style_class_name?.() ?? '';
        } catch (_e) {
            classes = '?';
        }
        const [x, y] = actor.get_position();
        const [w, h] = actor.get_size();
        lines.push(`${pad}${actor.constructor?.name} [${classes}] vis=${actor.visible} ` +
            `pos=${Math.round(x)},${Math.round(y)} size=${Math.round(w)}x${Math.round(h)}`);
        if (depth < 5) {
            for (const child of actor.get_children?.() ?? [])
                this._describe(child, depth + 1, lines);
        }
    }

    _dumpPage(holder) {
        try {
            const lines = ['tile page contents'];
            this._describe(holder, 0, lines);
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), '4ever-quick-panel']);
            GLib.file_set_contents(GLib.build_filenamev([dir, 'page-debug.txt']), lines.join('\n') + '\n');
        } catch (e) {
            console.error(`${TAG} page dump failed: ${e.message}`);
        }
    }

    _dumpDebug() {
        try {
            const lines = [`4ever Quick Panel 0.2 debug, ${GLib.DateTime.new_now_local().format('%F %T')}`];
            const layout = this._grid.layout_manager;
            lines.push(`layout: ${layout?.constructor?.name}, nColumns=${layout?.nColumns}, ` +
                `original=${this._originalColumns}, columns setting=${this._gs.get_int('tile-columns')}`);
            lines.push(`panel width setting result: ${this._panelWidth()}`);
            lines.push(`own extras in grid: ${this._own.size}, failed=${!!this._gridExtrasFailed}`);
            lines.push('errors:');
            for (const e of this._errors)
                lines.push(`  ${e}`);
            lines.push('--- grid children ---');
            this._describe(this._grid, 0, lines);
            const parent = this._grid.get_parent();
            const dateMenu = Main.panel.statusArea.dateMenu;
            lines.push(`--- date menu: events=${!!dateMenu?._eventsItem} clocks=${!!dateMenu?._clocksItem} ` +
                `weather=${!!dateMenu?._weatherItem} messages=${!!dateMenu?._messageList} calendar=${!!dateMenu?._calendar} ---`);
            if (dateMenu?.menu?.box)
                this._describe(dateMenu.menu.box, 0, lines);
            lines.push('--- panel box ---');
            if (parent) {
                lines.push(`${parent.constructor?.name} ${Math.round(parent.width)}x${Math.round(parent.height)}`);
                for (const c of parent.get_children())
                    lines.push(`  ${c.constructor?.name} [${c.get_style_class_name?.() ?? ''}] ${Math.round(c.width)}x${Math.round(c.height)}`);
            }
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), '4ever-quick-panel']);
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(GLib.build_filenamev([dir, 'debug.txt']), lines.join('\n') + '\n');
        } catch (e) {
            console.error(`${TAG} debug dump failed: ${e.message}`);
        }
    }

    // ---- look and size ----------------------------------------------------

    _isLight() {
        const scheme = this._iface?.get_string('color-scheme');
        return scheme === 'default' || scheme === 'prefer-light';
    }

    _accent() {
        const value = this._gs.get_string('accent-color').trim();
        return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ff5722';
    }

    _textScale() {
        const value = this._iface?.get_double('text-scaling-factor') ?? 1;
        return clamp(value > 0 ? value : 1, 0.75, 3);
    }

    // The panel is as wide as the screen suggests: about a quarter of the
    // width, wider for bigger text, never too narrow to read, never most of
    // the screen.
    _panelWidth() {
        const monitor = Main.layoutManager.primaryMonitor;
        const screenWidth = monitor?.width ?? 1920;
        const custom = this._gs.get_int('width');
        const wanted = custom > 0
            ? Math.max(custom, 320)
            : Math.max(Math.round(0.255 * screenWidth * this._textScale()), 380);
        return Math.min(wanted, Math.max(380, Math.round(screenWidth * 0.45)));
    }

    _tileHeight() {
        const custom = this._gs.get_int('tile-height');
        if (custom > 0)
            return custom;
        const screenHeight = Main.layoutManager.primaryMonitor?.height ?? 1080;
        return Math.round(56 * this._textScale() * (screenHeight < 800 ? 0.9 : 1));
    }

    _anyMenuOpen() {
        for (const child of this._items.keys()) {
            if (child.menu?.isOpen)
                return true;
        }
        return false;
    }

    _resize() {
        this._baseHeight = 0;
        this._applySize();
    }

    _applySize() {
        if (!this._menu)
            return;
        this._applyLook();
        this._styleTiles();
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
        const width = this._panelWidth();
        this._menu.box.style = `background-color: rgba(${r}, ${g}, ${b}, ${alpha}); ` +
            `border-radius: ${radius}px; color: ${light ? '#1b1b1b' : '#ffffff'}; ` +
            `width: ${width}px; min-width: ${width}px; max-width: ${width}px;`;

        this._loadStyle();
        this._styleNotify();
    }

    // The accent color is a setting, so these rules are written to a file
    // and loaded as an extra stylesheet.
    _loadStyle() {
        const accent = this._accent();
        const hover = mix(accent, 'white', 0.12);
        const radius = this._gs.get_int('tile-radius');
        const css = `
.fqp .quick-toggle {
  border-radius: ${radius}px;
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
.fqp .quick-toggle-has-menu {
  border-radius: ${radius}px;
  background-color: rgba(255, 255, 255, 0.09);
}
.fqp .quick-toggle-has-menu.fqp-checked {
  background-color: ${accent};
  color: #ffffff;
}
.fqp .quick-toggle-has-menu .quick-toggle,
.fqp .quick-toggle-has-menu .quick-toggle:checked {
  background-color: transparent;
}
.fqp .quick-toggle-has-menu .quick-toggle:hover,
.fqp .quick-toggle-has-menu .quick-toggle:focus,
.fqp .quick-toggle-has-menu .quick-toggle:checked:hover,
.fqp .quick-toggle-has-menu .quick-toggle:checked:focus {
  background-color: transparent;
}
.fqp .quick-toggle-has-menu.fqp-hover {
  background-color: rgba(255, 255, 255, 0.15);
}
.fqp .quick-toggle-has-menu.fqp-checked.fqp-hover {
  background-color: ${hover};
}
.fqp .quick-toggle-has-menu .quick-toggle-menu-button {
  background-color: rgba(255, 255, 255, 0.14);
}
.fqp .quick-toggle-has-menu .quick-toggle-menu-button:hover,
.fqp .quick-toggle-has-menu .quick-toggle-menu-button:focus {
  background-color: rgba(255, 255, 255, 0.24);
}
.fqp .quick-toggle-has-menu.fqp-checked .quick-toggle-menu-button {
  background-color: rgba(255, 255, 255, 0.26);
}
.fqp .quick-toggle-menu .header .icon {
  background-color: ${accent};
  color: #ffffff;
}
.fqp .events-button,
.fqp .world-clocks-button,
.fqp .weather-button {
  background-color: rgba(255, 255, 255, 0.09);
  border-radius: 16px;
}
.fqp .events-button:hover,
.fqp .world-clocks-button:hover,
.fqp .weather-button:hover {
  background-color: rgba(255, 255, 255, 0.15);
}
.fqp-light .events-button,
.fqp-light .world-clocks-button,
.fqp-light .weather-button {
  background-color: rgba(0, 0, 0, 0.07);
}
.fqp-light .events-button:hover,
.fqp-light .world-clocks-button:hover,
.fqp-light .weather-button:hover {
  background-color: rgba(0, 0, 0, 0.12);
}
/* Notifications are stacked on top of each other, so they must be solid:
   see-through cards show the text of the ones underneath */
.fqp .message {
  background-color: #383838;
  border-radius: 16px;
}
.fqp .message:hover {
  background-color: #444444;
}
.fqp-light .message {
  background-color: #e2e2e2;
}
.fqp-light .message:hover {
  background-color: #d6d6d6;
}
.fqp .fqp-notif-close {
  background-color: rgba(255, 255, 255, 0.12);
}
.fqp-light .fqp-notif-close {
  background-color: rgba(0, 0, 0, 0.1);
}
.fqp .fqp-cal-today {
  background-color: ${accent};
  color: #ffffff;
}
.fqp .fqp-cal-selected {
  border: 2px solid ${accent};
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
.fqp-light .quick-toggle-has-menu {
  background-color: rgba(0, 0, 0, 0.07);
}
.fqp-light .quick-toggle-has-menu.fqp-checked {
  background-color: ${accent};
}
.fqp-light .quick-toggle-has-menu .quick-toggle,
.fqp-light .quick-toggle-has-menu .quick-toggle:checked {
  background-color: transparent;
}
.fqp-light .quick-toggle-has-menu .quick-toggle:hover,
.fqp-light .quick-toggle-has-menu .quick-toggle:focus {
  background-color: transparent;
}
.fqp-light .quick-toggle-has-menu.fqp-hover {
  background-color: rgba(0, 0, 0, 0.12);
}
.fqp-light .quick-toggle-has-menu.fqp-checked.fqp-hover {
  background-color: ${hover};
}
.fqp-light .quick-toggle-has-menu .quick-toggle-menu-button {
  background-color: rgba(0, 0, 0, 0.1);
}
.fqp-light .quick-toggle-has-menu .quick-toggle-menu-button:hover,
.fqp-light .quick-toggle-has-menu .quick-toggle-menu-button:focus {
  background-color: rgba(0, 0, 0, 0.18);
}
.fqp-light .quick-toggle-has-menu.fqp-checked .quick-toggle-menu-button {
  background-color: rgba(255, 255, 255, 0.28);
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

    // Tile shape: the stylesheet cannot always beat GNOME's own rules, so the
    // same values are also set on the widgets themselves.
    _findByClass(actor, className, skipSelf = false) {
        if (!skipSelf && actor.has_style_class_name?.(className))
            return actor;
        for (const child of actor.get_children?.() ?? []) {
            const found = this._findByClass(child, className);
            if (found)
                return found;
        }
        return null;
    }

    // A tile with an arrow is a box holding the real toggle button, a thin
    // separator and the arrow button. The look is moved to the box, the
    // button becomes see-through and the arrow becomes a round button inside.
    _styleTile(child, info) {
        const radius = this._gs.get_int('tile-radius');
        const height = this._tileHeight();
        const hasMenu = child.has_style_class_name?.('quick-toggle-has-menu');
        if (!info.styled) {
            info.origStyle = child.style;
            if (hasMenu) {
                info.inner = this._findByClass(child, 'quick-toggle', true);
                info.arrow = this._findByClass(child, 'quick-toggle-menu-button');
                info.sep = this._findByClass(child, 'quick-toggle-separator');
                if (info.inner)
                    info.origInner = info.inner.style;
                if (info.sep)
                    info.origSep = info.sep.style;
                if (info.arrow) {
                    info.origArrowStyle = info.arrow.style;
                    info.origArrowAlign = info.arrow.y_align;
                    info.origArrowExpand = info.arrow.y_expand;
                }
                info.checkedSig = child.connect('notify::checked', () => this._syncChecked(child));
                // The whole tile lights up when the pointer is on any part of it
                info.hoverSigs = [info.inner, info.arrow].filter(Boolean).map(part =>
                    [part, part.connect('notify::hover', () => this._syncHover(child, info))]);
            }
            info.styled = true;
        }
        child.style = `border-radius: ${radius}px; min-height: ${height}px;`;
        if (!hasMenu)
            return;
        if (info.inner)
            info.inner.style = `border-radius: ${radius}px;`;
        if (info.sep)
            info.sep.style = 'width: 0px; min-width: 0px; border-width: 0; background-color: transparent;';
        if (info.arrow) {
            info.arrow.style = 'border-radius: 99px; border-width: 0; padding: 0; ' +
                `width: ${ARROW_SIZE}px; height: ${ARROW_SIZE}px; margin: 0 10px 0 0;`;
            info.arrow.y_align = Clutter.ActorAlign.CENTER;
            info.arrow.y_expand = false;
        }
        this._syncChecked(child);
    }

    _syncHover(child, info) {
        if (info.inner?.hover || info.arrow?.hover)
            child.add_style_class_name('fqp-hover');
        else
            child.remove_style_class_name('fqp-hover');
    }

    _syncChecked(child) {
        if (child.checked)
            child.add_style_class_name('fqp-checked');
        else
            child.remove_style_class_name('fqp-checked');
    }

    _styleTiles() {
        for (const [child, info] of this._items) {
            if (!this._isToggle(child))
                continue;
            try {
                this._styleTile(child, info);
            } catch (e) {
                this._err(`could not style ${info.id}: ${e.message}`);
            }
        }
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
        this._header = null;
        this._footer = null;
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
            this._header = header;
        }

        if (this._gs.get_boolean('show-footer')) {
            const footer = new St.BoxLayout({style_class: 'fqp-footer', x_expand: true});
            const pill = new St.Button({
                style_class: 'fqp-pill fqp-pill-date',
                reactive: true,
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
            });
            const row = new St.BoxLayout({style: 'spacing: 8px;'});
            row.add_child(new St.Icon({
                icon_name: 'x-office-calendar-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._dateLabel = new St.Label({style_class: 'fqp-pill-label', y_align: Clutter.ActorAlign.CENTER});
            row.add_child(this._dateLabel);
            pill.child = row;
            pill.connect('clicked', () => this._openCalendar());
            footer.add_child(pill);
            parent.insert_child_above(footer, this._grid);
            this._extras.push(footer);
            this._footer = footer;
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
        if (!open) {
            this._closedAt = GLib.get_monotonic_time();
            this._calendarSoon = false;
            // Leave an open page as it is until the panel has finished
            // disappearing, otherwise the main page flashes while it closes
            if (this._page && !this._pageTimer) {
                this._pageTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
                    this._pageTimer = 0;
                    if (!this._menu?.isOpen)
                        this._closePage(true);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        if (this._pageTimer) {
            GLib.source_remove(this._pageTimer);
            this._pageTimer = 0;
        }
        // Opened from the panel button: start on the main page
        if (this._page && !this._keepPage)
            this._closePage(true);
        this._keepPage = false;
        this._applySize();
        this._updateClock();
        this._syncNotifications();
        for (const delay of [60, 300, 700]) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._styleNotify();
                return GLib.SOURCE_REMOVE;
            });
        }
        if (this._calendarSoon) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                if (this._calendarSoon && this._menu?.isOpen && !this._page)
                    this._openCalendar();
                this._calendarSoon = false;
                return GLib.SOURCE_REMOVE;
            });
        }
        // after the panel has been laid out
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            if (this._menu && !this._page && !this._anyMenuOpen()) {
                const parent = this._grid?.get_parent();
                if (parent && parent.height > 0)
                    this._baseHeight = parent.height;
            }
            if (this._menu && !this._dumped) {
                this._dumped = true;
                this._dumpDebug();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            this._syncNotifications();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- headings and the Shortcuts row (inside GNOME's grid) ------------------

    _teardownGridExtras() {
        for (const actor of this._own) {
            try {
                actor.destroy();
            } catch (_e) {
                // already gone
            }
        }
        this._own = new Set();
        this._headingQuick = null;
        this._headingShortcuts = null;
        this._shortcutsRow = null;
    }

    _addToGrid(actor) {
        const layout = this._grid.layout_manager;
        this._grid.add_child(actor);
        try {
            layout.child_set_property(this._grid, actor, 'column-span', layout.nColumns ?? 2);
        } catch (e) {
            this._grid.remove_child(actor);
            actor.destroy();
            throw e;
        }
        this._own.add(actor);
    }

    _makeIcon(spec, size) {
        if (spec && spec.startsWith('/')) {
            return new St.Icon({
                gicon: new Gio.FileIcon({file: Gio.File.new_for_path(spec)}),
                icon_size: size,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }
        return new St.Icon({
            icon_name: spec || 'application-x-executable-symbolic',
            icon_size: size,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _readShortcuts() {
        return this._gs.get_strv('shortcuts').map(entry => {
            const [name, icon, ...command] = entry.split('|');
            return {name: name ?? '', icon: icon ?? '', command: command.join('|')};
        }).filter(s => s.name || s.command);
    }

    _launch(command) {
        this._menu.close();
        try {
            if (command.endsWith('.desktop')) {
                const app = Gio.DesktopAppInfo.new(command);
                if (!app)
                    throw new Error(`no application called ${command}`);
                app.launch([], null);
            } else if (/^[a-z][a-z0-9+.-]*:/i.test(command) && !command.includes(' ')) {
                Gio.AppInfo.launch_default_for_uri(command, null);
            } else {
                const [, argv] = GLib.shell_parse_argv(command);
                Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            }
        } catch (e) {
            console.error(`${TAG} could not start "${command}": ${e.message}`);
            Main.notify('4ever Quick Panel', `Could not start "${command}".`);
        }
    }

    _makeChip(label, iconSpec, onClick) {
        const chip = new St.Button({style_class: 'fqp-chip', reactive: true, can_focus: true});
        const row = new St.BoxLayout({style: 'spacing: 6px;'});
        row.add_child(this._makeIcon(iconSpec, 16));
        if (label) {
            row.add_child(new St.Label({
                text: label,
                style_class: 'fqp-pill-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        chip.child = row;
        chip.connect('clicked', onClick);
        return chip;
    }

    _buildGridExtras() {
        this._teardownGridExtras();
        if (this._gridExtrasFailed)
            return;
        try {
            if (this._gs.get_boolean('show-headings')) {
                this._headingQuick = new St.Label({
                    text: 'Quick Controls',
                    style_class: 'fqp-heading',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.START,
                });
                this._addToGrid(this._headingQuick);
            }
            if (this._gs.get_boolean('show-shortcuts')) {
                if (this._gs.get_boolean('show-headings')) {
                    this._headingShortcuts = new St.Label({
                        text: 'Shortcuts',
                        style_class: 'fqp-heading',
                        x_expand: true,
                        x_align: Clutter.ActorAlign.START,
                    });
                    this._addToGrid(this._headingShortcuts);
                }
                // Rows are wrapped by hand: a flow layout reports a wrong
                // height to GNOME's grid, which leaves a big empty gap.
                const row = new St.BoxLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    x_expand: true,
                    style_class: 'fqp-shortcuts',
                    style: 'spacing: 8px;',
                });
                const available = this._panelWidth() - 8;
                const scale = this._textScale();
                let line = null;
                let used = 0;
                const place = (chip, estimate) => {
                    if (!line || used + estimate > available) {
                        line = new St.BoxLayout({style: 'spacing: 8px;'});
                        row.add_child(line);
                        used = 0;
                    }
                    line.add_child(chip);
                    used += estimate + 8;
                };
                for (const shortcut of this._readShortcuts()) {
                    const chip = this._makeChip(shortcut.name, shortcut.icon, () => {
                        if (shortcut.command)
                            this._launch(shortcut.command);
                    });
                    place(chip, (shortcut.name.length * 8 + 60) * scale);
                }
                place(this._makeChip('', 'list-add-symbolic', () => {
                    this._menu.close();
                    this._gs.set_string('prefs-page', 'shortcuts');
                    this.openPreferences();
                }), 44 * scale);
                this._shortcutsRow = row;
                this._addToGrid(row);
            }
        } catch (e) {
            // GNOME's grid does not take extra widgets here: give up on these
            // extras, the panel keeps working without them
            this._err(`could not add headings and shortcuts: ${e.message}`);
            this._teardownGridExtras();
            this._gridExtrasFailed = true;
        }
    }

    // Put the grid in this order: top row, heading, tiles (each followed by
    // its own menu), Shortcuts, then the sliders and anything else.
    _arrange() {
        if (!this._grid)
            return;
        try {
            const children = this._grid.get_children();
            const menuActors = new Set(children.map(c => c.menu?.actor).filter(Boolean));
            const top = [];
            const tiles = [];
            const rest = [];
            for (const child of children) {
                if (this._own.has(child) || menuActors.has(child))
                    continue;
                if (child.constructor?.name === 'Clutter_Actor')
                    continue;
                if ((child.constructor?.name ?? '') === 'SystemItem')
                    top.push(child);
                else if (this._isToggle(child))
                    tiles.push(child);
                else
                    rest.push(child);
            }

            const order = [...top];
            if (this._headingQuick)
                order.push(this._headingQuick);
            for (const tile of tiles) {
                order.push(tile);
                if (tile.menu?.actor && tile.menu.actor.get_parent() === this._grid)
                    order.push(tile.menu.actor);
            }
            if (this._headingShortcuts)
                order.push(this._headingShortcuts);
            if (this._shortcutsRow)
                order.push(this._shortcutsRow);
            order.push(...rest);

            const current = children.filter(c => c.constructor?.name !== 'Clutter_Actor');
            const same = order.length === current.length && order.every((c, i) => c === current[i]);
            if (same)
                return;
            let previous = null;
            for (const child of order) {
                this._grid.set_child_above_sibling(child, previous);
                previous = child;
            }
        } catch (e) {
            this._err(`could not reorder the panel: ${e.message}`);
        }
    }

    // ---- pages inside the panel ------------------------------------------------

    // How tall every page is: the normal panel, measured while it was on
    // screen. Measuring a panel that was never shown gives too small a number,
    // so then there is none (0) and the page is as tall as its content.
    _pageHeight() {
        return this._baseHeight > 0 ? this._baseHeight : 0;
    }

    _showPage(title, content, {owner = null, onClose = null, matchHeight = false} = {}) {
        this._closePage(true);
        const parent = this._grid?.get_parent();
        if (!parent)
            return false;

        const page = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fqp-page',
            x_expand: true,
        });
        const top = new St.BoxLayout({style_class: 'fqp-page-top', x_expand: true});
        const back = new St.Button({
            style_class: 'fqp-back',
            reactive: true,
            can_focus: true,
            accessible_name: 'Back',
            child: new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 16}),
        });
        back.connect('clicked', () => defer(() => this._closePage()));
        top.add_child(back);
        top.add_child(new St.Label({text: title, style_class: 'fqp-page-title', y_align: Clutter.ActorAlign.CENTER}));
        page.add_child(top);
        page.add_child(content);
        // Every page is as tall as the normal panel, so nothing jumps when a
        // page opens or closes
        if (this._pageHeight() > 0)
            page.style = `min-height: ${Math.round(this._pageHeight())}px;`;

        const hidden = [this._grid, this._header, this._footer].filter(a => a && a.visible);
        parent.insert_child_above(page, this._grid);
        for (const actor of hidden)
            actor.hide();

        this._page = {actor: page, owner, onClose, hidden};
        if (this._menu?.isOpen) {
            page.opacity = 0;
            page.translation_x = 36;
            page.ease({
                opacity: 255,
                translation_x: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        return true;
    }

    _closePage(immediate = false) {
        const page = this._page;
        if (!page)
            return;
        if (immediate || !page.owner) {
            this._finishClose(page, immediate);
            return;
        }
        if (page.closing)
            return;
        // A tile page leaves in steps, so GNOME can finish closing its own
        // card before the grid comes back (otherwise the panel jumps):
        // fade the page, give the list back and close the card, then show the grid.
        page.closing = true;
        page.actor.ease({opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        page.timers = [
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 130, () => {
                try {
                    page.onClose?.();
                } catch (e) {
                    this._err(`${e.message}`);
                }
                page.onClose = null;
                return GLib.SOURCE_REMOVE;
            }),
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                page.timers = [];
                this._finishClose(page, false);
                return GLib.SOURCE_REMOVE;
            }),
        ];
    }

    _finishClose(page, immediate) {
        if (this._page !== page)
            return;
        this._page = null;
        for (const id of page.timers ?? [])
            GLib.source_remove(id);
        page.timers = [];
        try {
            page.onClose?.();
        } catch (e) {
            this._err(`${e.message}`);
        }
        try {
            page.actor.destroy();
        } catch (_e) {
            // already gone
        }
        for (const actor of page.hidden) {
            try {
                actor.show();
            } catch (_e) {
                // already gone
            }
        }
        if (!immediate && this._grid) {
            this._grid.opacity = 0;
            this._grid.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else if (this._grid) {
            this._grid.opacity = 255;
        }
    }

    // A tile's arrow opens a menu in GNOME. Here the list inside that menu
    // moves into a page of its own, with a back button. GNOME's own card
    // stays where it is (hidden), so GNOME still opens and closes it normally.
    _openTilePage(child, info) {
        if (!this._gs.get_boolean('inline-pages') || this._page || !this._grid || !this._menu?.isOpen)
            return;
        const menu = child.menu;
        const actor = menu?.actor;
        if (!actor || !(menu.isOpen ?? actor.visible))
            return;

        // The part of the card that holds the list (the child of the card
        // that contains menu.box)
        let content = menu.box ?? null;
        while (content && content.get_parent() && content.get_parent() !== actor)
            content = content.get_parent();
        if (!content || content.get_parent() !== actor)
            return;

        const index = actor.get_children().indexOf(content);
        const holder = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});

        const putBack = () => {
            this._busy = true;
            try {
                if (content.get_parent() === holder)
                    holder.remove_child(content);
                if (!content.get_parent())
                    actor.insert_child_at_index(content, Math.min(index, actor.get_n_children()));
                actor.show();
            } finally {
                this._busy = false;
            }
        };

        let shown = false;
        this._busy = true;
        try {
            actor.remove_child(content);
            // no card of its own: the page is the card
            content.style = 'background-color: transparent; border-width: 0; box-shadow: none; margin: 0;';
            holder.add_child(content);
            shown = this._showPage(info.title, holder, {
                owner: child,
                onClose: () => {
                    putBack();
                    try {
                        menu.close?.();
                    } catch (_e) {
                        // already closed
                    }
                },
            });
            if (shown) {
                actor.hide();
                this._dumpPage(holder);
            }
        } catch (e) {
            this._err(`could not open the page: ${e.message}`);
        } finally {
            this._busy = false;
        }
        if (!shown) {
            putBack();
            holder.destroy();
        }
    }

    // ---- calendar page -------------------------------------------------------

    _openCalendar() {
        this._closePage(true);
        const state = {date: GLib.DateTime.new_now_local()};
        state.year = state.date.get_year();
        state.month = state.date.get_month();
        state.selected = state.date;

        const root = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fqp-cal',
            x_expand: true,
        });
        const render = () => {
            root.destroy_all_children();
            this._renderCalendar(root, state, render);
        };
        state.select = date => this._syncGnomeCalendar(date);
        render();

        // Events, world clocks and weather are GNOME's own, moved in here
        const extra = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fqp-cal-extra',
            x_expand: true,
        });
        const restore = this._borrowDateSections(extra);
        this._syncGnomeCalendar(state.selected);

        const inner = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        inner.add_child(root);
        inner.add_child(extra);
        const scroll = new St.ScrollView({
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        scroll.add_child(inner);
        try {
            scroll.propagate_natural_height = true;
        } catch (_e) {
            // older toolkit: sized after it is shown, below
        }
        if (this._pageHeight() > 0)
            scroll.height = Math.max(200, Math.round(this._pageHeight()) - 50);

        const shown = this._showPage('Calendar', scroll, {onClose: restore});
        // If the content is only a few pixels too tall, there is nothing to
        // scroll: switch the scroll bar off instead of showing it
        for (const delay of [30, 120, 500]) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                try {
                    if (scroll.get_stage() && this._pageHeight() === 0 && inner.height > 0)
                        scroll.height = inner.height;
                    if (scroll.get_stage() && inner.height - scroll.height <= 12)
                        scroll.vscrollbar_policy = St.PolicyType.NEVER;
                    else if (scroll.get_stage())
                        scroll.vscrollbar_policy = St.PolicyType.AUTOMATIC;
                } catch (_e) {
                    // page is gone
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        if (shown && this._page)
            this._page.calendar = render;
        else
            restore();
    }

    // GNOME keeps events, world clocks and weather in its date menu. Lend
    // them to the calendar page and give them back when it closes.
    _borrowDateSections(container) {
        const dateMenu = Main.panel.statusArea.dateMenu;
        const wanted = [dateMenu?._eventsItem, dateMenu?._clocksItem, dateMenu?._weatherItem].filter(Boolean);
        const parts = wanted.length > 0 ? wanted : [dateMenu?._displaysSection].filter(Boolean);
        const lent = [];
        for (const part of parts) {
            try {
                const home = part.get_parent();
                if (!home)
                    continue;
                const index = home.get_children().indexOf(part);
                home.remove_child(part);
                container.add_child(part);
                lent.push({part, home, index});
            } catch (e) {
                this._err(`could not borrow a calendar section: ${e.message}`);
            }
        }
        if (lent.length === 0)
            this._err('no events, clocks or weather found in the date menu');
        return () => {
            for (const {part, home, index} of lent.reverse()) {
                try {
                    if (part.get_parent())
                        part.get_parent().remove_child(part);
                    home.insert_child_at_index(part, Math.min(index, home.get_n_children()));
                } catch (e) {
                    this._err(`could not return a calendar section: ${e.message}`);
                }
            }
        };
    }

    // GNOME's own calendar (hidden) is what loads the events, so it follows
    // the day chosen here.
    _syncGnomeCalendar(dateTime) {
        try {
            const calendar = Main.panel.statusArea.dateMenu?._calendar;
            if (!calendar?.setDate)
                return;
            const date = new Date(dateTime.get_year(), dateTime.get_month() - 1, dateTime.get_day_of_month());
            // jump away and back so it always reloads
            const other = new Date(date.getFullYear(), date.getMonth() + 1, 1);
            calendar.setDate(other);
            calendar.setDate(date);
        } catch (e) {
            this._err(`could not update the events: ${e.message}`);
        }
    }

    // ---- date and time on the taskbar -------------------------------------------

    _patchDateMenu() {
        if (this._dateMenuPatched || !this._gs.get_boolean('clock-opens-panel'))
            return;
        const menu = Main.panel.statusArea.dateMenu?.menu;
        if (!menu) {
            this._err('no date menu found');
            return;
        }
        this._dateMenuPatched = true;
        this._dateMenuObj = menu;
        this._dateMenuOwn = Object.getOwnPropertyDescriptor(menu, 'open') ?? null;
        menu.open = () => this._openFromClock();
    }

    _unpatchDateMenu() {
        if (!this._dateMenuPatched)
            return;
        this._dateMenuPatched = false;
        const menu = this._dateMenuObj;
        this._dateMenuObj = null;
        try {
            if (this._dateMenuOwn)
                Object.defineProperty(menu, 'open', this._dateMenuOwn);
            else
                delete menu.open;
        } catch (_e) {
            // menu is gone
        }
    }

    _openFromClock() {
        if (!this._menu)
            return;
        // The click that closes the panel arrives right before this one
        if (GLib.get_monotonic_time() - (this._closedAt ?? 0) < 350000)
            return;
        if (this._menu.isOpen) {
            if (!this._page)
                this._openCalendar();
            return;
        }
        // Build the calendar page first, so the panel opens showing only it
        this._openCalendar();
        this._keepPage = true;
        this._menu.open(BoxPointer.PopupAnimation.FULL);
        this._keepPage = false;
    }

    // ---- notifications box above the panel --------------------------------------
    // The list is built here from GNOME's notifications, so that each one can
    // be closed on its own and the ones from the same app can be flipped
    // through with the mouse wheel.

    _setupNotifications() {
        if (this._notify || !this._gs.get_boolean('show-notifications'))
            return;
        const box = this._menu?.box;
        const home = box?.get_parent();
        if (!home || !Main.messageTray?.getSources) {
            this._err('no notification tray found');
            return;
        }
        const wrapper = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'spacing: 12px;',
        });
        const notifyBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fqp-notify',
            x_expand: true,
            visible: false,
        });
        let scroll;
        try {
            scroll = new St.ScrollView({
                x_expand: true,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                propagate_natural_height: true,
            });
        } catch (_e) {
            scroll = new St.ScrollView({
                x_expand: true,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
            });
        }
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'spacing: 10px;',
        });
        scroll.add_child(content);
        notifyBox.add_child(scroll);
        const clear = new St.Button({
            style_class: 'fqp-chip fqp-clear',
            label: 'Clear',
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        clear.connect('clicked', () => this._dismissAll());
        notifyBox.add_child(clear);

        this._notify = {
            wrapper, notifyBox, box, home, content, scroll, signature: '',
            homeIndex: home.get_children().indexOf(box),
        };
        try {
            home.remove_child(box);
            wrapper.add_child(notifyBox);
            wrapper.add_child(box);
            if (home instanceof St.Bin)
                home.set_child(wrapper);
            else
                home.insert_child_at_index(wrapper, this._notify.homeIndex);
        } catch (e) {
            this._err(`could not set up the notification box: ${e.message}`);
            this._teardownNotifications();
            return;
        }
        this._views = new Map();
        this._seqs = new WeakMap();
        this._seqCount = 0;
        this._hookTransient();
        this._styleNotify();
        this._syncNotifications(true);
    }

    _teardownNotifications() {
        this._unhookTransient();
        const n = this._notify;
        if (!n)
            return;
        this._notify = null;
        try {
            if (n.box.get_parent() === n.wrapper)
                n.wrapper.remove_child(n.box);
            if (!n.box.get_parent()) {
                if (n.home instanceof St.Bin)
                    n.home.set_child(n.box);
                else
                    n.home.insert_child_at_index(n.box, Math.max(0, Math.min(n.homeIndex, n.home.get_n_children())));
            }
            n.wrapper.destroy();
        } catch (e) {
            console.error(`${TAG} could not restore the panel: ${e.message}`);
        }
    }

    // GNOME drops some notifications as soon as their banner is gone (the
    // screenshot one, for example). Keep them in the list instead.
    _keepNotification(notification) {
        try {
            if (notification?.isTransient) {
                if (notification.setTransient)
                    notification.setTransient(false);
                else
                    notification.isTransient = false;
            }
        } catch (_e) {
            // not changeable
        }
    }

    _hookSource(source) {
        try {
            for (const notification of source.notifications ?? [])
                this._keepNotification(notification);
            this._tHooks.push([source, source.connect('notification-added',
                (_s, notification) => this._keepNotification(notification))]);
        } catch (e) {
            this._err(`could not watch a notification source: ${e.message}`);
        }
    }

    _hookTransient() {
        this._unhookTransient();
        if (!this._gs.get_boolean('keep-transient'))
            return;
        try {
            for (const source of Main.messageTray.getSources())
                this._hookSource(source);
            this._tHooks.push([Main.messageTray, Main.messageTray.connect('source-added',
                (_t, source) => this._hookSource(source))]);
        } catch (e) {
            this._err(`could not keep short notifications: ${e.message}`);
        }
    }

    _unhookTransient() {
        for (const [obj, id] of this._tHooks ?? []) {
            try {
                obj.disconnect(id);
            } catch (_e) {
                // source is gone
            }
        }
        this._tHooks = [];
    }

    _styleNotify() {
        const n = this._notify;
        if (!n || !this._menu)
            return;
        const light = this._isLight();
        const [r, g, b] = light ? [243, 243, 243] : [36, 36, 36];
        const alpha = this._gs.get_int('opacity') / 100;
        const radius = this._gs.get_int('corner-radius');
        const outer = n.box.width > 0 ? n.box.width : this._panelWidth() + 38;
        const inner = Math.max(200, Math.round(outer - 24));
        const screenHeight = Main.layoutManager.primaryMonitor?.height ?? 1080;
        const maxHeight = Math.max(220, Math.round(screenHeight - (this._baseHeight || 560) - 150));
        n.notifyBox.style = `background-color: rgba(${r}, ${g}, ${b}, ${alpha}); border-radius: ${radius}px; ` +
            `color: ${light ? '#1b1b1b' : '#ffffff'}; width: ${inner}px; min-width: ${inner}px; ` +
            `max-width: ${inner}px; max-height: ${maxHeight}px;`;
    }

    _sequence(object) {
        let value = this._seqs.get(object);
        if (value === undefined) {
            value = ++this._seqCount;
            this._seqs.set(object, value);
        }
        return value;
    }

    // Groups by app, newest app first; inside a group newest first
    _collectNotifications() {
        const groups = [];
        for (const source of Main.messageTray.getSources()) {
            const items = (source.notifications ?? [])
                .filter(notification => notification)
                .map(notification => ({
                    notification,
                    time: notification.datetime?.to_unix?.() ?? 0,
                    seq: this._sequence(notification),
                }))
                .sort((a, b) => b.time - a.time || b.seq - a.seq);
            if (items.length > 0)
                groups.push({source, items});
        }
        groups.sort((a, b) => b.items[0].time - a.items[0].time || b.items[0].seq - a.items[0].seq);
        return groups;
    }

    _dismiss(notification) {
        try {
            notification.destroy(MessageTray.NotificationDestroyedReason?.DISMISSED ?? 2);
        } catch (e) {
            this._err(`could not close a notification: ${e.message}`);
        }
        this._syncNotifications(true);
    }

    _dismissAll() {
        for (const group of this._collectNotifications()) {
            for (const {notification} of group.items) {
                try {
                    notification.destroy(MessageTray.NotificationDestroyedReason?.DISMISSED ?? 2);
                } catch (e) {
                    this._err(`could not close a notification: ${e.message}`);
                }
            }
        }
        this._syncNotifications(true);
    }

    _plain(text) {
        return String(text ?? '')
            .replace(/<[^>]*>/g, '')
            .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
            .replaceAll('&#39;', "'").replaceAll('&amp;', '&');
    }

    _notificationIcon(group, notification) {
        const gicon = notification.gicon ?? group.source.icon ?? group.source.getIcon?.();
        if (gicon)
            return new St.Icon({gicon, icon_size: 20, y_align: Clutter.ActorAlign.CENTER});
        return new St.Icon({icon_name: 'dialog-information-symbolic', icon_size: 20, y_align: Clutter.ActorAlign.CENTER});
    }

    // One app: the newest notification on top. With several, the mouse wheel
    // flips through them, and closing one shows the next.
    _makeNotificationGroup(group) {
        const holder = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            reactive: true,
        });
        const count = group.items.length;
        let index = Math.min(this._views.get(group.source) ?? 0, count - 1);

        const render = () => {
            holder.destroy_all_children();
            const {notification} = group.items[index];
            const card = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'fqp-notif',
                x_expand: true,
            });

            const top = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
            top.add_child(this._notificationIcon(group, notification));
            top.add_child(new St.Label({
                text: this._plain(group.source.title ?? notification.source?.title ?? ''),
                style_class: 'fqp-notif-app',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const when = notification.datetime?.format?.('%H:%M');
            if (when) {
                top.add_child(new St.Label({
                    text: when,
                    style_class: 'fqp-notif-time',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            top.add_child(new St.Widget({x_expand: true}));
            if (count > 1) {
                top.add_child(new St.Label({
                    text: `${index + 1} / ${count}`,
                    style_class: 'fqp-notif-count',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            const close = new St.Button({
                style_class: 'fqp-notif-close',
                reactive: true,
                can_focus: true,
                accessible_name: 'Close this notification',
                child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            });
            close.connect('clicked', () => this._dismiss(notification));
            top.add_child(close);
            card.add_child(top);

            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const title = new St.Label({
                text: this._plain(notification.title),
                style_class: 'fqp-notif-title',
                x_align: Clutter.ActorAlign.START,
            });
            title.clutter_text.line_wrap = true;
            text.add_child(title);
            const bodyText = this._plain(notification.body ?? notification.bannerBodyText ?? '');
            if (bodyText) {
                const body = new St.Label({
                    text: bodyText,
                    style_class: 'fqp-notif-body',
                    x_align: Clutter.ActorAlign.START,
                });
                body.clutter_text.line_wrap = true;
                body.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
                body.clutter_text.set_line_wrap_mode?.(2);
                text.add_child(body);
            }
            const open = new St.Button({
                style_class: 'fqp-notif-open',
                reactive: true,
                can_focus: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                child: text,
            });
            open.connect('clicked', () => this._afterClose(() => notification.activate()));
            card.add_child(open);

            const actions = (notification.actions ?? []).filter(action => action?.label);
            if (actions.length > 0) {
                const row = new St.BoxLayout({style: 'spacing: 8px;', x_expand: true});
                for (const action of actions) {
                    const button = new St.Button({
                        style_class: 'fqp-chip',
                        label: this._plain(action.label),
                        reactive: true,
                        can_focus: true,
                    });
                    button.connect('clicked', () => this._afterClose(() => {
                        this._runAction(action, notification);
                        if (!notification.resident)
                            this._dismiss(notification);
                    }));
                    row.add_child(button);
                }
                card.add_child(row);
            }
            holder.add_child(card);

            // the ones underneath
            for (let i = 1; i <= Math.min(2, count - 1); i++) {
                holder.add_child(new St.Widget({
                    style_class: 'fqp-notif-stack',
                    style: `margin: 0 ${i * 14}px;`,
                }));
            }
        };

        let carry = 0;
        holder.connect('scroll-event', (_actor, event) => {
            if (count < 2)
                return Clutter.EVENT_PROPAGATE;
            let step = 0;
            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                step = -1;
                break;
            case Clutter.ScrollDirection.DOWN:
                step = 1;
                break;
            case Clutter.ScrollDirection.SMOOTH: {
                const [, dy] = event.get_scroll_delta();
                carry += dy;
                if (Math.abs(carry) >= 1) {
                    step = Math.sign(carry);
                    carry = 0;
                }
                break;
            }
            default:
                break;
            }
            if (step === 0)
                return Clutter.EVENT_STOP;
            // wheel down goes to older ones, up goes back; it wraps around
            index = (index + step + count) % count;
            this._views.set(group.source, index);
            render();
            return Clutter.EVENT_STOP;
        });

        render();
        return holder;
    }

    // Rebuilds the list when something changed; the box only shows while
    // there are notifications
    _syncNotifications(force = false) {
        const n = this._notify;
        if (!n)
            return;
        let groups = [];
        try {
            groups = this._collectNotifications();
        } catch (e) {
            if (!this._notifyFailed) {
                this._notifyFailed = true;
                this._err(`could not read notifications: ${e.message}`);
            }
        }
        const signature = groups.map(group => group.items.map(({notification}) =>
            `${this._sequence(notification)}:${notification.title}:${notification.body}`).join(',')).join('|');
        if (force || signature !== n.signature) {
            n.signature = signature;
            try {
                // forget views of apps that are gone
                const sources = new Set(groups.map(group => group.source));
                for (const source of [...this._views.keys()]) {
                    if (!sources.has(source))
                        this._views.delete(source);
                }
                n.content.destroy_all_children();
                for (const group of groups)
                    n.content.add_child(this._makeNotificationGroup(group));
            } catch (e) {
                this._err(`could not draw notifications: ${e.message}`);
            }
        }
        const show = groups.length > 0;
        if (n.notifyBox.visible !== show) {
            n.notifyBox.visible = show;
            if (show)
                this._styleNotify();
        }
    }

    _weekStartIndex() {
        // 0 = Monday ... 6 = Sunday, the way GLib counts days of the week
        switch (this._gs.get_string('week-start')) {
        case 'sunday':
            return 6;
        case 'saturday':
            return 5;
        default:
            return 0;
        }
    }

    _renderCalendar(root, state, render) {
        const first = GLib.DateTime.new_local(state.year, state.month, 1, 0, 0, 0);
        const today = GLib.DateTime.new_now_local();
        const startIndex = this._weekStartIndex();

        const step = delta => {
            state.month += delta;
            if (state.month < 1) {
                state.month = 12;
                state.year -= 1;
            } else if (state.month > 12) {
                state.month = 1;
                state.year += 1;
            }
            render();
        };
        const navButton = (icon, delta) => {
            const button = new St.Button({
                style_class: 'fqp-back',
                reactive: true,
                can_focus: true,
                child: new St.Icon({icon_name: icon, icon_size: 16}),
            });
            button.connect('clicked', () => step(delta));
            return button;
        };

        const nav = new St.BoxLayout({style_class: 'fqp-cal-nav', x_expand: true});
        nav.add_child(navButton('go-previous-symbolic', -1));
        nav.add_child(new St.Label({
            text: first.format('%B %Y') ?? '',
            style_class: 'fqp-cal-month',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        nav.add_child(navButton('go-next-symbolic', 1));
        root.add_child(nav);

        const grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true}),
            x_expand: true,
        });
        // 2024-01-01 was a Monday, so these seven days give the names in order
        for (let i = 0; i < 7; i++) {
            const day = GLib.DateTime.new_local(2024, 1, 1 + ((startIndex + i) % 7), 0, 0, 0);
            grid.layout_manager.attach(new St.Label({
                text: day.format('%a') ?? '',
                style_class: 'fqp-cal-weekday',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }), i, 0, 1, 1);
        }

        const offset = (first.get_day_of_week() - 1 - startIndex + 7) % 7;
        for (let i = 0; i < 42; i++) {
            const date = first.add_days(i - offset);
            const classes = ['fqp-cal-day'];
            if (date.get_month() !== state.month)
                classes.push('fqp-cal-other');
            if (date.format('%F') === today.format('%F'))
                classes.push('fqp-cal-today');
            if (date.format('%F') === state.selected.format('%F'))
                classes.push('fqp-cal-selected');
            const button = new St.Button({
                style_class: classes.join(' '),
                label: String(date.get_day_of_month()),
                reactive: true,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => {
                state.selected = date;
                state.select?.(date);
                render();
            });
            grid.layout_manager.attach(button, i % 7, 1 + Math.floor(i / 7), 1, 1);
        }
        root.add_child(grid);

        root.add_child(new St.Label({
            text: state.selected.format('%A, %e %B %Y') ?? '',
            style_class: 'fqp-cal-selected-label',
            x_align: Clutter.ActorAlign.CENTER,
        }));
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
        const lower = className.toLowerCase();
        const match = FRIENDLY_NAMES.find(([part]) => lower.includes(part.toLowerCase()));
        if (match)
            return match[1];
        if (typeof child.title === 'string' && child.title)
            return child.title;
        return className.replace(/Toggle$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    _wantedVisible(info) {
        if (info.userHidden)
            return false;
        return info.gnomeVisible;
    }

    _enforce(child, info) {
        const wanted = this._wantedVisible(info);
        if (child.visible === wanted)
            return;
        info.self = true;
        try {
            child.visible = wanted;
        } finally {
            info.self = false;
        }
    }

    _track(child) {
        const info = {
            gnomeVisible: child.visible,
            userHidden: false,
            self: false,
            sig: 0,
            menuSig: 0,
            menuObj: null,
            styled: false,
        };
        // GNOME shows and hides its own items; this keeps our choices on top
        info.sig = child.connect('notify::visible', () => {
            if (info.self)
                return;
            const before = info.gnomeVisible;
            info.gnomeVisible = child.visible;
            this._enforce(child, info);
            if (before !== info.gnomeVisible)
                this._queueScan();
        });
        if (child.menu?.actor) {
            const opened = open => {
                if (this._busy)
                    return;
                if (open)
                    defer(() => this._openTilePage(child, info));
                else if (this._page?.owner === child)
                    defer(() => this._closePage());
            };
            try {
                info.menuObj = child.menu;
                info.menuSig = child.menu.connect('open-state-changed', (_m, open) => opened(open));
            } catch (e) {
                info.menuObj = null;
                this._err(`no open-state signal for ${child.constructor?.name}: ${e.message}`);
            }
            // The menu's widget showing up is a second way to notice it opened
            info.menuActor = child.menu.actor;
            info.menuActorSig = info.menuActor.connect('notify::visible', () => opened(info.menuActor.visible));
        }
        return info;
    }

    // Find what the panel contains, remember it for the settings window, and
    // apply the "hide" choices.
    _scan() {
        if (!this._grid)
            return;
        const children = this._grid.get_children();
        const menuActors = new Set(children.map(c => c.menu?.actor).filter(Boolean));
        const items = children.filter(c => !this._own.has(c) && !menuActors.has(c) &&
            c.constructor?.name !== 'Clutter_Actor');
        const seen = new Map();
        const known = [];

        for (const child of items) {
            const className = child.constructor?.name ?? 'Item';
            const index = seen.get(className) ?? 0;
            seen.set(className, index + 1);

            let info = this._items.get(child);
            if (!info) {
                info = this._track(child);
                this._items.set(child, info);
            }
            info.id = index === 0 ? className : `${className}:${index}`;
            info.title = this._friendlyName(child, className);
            known.push(`${info.id}|${info.gnomeVisible ? 1 : 0}|${info.title}`);
        }

        // Forget widgets that are no longer in the panel
        for (const child of [...this._items.keys()]) {
            if (!items.includes(child)) {
                const info = this._items.get(child);
                try {
                    child.disconnect(info.sig);
                    if (info.menuSig && info.menuObj)
                        info.menuObj.disconnect(info.menuSig);
                    if (info.menuActorSig)
                        info.menuActor.disconnect(info.menuActorSig);
                } catch (_e) {
                    // widget is gone
                }
                this._items.delete(child);
            }
        }

        const current = this._gs.get_strv('known-items');
        if (current.length !== known.length || current.some((v, i) => v !== known[i]))
            this._gs.set_strv('known-items', known);

        this._applyPolicies();
        this._styleTiles();
        this._arrange();
    }

    _applyPolicies() {
        if (!this._gs)
            return;
        const hidden = new Set(this._gs.get_strv('hidden-items'));
        for (const [child, info] of this._items) {
            info.userHidden = hidden.has(info.id);
            this._enforce(child, info);
        }
    }

    // ---- columns -----------------------------------------------------------

    _isToggle(child) {
        return 'checked' in child && 'title' in child;
    }

    _setColumns(count) {
        const layout = this._grid.layout_manager;
        if (!layout || !('nColumns' in layout))
            throw new Error('the panel layout has no column setting');
        layout.nColumns = count;
        // Sliders, headings and menus stretch over the whole row
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
        const wanted = this._gs.get_int('tile-columns') === 3 ? 3 : this._originalColumns;
        if (layout.nColumns === wanted)
            return;
        const before = layout.nColumns;
        try {
            this._setColumns(wanted);
        } catch (e) {
            this._err(`could not change the columns, putting them back: ${e.message}`);
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
