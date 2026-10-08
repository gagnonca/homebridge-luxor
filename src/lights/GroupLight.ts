import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { LuxorPlatform, AccessoryContext } from '../LuxorPlatform';
import { LightType, LuxorController, MAX_PALETTE_COLOR } from '../LuxorController';
import { errorMessage, sleep } from '../LuxorClient';

// HomeKit sends On + Brightness (or Hue + Saturation) as separate writes a few ms apart.
// Collect them for this long and send a single command to the controller.
const COALESCE_MS = 60;

interface PendingChange {
  on?: boolean;
  brightness?: number;
  hue?: number;
  sat?: number;
}

// A Luxor light group: dimmable on ZD, dimmable + color on ZDC/ZDTWO.
export class GroupLight {
  private readonly service: Service;
  private readonly context: AccessoryContext;
  private pending: PendingChange = {};
  private flushTimer?: NodeJS.Timeout;
  private waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  constructor(
    private readonly platform: LuxorPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly controller: LuxorController,
  ) {
    this.context = accessory.context as AccessoryContext;
    const { Service, Characteristic } = platform;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Luxor')
      .setCharacteristic(Characteristic.Model, this.context.type)
      .setCharacteristic(Characteristic.SerialNumber, accessory.UUID);

    this.service = accessory.getService(Service.Lightbulb) || accessory.addService(Service.Lightbulb);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.whenResponsive(this.isOn))
      .onSet(value => this.queueChange({ on: value as boolean }));
    this.service.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.whenResponsive(this.displayBrightness))
      .onSet(value => this.queueChange({ brightness: value as number }));

    if (this.hasColor) {
      this.service.getCharacteristic(Characteristic.Hue)
        .onGet(() => this.whenResponsive(this.currentColor.hue))
        .onSet(value => this.queueChange({ hue: value as number }));
      this.service.getCharacteristic(Characteristic.Saturation)
        .onGet(() => this.whenResponsive(this.currentColor.sat))
        .onSet(value => this.queueChange({ sat: value as number }));
    }
    else {
      // group was changed from color to white on the controller
      for (const c of [Characteristic.Hue, Characteristic.Saturation]) {
        if (this.service.testCharacteristic(c)) this.service.removeCharacteristic(this.service.getCharacteristic(c));
      }
    }

    accessory.on('identify', () => this.identify());
    controller.on('update', () => this.syncFromController());
    this.syncFromController();
  }

  private get hasColor(): boolean {
    return this.context.type === LightType.ZDC;
  }

  private get group() {
    return this.controller.groups.get(this.context.groupNumber!);
  }

  private get isOn(): boolean {
    return (this.group?.intensity ?? 0) > 0;
  }

  // HomeKit keeps showing the last brightness while a light is off, so it comes back at that level.
  private get displayBrightness(): number {
    const intensity = this.group?.intensity ?? 0;
    return intensity > 0 ? intensity : (this.context.lastBrightness ?? 100);
  }

  private get currentColor() {
    const color = this.controller.colors.get(this.group?.color ?? 0);
    return { hue: color?.hue ?? this.context.hue ?? 0, sat: color?.sat ?? this.context.saturation ?? 0 };
  }

  private whenResponsive<T>(value: T): T {
    if (!this.controller.isResponsive()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  }

  private syncFromController(): void {
    const group = this.group;
    if (!group) return;
    if (group.intensity > 0) this.context.lastBrightness = group.intensity;
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.On, this.isOn);
    this.service.updateCharacteristic(Characteristic.Brightness, this.displayBrightness);
    if (this.hasColor) {
      const { hue, sat } = this.currentColor;
      this.context.hue = hue;
      this.context.saturation = sat;
      this.service.updateCharacteristic(Characteristic.Hue, hue);
      this.service.updateCharacteristic(Characteristic.Saturation, sat);
    }
  }

  private queueChange(change: PendingChange): Promise<void> {
    Object.assign(this.pending, change);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), COALESCE_MS);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async flush(): Promise<void> {
    const change = this.pending;
    const waiters = this.waiters;
    this.pending = {};
    this.waiters = [];
    try {
      await this.apply(change);
      waiters.forEach(w => w.resolve());
    }
    catch (err) {
      this.platform.log.error(`${this.accessory.displayName}: ${errorMessage(err)}`);
      const failure = new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      waiters.forEach(w => w.reject(failure));
    }
  }

  private async apply(change: PendingChange): Promise<void> {
    if (change.hue !== undefined || change.sat !== undefined) {
      await this.applyColor(change.hue ?? this.currentColor.hue, change.sat ?? this.currentColor.sat);
    }

    let intensity: number | undefined;
    if (change.on === false) intensity = 0;
    else if (change.brightness !== undefined) intensity = change.brightness;
    else if (change.on === true) intensity = this.context.lastBrightness || 100;
    if (intensity === undefined) return;

    this.platform.log.info(`${this.accessory.displayName} turning ${intensity > 0 ? `on at ${intensity}%` : 'off'}`);
    await this.controller.illuminateGroup(this.context.groupNumber!, intensity);
    this.syncFromController();
  }

  private async applyColor(hue: number, sat: number): Promise<void> {
    const group = this.group;
    if (!group) throw new Error(`group ${this.context.groupNumber} is not on the controller`);
    let color = group.color;
    if (this.platform.config.independentColors) {
      // legacy mode: every group gets its own palette slot, counting down from C250
      const slot = MAX_PALETTE_COLOR - group.number + 1;
      if (color !== slot) {
        this.platform.log.debug(`${this.accessory.displayName}: assigning palette color ${slot}`);
        await this.controller.assignGroupColor(group.number, slot);
        color = slot;
      }
    }
    if (color === 0 || color > MAX_PALETTE_COLOR) {
      this.platform.log.warn(`${this.accessory.displayName} uses controller color ${color}, which HomeKit can't change.`);
      return;
    }
    this.platform.log.info(`${this.accessory.displayName} setting color ${color} to hue ${hue}, saturation ${sat}`);
    await this.controller.setColor(color, hue, sat);
  }

  private async identify(): Promise<void> {
    const before = this.group?.intensity ?? 0;
    this.platform.log.info(`Identifying ${this.accessory.displayName}.  Lights will flash.`);
    try {
      for (const intensity of [100, 0, 100]) {
        await this.controller.illuminateGroup(this.context.groupNumber!, intensity);
        await sleep(2000);
      }
      await this.controller.illuminateGroup(this.context.groupNumber!, before);
      this.syncFromController();
    }
    catch (err) {
      this.platform.log.error(`${this.accessory.displayName} identify: ${errorMessage(err)}`);
    }
  }
}
