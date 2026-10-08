
# homebridge-luxor 5.0.0

A maintained fork of [tagyoureit/homebridge-luxor](https://github.com/tagyoureit/homebridge-luxor) focused on reliability, updated for Homebridge 2 and Node 22+.
It is a drop-in replacement: same plugin name, same `Luxor` platform config, and the same accessory UUIDs, so existing HomeKit rooms, scenes and automations carry over.

## What changed in 5.0

* **Accessories are never deleted because of a bad read.** 4.x built the accessory list from whatever it got at startup; if the controller dropped one request, every light group was removed from HomeKit (taking automations with it). 5.0 only syncs accessories after a complete, successful read and otherwise retries (5s, 10s, 20s ... 60s).
* **HomeKit reads never wait on the controller.** State comes from a snapshot refreshed by polling and after each command, so opening the Home app doesn't flood the controller or show "No Response" because one request was slow.
* **Gentler on the controller:** one request at a time, a fresh connection per request (Node 19+ enabled HTTP keep-alive by default, which these controllers handle badly), a 2.5s timeout and quick retries for dropped or stalled requests.
* **One command per change.** Moving a slider or picking a color sends a single request instead of two or three.
* Turning a light on restores its last brightness instead of jumping to 100%.
* Fixed: `hideGroups` deadlocked all requests; the ZDC color code wrote to the controller on every read; theme switches turned *on* when HomeKit asked them to turn off; color lookups that could hang forever.
* No runtime dependencies (axios removed). Requires Node 22, 24 or 26 and Homebridge 1.8+ or 2.x.

## Upgrading from 4.x

If your config has `"commandTimeout": 750` (the old UI default), raise it or delete it so the new 2500ms default applies.

## Connection options

| Option | Default | |
|---|---|---|
| `pollInterval` | 30 | Seconds between state refreshes (min 5) |
| `commandTimeout` | 2500 | Milliseconds per request attempt |
| `retries` | 2 | Retries for timed-out or dropped requests |

## Development

`npm test` builds and runs the tests against a mock controller. `node test/mock-controller.js 8080` runs the mock standalone (set `ipAddr` to `127.0.0.1:8080`); `/_fault?drop=2`, `?hang=1`, `?delayMs=500` or `?dropMethod=GroupListGet` make it misbehave.

# Original documentation

This is a PLATFORM module for the [HomeBridge Platform](https://github.com/nfarina/homebridge) to control [FX Luminaire](http://www.FXL.com).  

This plug-in enables power and brightness controls for:
* [FX Luminaire Luxor ZD](http://www.fxl.com/product/power-and-control/luxor-zd) 
* [FX Luminaire Luxor ZDC](http://www.fxl.com/product/power-and-control/luxor-zdc)
* [FX Luminaire Luxor LXTWO](https://www.fxl.com/product/transformers/designer/luxor)

# Installation

1. Install homebridge - [Full directions at HomeBridge page](https://github.com/homebridge/homebridge)
1. Install this plugin using
* Homebridge UI
* `npm install -g homebridge-luxor`.  Update your configuration file. See sample-config.json in this repository for a sample.

# Specific ZDC controller with ZDC lights notes
1. This app will designate a specific Luxor color palette for each group.  The formula is (250-[group number]+1).  Group 1 will user C250, Group 2 will use C249, etc.  Homekit will then assign any colors to this new group.  This allows you to keep your existing color palettes in case you want to change the lights from the Luxor app.
1. The first time you load this module it will copy the current color palette values (hue and saturation) to the aforementioned new groups.
1. Brightness, on/off and color are polled (every 30 seconds by default, see `pollInterval`), so changes made in the Luxor app show up in HomeKit.
1. If you change any of brightness/color/on/off through HomeKit, all values will be updated in this module.

# NOTE: Experimental Support for LXTWO
Not supported:
- Color wheel values 251-260 and DMC control 65535
# Themes
1. Themes will show up as a switch (instead of a lightbulb).  The way Luxor implements themes is that you can only turn them on (eg the theme has no knowledge if individual lights in the theme are changed after a theme is "set").  Therefor, the switch will illuminate momentarily and then turn itself off.  Turning a theme switch off (e.g. from an automation) turns that theme off on the controller.
1. The two themes "Illuminate All" and "Extinguish All" will be automatically added to your themes.

# Remove accessories
1.  There may be occasions (upgrading from the original version of this code) when some accessories will not be removed.  You can remove these by including the line `removeAllAccessories:true` to remove all accessories.  Or, list individual UUID's in `removeAccessories` with a comma delimited string of the names of any Luxor accessories you want to remove.  Once you remove the accessories Homebridge will exit.  Run homebridge then stop it, reset the value back to the defaults and restart Homebridge.

# Known Issues
1. Changes made outside HomeKit appear after the next poll (30 seconds by default).

# Future enhancements (in no particular order)
1. Any requests?

# Credit

1.  I knew that the FX controller had a minimal web interface, and discovered a couple of the API calls, but then found a full(?) list and implementation of the code in a Go library written by [Scott Lamb](https://github.com/scottlamb/luxor).
2.  I used the original WeMo code from [rudders](https://github.com/rudders/homebridge-wemo) as a template and hacked away at it until I got to this point.
3.  Of course, to [nfarina](https://github.com/nfarina/homebridge) for the HomeBridge and, in turn, [KhaosT](http://twitter.com/khaost) for the original [HAP-NodeJS](https://github.com/KhaosT/HAP-NodeJS) project.
4.  [David Parry](https://github.com/devbobo) for helping convert v1.0 to a platform module.
5.  The Luxor team at Hunter for providing support and test materials.
