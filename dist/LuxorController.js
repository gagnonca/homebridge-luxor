"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LuxorController = exports.MAX_PALETTE_COLOR = exports.LightType = exports.ControllerType = void 0;
const node_events_1 = require("node:events");
const LuxorClient_1 = require("./LuxorClient");
var ControllerType;
(function (ControllerType) {
    ControllerType["ZD"] = "ZD";
    ControllerType["ZDC"] = "ZDC";
    ControllerType["ZDTWO"] = "ZDTWO";
})(ControllerType || (exports.ControllerType = ControllerType = {}));
var LightType;
(function (LightType) {
    LightType["ZD"] = "ZD";
    LightType["ZDC"] = "ZDC";
    LightType["THEME"] = "Theme";
})(LightType || (exports.LightType = LightType = {}));
// Values above this are color wheels or DMX control, which HomeKit can't drive.
exports.MAX_PALETTE_COLOR = 250;
// The controller holds the last known state of every group/theme/color.  HomeKit reads are
// answered from this snapshot, never from the network, so a slow controller can't make the
// Home app show "No Response" just by opening it.  The snapshot is refreshed by polling and
// shortly after every command.  'update' is emitted after each successful refresh.
class LuxorController extends node_events_1.EventEmitter {
    name;
    type;
    client;
    log;
    opts;
    groups = new Map();
    themes = new Map();
    colors = new Map();
    lastSuccess = 0;
    offline = false;
    polling = false;
    stopped = false;
    pollTimer;
    warnedColorWheel = new Set();
    constructor(name, type, client, log, opts) {
        super();
        this.name = name;
        this.type = type;
        this.client = client;
        this.log = log;
        this.opts = opts;
        this.setMaxListeners(0); // one listener per accessory
    }
    static detectType(controllerName) {
        switch (controllerName.substring(0, 5)) {
            case 'luxor': return ControllerType.ZD;
            case 'lxzdc': return ControllerType.ZDC;
            case 'lxtwo': return ControllerType.ZDTWO;
            default: return undefined;
        }
    }
    get supportsColor() {
        return this.type !== ControllerType.ZD;
    }
    // Treat the cached state as trustworthy for a few missed polls before admitting the
    // controller is gone.
    isResponsive() {
        return Date.now() - this.lastSuccess < Math.max(5 * 60 * 1000, 3 * this.opts.pollInterval);
    }
    async refresh() {
        if (!this.opts.hideGroups) {
            const groups = await this.call('GroupListGet');
            this.applyGroups(groups.GroupList || []);
        }
        const themes = await this.call('ThemeListGet');
        this.applyThemes(themes.ThemeList || []);
        if (this.supportsColor) {
            const colors = await this.call('ColorListGet');
            this.applyColors(colors.ColorList || []);
        }
        this.emit('update');
    }
    startPolling() {
        this.schedulePoll(this.opts.pollInterval);
    }
    // Pull fresh state soon, e.g. after a theme changes many groups at once.
    refreshSoon(delay = 1500) {
        this.schedulePoll(delay);
    }
    stop() {
        this.stopped = true;
        clearTimeout(this.pollTimer);
    }
    async illuminateGroup(group, intensity) {
        await this.call('IlluminateGroup', { GroupNumber: group, Intensity: intensity });
        const g = this.groups.get(group);
        if (g)
            g.intensity = intensity;
    }
    async illuminateTheme(index, on) {
        await this.call('IlluminateTheme', { ThemeIndex: index, OnOff: on ? 1 : 0 });
        this.refreshSoon();
    }
    async illuminateAll() {
        await this.call('IlluminateAll');
        this.refreshSoon();
    }
    async extinguishAll() {
        await this.call('ExtinguishAll');
        this.refreshSoon();
    }
    async setColor(color, hue, sat) {
        await this.call('ColorListSet', { C: color, Hue: hue, Sat: sat });
        this.colors.set(color, { hue, sat });
    }
    async assignGroupColor(group, color) {
        const g = this.groups.get(group);
        await this.call('GroupListEdit', { Name: g?.name, GroupNumber: group, Color: color });
        if (g)
            g.color = color;
    }
    async call(method, body) {
        const result = await this.client.request(method, body);
        this.lastSuccess = Date.now();
        return result;
    }
    schedulePoll(delay) {
        if (this.stopped)
            return;
        clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => this.poll(), delay);
    }
    async poll() {
        if (this.polling)
            return;
        this.polling = true;
        try {
            await this.refresh();
            if (this.offline)
                this.log.info(`Reconnected to controller ${this.name}.`);
            this.offline = false;
        }
        catch (err) {
            // Log the first failure loudly and the rest quietly so a dead controller doesn't flood the log.
            if (!this.offline)
                this.log.warn(`Lost contact with controller ${this.name}: ${(0, LuxorClient_1.errorMessage)(err)}.  Will keep retrying.`);
            else
                this.log.debug(`Controller ${this.name} still unreachable: ${(0, LuxorClient_1.errorMessage)(err)}`);
            this.offline = true;
        }
        finally {
            this.polling = false;
            this.schedulePoll(this.opts.pollInterval);
        }
    }
    applyGroups(list) {
        const next = new Map();
        for (const raw of list) {
            // ZD answers with GroupNumber/Intensity, ZDC and ZDTWO with Grp/Inten/Colr
            const number = raw.GroupNumber ?? raw.Grp;
            if (typeof number !== 'number')
                continue;
            const color = this.supportsColor ? (raw.Color ?? raw.Colr ?? 0) : 0;
            if (color > exports.MAX_PALETTE_COLOR && !this.warnedColorWheel.has(number)) {
                this.warnedColorWheel.add(number);
                this.log.warn(`Light group ${number} uses color ${color}.  Values 251-260 are color wheels and 65535 means DMX control; ` +
                    `pick a palette color (0-250) on the controller to control its color from HomeKit.`);
            }
            next.set(number, {
                number,
                name: raw.Name ?? `Group ${number}`,
                intensity: raw.Intensity ?? raw.Inten ?? 0,
                color,
                type: color === 0 ? LightType.ZD : LightType.ZDC,
            });
        }
        this.groups = next;
    }
    applyThemes(list) {
        const next = new Map();
        for (const raw of list) {
            if (typeof raw.ThemeIndex !== 'number')
                continue;
            next.set(raw.ThemeIndex, { index: raw.ThemeIndex, name: raw.Name ?? `Theme ${raw.ThemeIndex}`, on: raw.OnOff === 1 });
        }
        this.themes = next;
    }
    applyColors(list) {
        const next = new Map();
        for (const raw of list) {
            if (typeof raw.C !== 'number')
                continue;
            next.set(raw.C, { hue: raw.Hue ?? 0, sat: raw.Sat ?? 0 });
        }
        this.colors = next;
    }
}
exports.LuxorController = LuxorController;
//# sourceMappingURL=LuxorController.js.map