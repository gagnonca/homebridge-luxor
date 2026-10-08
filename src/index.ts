import { API } from 'homebridge';
import { LuxorPlatform, PLATFORM_NAME, PLUGIN_NAME } from './LuxorPlatform';

export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LuxorPlatform);
};
