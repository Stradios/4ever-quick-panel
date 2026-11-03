// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
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
        shapeGroup.add(spinRow('Panel corner radius', 'In pixels.', 'corner-radius', 8, 40, 2));
        lookPage.add(shapeGroup);

        const tileGroup = group('Tiles', null);
        tileGroup.add(spinRow('Tile corner radius', 'In pixels. 0 is square, 30 is almost round.', 'tile-radius', 0, 30, 1));
        tileGroup.add(spinRow('Tile height', 'In pixels. 0 adapts to the screen and text size.', 'tile-height', 0, 96, 2));
        lookPage.add(tileGroup);
        window.add(lookPage);

        // ---------------- Layout ----------------
        const layoutPage = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-grid-symbolic'});

        const sizeGroup = group('Size', 'By default the panel adapts to your screen size and text size, so it looks right on a laptop, a big monitor or a scaled display.');
        sizeGroup.add(spinRow('Panel width', 'In pixels. 0 adapts automatically.', 'width', 0, 1400, 10));
        sizeGroup.add(spinRow('Tiles per row', 'If 3 looks wrong on your system, set it to 2.', 'tile-columns', 2, 3, 1));
        layoutPage.add(sizeGroup);

        const extraGroup = group('Extras', null);
        extraGroup.add(switchRow('Name and picture', 'Shows your account name and picture at the top.', 'show-header'));
        extraGroup.add(switchRow('Date and calendar', 'Shows the date at the bottom. Clicking it opens a calendar inside the panel.', 'show-footer'));
        extraGroup.add(switchRow('Headings', 'Shows the Quick Controls and Shortcuts headings.', 'show-headings'));
        extraGroup.add(switchRow('Shortcuts row', 'Shows your own shortcuts. Edit them on the Shortcuts page.', 'show-shortcuts'));
        extraGroup.add(switchRow('Pages inside the panel',
            'A tile’s arrow (Wi-Fi, Bluetooth, …) opens a page with a back button instead of a card under the tiles.',
            'inline-pages'));
        extraGroup.add(switchRow('Notifications box',
            'Shows your notifications in a box above the panel, only while there are any.', 'show-notifications'));
        extraGroup.add(switchRow('Keep short notifications',
            'GNOME removes some notifications when their banner goes away, like the screenshot one. This keeps them in the list until you close them.',
            'keep-transient'));
        extraGroup.add(switchRow('Taskbar clock opens this calendar',
            'Clicking the date and time on the taskbar opens the panel on the calendar page instead of GNOME\u2019s own calendar popup.',
            'clock-opens-panel'));
        layoutPage.add(extraGroup);

        const testGroup = group('Test notifications',
            'Sends real notifications, so you can see the box above the panel. A banner appears first; after it goes away the notification stays in the list. Open the panel to see it.');
        const sendTest = count => {
            for (let i = 1; i <= count; i++) {
                const stamp = GLib.DateTime.new_now_local().format('%H:%M:%S');
                Gio.DBus.session.call(
                    'org.freedesktop.Notifications', '/org/freedesktop/Notifications',
                    'org.freedesktop.Notifications', 'Notify',
                    new GLib.Variant('(susssasa{sv}i)', [
                        '4ever Quick Panel', 0, 'dialog-information-symbolic',
                        count > 1 ? `Test notification ${i} of ${count}` : 'Test notification',
                        `Sent at ${stamp}. If you can read this in the box above the panel, it works.`,
                        [], {}, 4000,
                    ]),
                    null, Gio.DBusCallFlags.NONE, -1, null, null);
            }
        };
        const testOne = new Adw.ButtonRow({title: 'Send a test notification', start_icon_name: 'preferences-system-notifications-symbolic'});
        testOne.connect('activated', () => sendTest(1));
        const testMany = new Adw.ButtonRow({title: 'Send 6 test notifications', start_icon_name: 'preferences-system-notifications-symbolic'});
        testMany.connect('activated', () => sendTest(6));
        testGroup.add(testOne);
        testGroup.add(testMany);
        layoutPage.add(testGroup);

        const calendarGroup = group('Calendar', null);
        const weekDays = [['monday', 'Monday'], ['sunday', 'Sunday'], ['saturday', 'Saturday']];
        const weekRow = new Adw.ComboRow({
            title: 'Week starts on',
            model: Gtk.StringList.new(weekDays.map(([, label]) => label)),
        });
        const syncWeek = () => {
            const index = weekDays.findIndex(([key]) => key === settings.get_string('week-start'));
            weekRow.selected = index >= 0 ? index : 0;
        };
        syncWeek();
        weekRow.connect('notify::selected', () => {
            const key = weekDays[weekRow.selected]?.[0];
            if (key && key !== settings.get_string('week-start'))
                settings.set_string('week-start', key);
        });
        calendarGroup.add(weekRow);
        layoutPage.add(calendarGroup);
        window.add(layoutPage);

        // ---------------- Shortcuts ----------------
        const shortcutsPage = new Adw.PreferencesPage({title: 'Shortcuts', icon_name: 'starred-symbolic'});
        const shortcutsGroup = group('Shortcuts',
            'Buttons in the panel that open an app or a link. The command can be an app (like org.gnome.Nautilus.desktop), a command, or a web address.');
        shortcutsPage.add(shortcutsGroup);
        window.add(shortcutsPage);

        const readShortcuts = () => settings.get_strv('shortcuts').map(entry => {
            const [name, icon, ...command] = entry.split('|');
            return {name: name ?? '', icon: icon ?? '', command: command.join('|')};
        });
        const writeShortcuts = list => settings.set_strv('shortcuts',
            list.map(s => `${s.name.replaceAll('|', ' ')}|${s.icon.replaceAll('|', ' ')}|${s.command}`));

        let shortcutRows = [];
        const renderShortcuts = () => {
            for (const row of shortcutRows)
                shortcutsGroup.remove(row);
            shortcutRows = [];
            const list = readShortcuts();
            list.forEach((shortcut, i) => {
                const row = new Adw.ActionRow({title: shortcut.name || shortcut.command, subtitle: shortcut.command});
                const icon = new Gtk.Image({icon_name: shortcut.icon || 'application-x-executable-symbolic'});
                row.add_prefix(icon);
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove',
                });
                remove.add_css_class('flat');
                remove.connect('clicked', () => {
                    const now = readShortcuts();
                    now.splice(i, 1);
                    writeShortcuts(now);
                });
                row.add_suffix(remove);
                shortcutsGroup.add(row);
                shortcutRows.push(row);
            });
            const add = new Adw.ButtonRow({title: 'Add a shortcut', start_icon_name: 'list-add-symbolic'});
            add.connect('activated', () => addShortcutDialog());
            shortcutsGroup.add(add);
            shortcutRows.push(add);
        };

        const addShortcutDialog = () => {
            const apps = Gio.AppInfo.get_all()
                .filter(app => app.should_show() && app.get_id())
                .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
            const dialog = new Adw.AlertDialog({
                heading: 'Add a shortcut',
                body: 'Pick an installed app, or fill in the fields yourself.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('add', 'Add');
            dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
            dialog.set_default_response('add');

            const box = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
            box.add_css_class('boxed-list');
            const appRow = new Adw.ComboRow({
                title: 'Installed app',
                model: Gtk.StringList.new(['(none)', ...apps.map(app => app.get_display_name())]),
            });
            const nameRow = new Adw.EntryRow({title: 'Name'});
            const iconRow = new Adw.EntryRow({title: 'Icon name or file path'});
            const commandRow = new Adw.EntryRow({title: 'App, command or web address'});
            appRow.connect('notify::selected', () => {
                const app = apps[appRow.selected - 1];
                if (!app)
                    return;
                nameRow.text = app.get_display_name();
                commandRow.text = app.get_id();
                const icon = app.get_icon();
                iconRow.text = icon instanceof Gio.ThemedIcon ? icon.get_names()[0] ?? '' : '';
            });
            for (const row of [appRow, nameRow, iconRow, commandRow])
                box.append(row);
            dialog.set_extra_child(box);

            dialog.connect('response', (_d, response) => {
                if (response !== 'add' || !commandRow.text.trim())
                    return;
                const list = readShortcuts();
                list.push({
                    name: nameRow.text.trim() || commandRow.text.trim(),
                    icon: iconRow.text.trim(),
                    command: commandRow.text.trim(),
                });
                writeShortcuts(list);
            });
            dialog.present(window);
        };
        renderShortcuts();
        watch('shortcuts', renderShortcuts);

        // ---------------- Items ----------------
        const itemsPage = new Adw.PreferencesPage({title: 'Tiles', icon_name: 'view-list-symbolic'});
        const itemsGroup = group('Tiles and sliders',
            'Turn off what you do not use. Greyed entries are things GNOME is not showing right now (for example Mobile data without a modem).');
        itemsPage.add(itemsGroup);
        window.add(itemsPage);

        // The panel's "+" button asks for the Shortcuts page
        const wanted = settings.get_string('prefs-page');
        if (wanted === 'shortcuts') {
            window.set_visible_page(shortcutsPage);
            settings.set_string('prefs-page', '');
        }

        let rows = [];
        let updating = false;
        const toggleIn = (key, id, on) => {
            const now = new Set(settings.get_strv(key));
            if (on)
                now.add(id);
            else
                now.delete(id);
            updating = true;
            settings.set_strv(key, [...now]);
            updating = false;
        };
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
                const parts = entry.split('|');
                const id = parts[0];
                // new format: id|1|name  (older: id|name)
                const hasFlag = parts.length >= 3 && (parts[1] === '0' || parts[1] === '1');
                const available = hasFlag ? parts[1] === '1' : true;
                const title = (hasFlag ? parts.slice(2) : parts.slice(1)).join('|') || id;

                const row = new Adw.SwitchRow({
                    title,
                    subtitle: available ? id : `${id} · not available right now`,
                    active: !hidden.has(id),
                });
                if (!available)
                    row.add_css_class('dim-label');
                row.connect('notify::active', () => {
                    if (!updating)
                        toggleIn('hidden-items', id, !row.active);
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
