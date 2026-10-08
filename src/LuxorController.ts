import { EventEmitter } from 'node:events';
import { Logger } from 'homebridge';
import { LuxorClient, errorMessage } from './LuxorClient';

export enum ControllerType {
  ZD = 'ZD', ZDC = 'ZDC', ZDTWO = 'ZDTWO'
}

export enum LightType {
  ZD = 'ZD', ZDC = 'ZDC', THEME = 'Theme'
}

export interface Group {
  number: number;
  name: string;
  intensity: number;
  // ZDC/ZDTWO only. 0 = no color, 1-250 = color palette slot, 251-260 = color wheel, 65535 = DMX
  color: number;
  type: LightType.ZD | LightType.ZDC;
}

export interface ThemeState {
  index: number;
  name: string;
  on: boolean;
}

export interface Color {
  hue: number;
  sat: number;
}

export interface ControllerOptions {
  pollInterval: number; // ms
  hideGroups: boolean;
}

// Values above this are color wheels or DMX control, which HomeKit can't drive.
export const MAX_PALETTE_COLOR = 250;

// The controller holds the last known state of every group/theme/color.  HomeKit reads are
// answered from this snapshot, never from the network, so a slow controller can't make the
// Home app show "No Response" just by opening it.  The snapshot is refreshed by polling and
// shortly after every command.  'update' is emitted after each successful refresh.
export class LuxorController extends EventEmitter {
  groups = new Map<number, Group>();
  themes = new Map<number, ThemeState>();
  colors = new Map<number, Color>();

  private lastSuccess = 0;
  private offline = false;
  private polling = false;
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;
  private warnedColorWheel = new Set<number>();

  constructor(
    readonly name: string,
    readonly type: ControllerType,
    private readonly client: LuxorClient,
    private readonly log: Logger,
    private readonly opts: ControllerOptions,
  ) {
    super();
    this.setMaxListeners(0); // one listener per accessory
  }

  static detectType(controllerName: string): ControllerType | undefined {
    switch (controllerName.substring(0, 5)) {
      case 'luxor': return ControllerType.ZD;
      case 'lxzdc': return ControllerType.ZDC;
      case 'lxtwo': return ControllerType.ZDTWO;
      default: return undefined;
    }
  }

  get supportsColor(): boolean {
    return this.type !== ControllerType.ZD;
  }

  // Treat the cached state as trustworthy for a few missed polls before admitting the
  // controller is gone.
  isResponsive(): boolean {
    return Date.now() - this.lastSuccess < Math.max(5 * 60 * 1000, 3 * this.opts.pollInterval);
  }

  async refresh(): Promise<void> {
    if (!this.opts.hideGroups) {
      const groups = await this.call<{ GroupList: any[] }>('GroupListGet');
      this.applyGroups(groups.GroupList || []);
    }
    const themes = await this.call<{ ThemeList: any[] }>('ThemeListGet');
    this.applyThemes(themes.ThemeList || []);
    if (this.supportsColor) {
      const colors = await this.call<{ ColorList: any[] }>('ColorListGet');
      this.applyColors(colors.ColorList || []);
    }
    this.emit('update');
  }

  startPolling(): void {
    this.schedulePoll(this.opts.pollInterval);
  }

  // Pull fresh state soon, e.g. after a theme changes many groups at once.
  refreshSoon(delay = 1500): void {
    this.schedulePoll(delay);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
  }

  async illuminateGroup(group: number, intensity: number): Promise<void> {
    await this.call('IlluminateGroup', { GroupNumber: group, Intensity: intensity });
    const g = this.groups.get(group);
    if (g) g.intensity = intensity;
  }

  async illuminateTheme(index: number, on: boolean): Promise<void> {
    await this.call('IlluminateTheme', { ThemeIndex: index, OnOff: on ? 1 : 0 });
    this.refreshSoon();
  }

  async illuminateAll(): Promise<void> {
    await this.call('IlluminateAll');
    this.refreshSoon();
  }

  async extinguishAll(): Promise<void> {
    await this.call('ExtinguishAll');
    this.refreshSoon();
  }

  async setColor(color: number, hue: number, sat: number): Promise<void> {
    await this.call('ColorListSet', { C: color, Hue: hue, Sat: sat });
    this.colors.set(color, { hue, sat });
  }

  async assignGroupColor(group: number, color: number): Promise<void> {
    const g = this.groups.get(group);
    await this.call('GroupListEdit', { Name: g?.name, GroupNumber: group, Color: color });
    if (g) g.color = color;
  }

  private async call<T = any>(method: string, body?: object): Promise<T> {
    const result = await this.client.request<T>(method, body);
    this.lastSuccess = Date.now();
    return result;
  }

  private schedulePoll(delay: number): void {
    if (this.stopped) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.refresh();
      if (this.offline) this.log.info(`Reconnected to controller ${this.name}.`);
      this.offline = false;
    }
    catch (err) {
      // Log the first failure loudly and the rest quietly so a dead controller doesn't flood the log.
      if (!this.offline) this.log.warn(`Lost contact with controller ${this.name}: ${errorMessage(err)}.  Will keep retrying.`);
      else this.log.debug(`Controller ${this.name} still unreachable: ${errorMessage(err)}`);
      this.offline = true;
    }
    finally {
      this.polling = false;
      this.schedulePoll(this.opts.pollInterval);
    }
  }

  private applyGroups(list: any[]): void {
    const next = new Map<number, Group>();
    for (const raw of list) {
      // ZD answers with GroupNumber/Intensity, ZDC and ZDTWO with Grp/Inten/Colr
      const number = raw.GroupNumber ?? raw.Grp;
      if (typeof number !== 'number') continue;
      const color = this.supportsColor ? (raw.Color ?? raw.Colr ?? 0) : 0;
      if (color > MAX_PALETTE_COLOR && !this.warnedColorWheel.has(number)) {
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

  private applyThemes(list: any[]): void {
    const next = new Map<number, ThemeState>();
    for (const raw of list) {
      if (typeof raw.ThemeIndex !== 'number') continue;
      next.set(raw.ThemeIndex, { index: raw.ThemeIndex, name: raw.Name ?? `Theme ${raw.ThemeIndex}`, on: raw.OnOff === 1 });
    }
    this.themes = next;
  }

  private applyColors(list: any[]): void {
    const next = new Map<number, Color>();
    for (const raw of list) {
      if (typeof raw.C !== 'number') continue;
      next.set(raw.C, { hue: raw.Hue ?? 0, sat: raw.Sat ?? 0 });
    }
    this.colors = next;
  }
}
