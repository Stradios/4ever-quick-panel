// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SWATCHES = [
    ['#d32f2f', 'Red'],
    ['#ff5722', 'Orange'],
    ['#ffc107', 'Yellow'],
    ['#0f9d58', 'Green'],
    ['#00574b', 'Dark teal'],
    ['#1565c0', 'Blue'],
    ['#6200ea', 'Purple'],
    ['#00bcd4', 'Cyan'],
    ['#455a64', 'Grey'],
];

export default class FourEverQuickPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlers = [];
        window.connect('close-request', () => {
            for (const id of handlers)
                settings.disconnect(id);
            handlers.length = 0;
            return false;
        });
        window.set_default_size(620, 720);
        const watch = (key, callback) => handlers.push(settings.connect(`changed::${key}`, callback));

        // Swatch colors need their own CSS, one class per color
        const css = new Gtk.CssProvider();
        css.load_from_string(SWATCHES.map(([hex], i) =>
            `button.fqp-swatch-${i} { background: ${hex}; min-width: 30px; min-height: 30px; ` +
            'border-radius: 9px; padding: 0; color: white; }').join('\n'));
        const display = Gdk.Display.get_default();
        if (display)
            Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const group = (title, description) => new Adw.PreferencesGroup({title, description});

        const spinRow = (title, subtitle, key, min, max, step) => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({
                    lower: min,
                    upper: max,
                    step_increment: step,
                    page_increment: step * 5,
                    value: settings.get_int(key),
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const switchRow = (title, subtitle, key) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        // ---------------- Look ----------------
        const lookPage = new Adw.PreferencesPage({title: 'Look', icon_name: 'applications-graphics-symbolic'});

        const accentGroup = group('Accent color', 'Used for switched-on tiles and the sliders. Orange is the default.');
        const swatchRow = new Adw.ActionRow({title: 'Colors'});
        const swatchBox = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER, margin_top: 8, margin_bottom: 8});
        const swatchButtons = [];
        SWATCHES.forEach(([hex, name], i) => {
            const button = new Gtk.Button({tooltip_text: name, valign: Gtk.Align.CENTER});
            button.add_css_class(`fqp-swatch-${i}`);
            button.connect('clicked', () => settings.set_string('accent-color', hex));
            swatchBox.append(button);
            swatchButtons.push([hex, button]);
        });
        swatchRow.add_suffix(swatchBox);

        const customRow = new Adw.ActionRow({title: 'Custom color'});
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const syncAccent = () => {
            const current = settings.get_string('accent-color').toLowerCase();
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(current))
                rgba.parse('#ff5722');
            colorButton.rgba = rgba;
            for (const [hex, button] of swatchButtons)
                button.icon_name = hex === current ? 'object-select-symbolic' : '';
        };
        syncAccent();
        watch('accent-color', syncAccent);
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.rgba;
            const hex = '#' + [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            if (settings.get_string('accent-color').toLowerCase() !== hex)
                settings.set_string('accent-color', hex);
        });
        customRow.add_suffix(colorButton);
        accentGroup.add(swatchRow);
        accentGroup.add(customRow);
        lookPage.add(accentGroup);

        const shapeGroup = group('Panel', 'The panel follows the system light or dark style.');
        shapeGroup.add(spinRow('Opacity', 'Percent opaque. 100 is solid, 0 is see-through.', 'opacity', 0, 100, 1));
        shapeGroup.add(spinRow('Corner radius', 'In pixels.', 'corner-radius', 8, 40, 2));
        lookPage.add(shapeGroup);
        window.add(lookPage);

        // ---------------- Layout ----------------
        const layoutPage = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-grid-symbolic'});
        const extraGroup = group('Extras', null);
        extraGroup.add(switchRow('Name and picture', 'Shows your account name and picture at the top.', 'show-header'));
        extraGroup.add(switchRow('Date and time', 'Shows the date and time at the bottom.', 'show-footer'));
        layoutPage.add(extraGroup);

        const columnsGroup = group('Tiles', null);
        columnsGroup.add(spinRow('Tiles per row',
            'Experimental: 3 reaches into GNOME’s own panel layout. If it looks wrong, set it back to 2.',
            'columns', 2, 3, 1));
        layoutPage.add(columnsGroup);
        window.add(layoutPage);

        // ---------------- Items ----------------
        const itemsPage = new Adw.PreferencesPage({title: 'Tiles', icon_name: 'view-list-symbolic'});
        const itemsGroup = group('Tiles and sliders',
            'Turn off what you do not use. This list is what GNOME shows on this computer, so it can differ between computers.');
        itemsPage.add(itemsGroup);
        window.add(itemsPage);

        let rows = [];
        let updating = false;
        const renderItems = () => {
            for (const row of rows)
                itemsGroup.remove(row);
            rows = [];
            const known = settings.get_strv('known-items');
            const hidden = new Set(settings.get_strv('hidden-items'));
            if (known.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'Nothing found yet',
                    subtitle: 'Turn the extension on and log in again. The tiles show up here once it has seen the panel.',
                });
                itemsGroup.add(empty);
                rows.push(empty);
                return;
            }
            for (const entry of known) {
                const [id, ...rest] = entry.split('|');
                const row = new Adw.SwitchRow({title: rest.join('|') || id, subtitle: id, active: !hidden.has(id)});
                row.connect('notify::active', () => {
                    if (updating)
                        return;
                    const now = new Set(settings.get_strv('hidden-items'));
                    if (row.active)
                        now.delete(id);
                    else
                        now.add(id);
                    updating = true;
                    settings.set_strv('hidden-items', [...now]);
                    updating = false;
                });
                itemsGroup.add(row);
                rows.push(row);
            }
        };
        renderItems();
        watch('known-items', renderItems);
        watch('hidden-items', () => {
            if (!updating)
                renderItems();
        });
    }
}
