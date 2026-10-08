import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { LuxorClient, errorMessage, sleep } from './LuxorClient';
import { ControllerType, LightType, LuxorController } from './LuxorController';
import { GroupLight } from './lights/GroupLight';
import { EXTINGUISH_ALL_INDEX, ILLUMINATE_ALL_INDEX, ThemeSwitch } from './lights/ThemeSwitch';

export const PLUGIN_NAME = 'homebridge-luxor';
export const PLATFORM_NAME = 'Luxor';

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_RETRIES = 2;
const DEFAULT_POLL_SECONDS = 30;
const MIN_POLL_SECONDS = 5;
const STARTUP_RETRY_DELAYS_S = [5, 10, 20, 40, 60];

export interface AccessoryContext {
  type: LightType;
  groupNumber?: number;
  themeIndex?: number;
  lastBrightness?: number;
  hue?: number;
  saturation?: number;
}

interface DesiredAccessory {
  uuid: string;
  name: string;
  context: AccessoryContext;
}

export class LuxorPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private controller?: LuxorController;
  private shuttingDown = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => {
      this.shuttingDown = true;
      this.controller?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Retrieved cached accessory ${accessory.displayName} with UUID ${accessory.UUID}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    if (!this.config.ipAddr) {
      this.log.error(`${this.config.name || PLATFORM_NAME} needs an IP Address in the config.  See sample-config.json.`);
      return;
    }
    // Only touch the accessory list after a complete, successful read of the controller.  Building
    // it from a failed or partial read would delete accessories (and the automations and rooms
    // that reference them) from HomeKit.
    for (let attempt = 0; !this.shuttingDown; attempt++) {
      try {
        const controller = await this.connect();
        this.syncAccessories(controller);
        controller.startPolling();
        this.controller = controller;
        this.log.info('Finished initializing.');
        return;
      }
      catch (err) {
        const delay = STARTUP_RETRY_DELAYS_S[Math.min(attempt, STARTUP_RETRY_DELAYS_S.length - 1)];
        this.log.warn(`Unable to reach Luxor controller at ${this.config.ipAddr} (${errorMessage(err)}).  Retrying in ${delay}s.`);
        await sleep(delay * 1000);
      }
    }
  }

  private async connect(): Promise<LuxorController> {
    const client = new LuxorClient({
      ip: this.config.ipAddr,
      timeout: this.config.commandTimeout || DEFAULT_TIMEOUT_MS,
      retries: this.config.retries ?? DEFAULT_RETRIES,
      log: this.log,
    });
    const info = await client.request<{ Controller: string }>('ControllerName');
    let type = LuxorController.detectType(info.Controller);
    if (!type) {
      type = ControllerType.ZDTWO;
      this.log.info(`Found unknown controller named ${info.Controller}, assuming a ZDTWO.`);
    }
    this.log.info(`Found controller ${info.Controller} (${type}) at ${this.config.ipAddr}.`);

    const pollSeconds = Math.max(MIN_POLL_SECONDS, this.config.pollInterval || DEFAULT_POLL_SECONDS);
    const controller = new LuxorController(info.Controller, type, client, this.log, {
      pollInterval: pollSeconds * 1000,
      hideGroups: !!this.config.hideGroups,
    });
    await controller.refresh();
    this.log.info(`Retrieved ${controller.groups.size} light groups and ${controller.themes.size} themes.`);
    return controller;
  }

  private desiredAccessories(controller: LuxorController): DesiredAccessory[] {
    const uuid = this.api.hap.uuid;
    const desired: DesiredAccessory[] = [];
    // UUIDs must stay exactly as the original plugin generated them, or HomeKit sees new accessories.
    for (const group of controller.groups.values()) {
      desired.push({
        uuid: uuid.generate(`luxor.group.-${group.number}`),
        name: group.name,
        context: { type: group.type, groupNumber: group.number },
      });
    }
    const themes = [...controller.themes.values()].map(t => ({ index: t.index, name: t.name }));
    if (this.config.noAllThemes) {
      this.log.info('Not creating Illuminate All and Extinguish All themes per config setting.');
    }
    else {
      themes.push({ index: ILLUMINATE_ALL_INDEX, name: 'Illuminate all lights' });
      themes.push({ index: EXTINGUISH_ALL_INDEX, name: 'Extinguish all lights' });
    }
    for (const theme of themes) {
      desired.push({
        uuid: uuid.generate(`luxor.theme-${theme.index}`),
        name: theme.name,
        context: { type: LightType.THEME, themeIndex: theme.index },
      });
    }
    return desired;
  }

  private syncAccessories(controller: LuxorController): void {
    const removeList = String(this.config.removeAccessories || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const accessory of [...this.accessories.values()]) {
      if (this.config.removeAllAccessories || removeList.includes(accessory.UUID) || removeList.includes(accessory.displayName)) {
        this.log.info(`Removing cached accessory ${accessory.displayName} (${accessory.UUID}) per platform configuration.`);
        this.unregister(accessory);
      }
    }

    const desired = this.desiredAccessories(controller);
    const desiredUUIDs = new Set(desired.map(d => d.uuid));
    for (const accessory of [...this.accessories.values()]) {
      if (!desiredUUIDs.has(accessory.UUID)) {
        this.log.info(`Removing ${accessory.displayName} (${accessory.UUID}); it is no longer on the controller.`);
        this.unregister(accessory);
      }
    }

    for (const d of desired) {
      let accessory = this.accessories.get(d.uuid);
      if (accessory) {
        this.log.info(`Loading cached accessory ${d.name}.`);
        accessory.displayName = d.name;
        accessory.context = { ...accessory.context, ...d.context };
        this.attach(accessory, controller);
        this.api.updatePlatformAccessories([accessory]);
      }
      else {
        this.log.info(`Adding new accessory ${d.name}.`);
        accessory = new this.api.platformAccessory(d.name, d.uuid);
        accessory.context = d.context;
        this.attach(accessory, controller);
        this.accessories.set(d.uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  private attach(accessory: PlatformAccessory, controller: LuxorController): void {
    if ((accessory.context as AccessoryContext).type === LightType.THEME) new ThemeSwitch(this, accessory, controller);
    else new GroupLight(this, accessory, controller);
  }

  private unregister(accessory: PlatformAccessory): void {
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.delete(accessory.UUID);
  }
}
