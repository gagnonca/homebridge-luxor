import { PlatformAccessory, Service } from 'homebridge';
import { LuxorPlatform, AccessoryContext } from '../LuxorPlatform';
import { LuxorController } from '../LuxorController';
import { errorMessage, sleep } from '../LuxorClient';

export const ILLUMINATE_ALL_INDEX = 100;
export const EXTINGUISH_ALL_INDEX = 101;

// A Luxor theme, exposed as a momentary switch: it always reads "off" so it can be pressed
// again, and turning it on (re)applies the theme even if the controller thinks it's active.
export class ThemeSwitch {
  private readonly service: Service;
  private readonly context: AccessoryContext;

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

    this.service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);
    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(value => {
        // Answer HomeKit right away; a theme takes two round trips and HomeKit is impatient.
        this.run(value as boolean);
      });
    this.service.updateCharacteristic(Characteristic.On, false);

    accessory.on('identify', async () => {
      this.platform.log.info(`Identifying ${accessory.displayName}.  Theme will turn on for 3s and then off.`);
      await this.run(true);
      await sleep(3000);
      await this.run(false);
    });
  }

  private async run(on: boolean): Promise<void> {
    const index = this.context.themeIndex!;
    try {
      if (index === ILLUMINATE_ALL_INDEX) {
        if (on) await this.controller.illuminateAll();
      }
      else if (index === EXTINGUISH_ALL_INDEX) {
        if (on) await this.controller.extinguishAll();
      }
      else {
        this.platform.log.info(`${this.accessory.displayName} turning ${on ? 'on' : 'off'}`);
        // The controller ignores "on" for a theme it already considers on, even if its lights
        // were changed since, so switch it off first.
        await this.controller.illuminateTheme(index, false);
        if (on) await this.controller.illuminateTheme(index, true);
      }
    }
    catch (err) {
      this.platform.log.error(`${this.accessory.displayName}: ${errorMessage(err)}`);
    }
    finally {
      setTimeout(() => this.service.updateCharacteristic(this.platform.Characteristic.On, false), 1000);
    }
  }
}
