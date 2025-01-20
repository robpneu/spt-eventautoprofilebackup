# Welcome to EventAutoProfileBackup, formerly Lua-AutoProfileBackup
No more worries to backup your profile. A continuation of Lua's and other modder's work.

## **Backup files**
- Auto-Backup path: `user/profiles/EventAutoBackup/backups/profileUsername-profileID`
- Backup file format: `year-month-day_hour-minute-second_​event.json`
  - Example: `2025-01-14_21-14-49_OnGameStart.json`

## **Restore**
Automatically restores profile backups when requsted without requiring that the user rename the file

Process:
- Move or copy the backup file you wish to restore to `user/profiles/EventAutoBackup/ProfilesToRestore/`.
- When the restore is complete the file will be moved to `user/profiles/EventAutoBackup/RestoredProfiles/`.
- `user/profiles/EventAutoBackup/RestoredProfiles/` will retain the number of files set in the config.jsonc (`MaximumRestoredBackupFiles`).

## **Configuration**
`user/mods/eventautoprofilebackup/config/config.jsonc`

For a bit of background, the "events" are triggered when the server receives a call to the specified route. You can enable, disable and/or rename any of the events. Do not change the Route unless you know what you're doing. (You should only have to rename them if SPT changes them in a future version).

Besides that, the default config file includes helpful comments so I'll just point you to that: [config.jsonc](./config/config.jsonc)

Each event is configurable in the following ways
- Enable or disable
- The name of the event (which is used in the file name)
- The route to which the mod listens.

### Advanced

By moving the routes into the config file I have also made it much easier to add additional events. If you are so inclined, here's how I would recommend adding a new event

```JSONC
​// Which events should trigger a backup.
"AutoBackupEvents": [
    { "Enabled": true, "Name": "OnGameStart", "Route": "/client/game/start" },
    { "Enabled": true, "Name": "OnRaidStart", "Route": "/client/match/local/start" },
    { "Enabled": true, "Name": "OnRaidEnd", "Route": "/client/match/local/end" },
    { "Enabled": true, "Name": "OnLogout", "Route": "/client/game/logout" },
    { "Enabled": true, "Name": "AnotherEvent", "Route": "/this/is/another/route" }
]
```

A few words of caution:
1. I recommend that you do not add a route that occurs frequently.
	- I don't really know the limit of how often often a backup be made before causing server performance issues from it constantly creating and probably deleting backup files.
	- I imagine that a significant number of profile backups of the same event would make it difficult to find the exact one you want.
2. ​I do not know if all routes will actually work. I have not tested any beyond the ones included by default so any you add are at your own risk
	- If you have an idea for an event to that you think should be included by default but you don't want to venture into this on your own, please leave a comment on the hub page or open a Github issue [here](https://github.com/robpneu/spt-eventautoprofilebackup/issues) and I'll see what I can do.​

# Build & Environment
This project is based of the [SPT Mod Examples](https://dev.sp-tarkov.com/chomp/ModExamples) repository.
This project is designed to streamline the initial setup process for building and creating mods in the SPT environment. Follow this guide to set up your environment efficiently.

## **Table of Contents**
- [NodeJS Setup](#nodejs-setup)
- [IDE Setup](#ide-setup)
- [Workspace Configuration](#workspace-configuration)
- [Environment Setup](#environment-setup)
- [Essential Concepts](#essential-concepts)
- [Coding Guidelines](#coding-guidelines)
- [Distribution Guidelines](#distribution-guidelines)

## **NodeJS Setup**

Before you begin, ensure to install NodeJS version `v20.11.1`, which has been tested thoroughly with our mod templates and build scripts. Download it from the [official NodeJS website](https://nodejs.org/).

After installation, it's advised to reboot your system.

## **IDE Setup**

For this project, you can work with either [VSCodium](https://vscodium.com/) or [VSCode](https://code.visualstudio.com/). However, we strongly recommend using VSCode, as all development and testing have been carried out using this IDE, ensuring a smoother experience and compatibility with the project setups. Either way, we have a prepared a workspace file to assist you in setting up your environment.

## **Workspace Configuration**

With NodeJS and your chosen IDE ready, initiate the `mod.code-workspace` file using your IDE:

> File -> Open Workspace from File...

Upon project loading, consider installing recommended plugins like the ESLint plugin.

## **Environment Setup**

An automated task is available to configure your environment for Typescript utilization:

> Terminal -> Run Task... -> Show All Tasks... -> npm: install

Note: Preserve the `node_modules` folder as it contains necessary dependencies for Typescript and other functionalities.

## **Essential Concepts**

Prioritize understanding Dependency Injection and Inversion of Control, the architectural principles SPT adopts. Comprehensive guidelines will be available on the hub upon release.

Some resources to get you started:
 - [A quick intro to Dependency Injection](https://www.freecodecamp.org/news/a-quick-intro-to-dependency-injection-what-it-is-and-when-to-use-it-7578c84fa88f/)
 - [Understanding Inversion of Control (IoC) Principle](https://medium.com/@amitkma/understanding-inversion-of-control-ioc-principle-163b1dc97454)

## **Coding Guidelines**

Focus your mod development around the `mod.ts` file. In the `package.json` file, only alter these properties: `"name"`, `"version"`, `"sptVersion"`, `"loadBefore"`, `"loadAfter"`, `"incompatibilities"`, `"isBundleMod"`, `"author"`, and `"license"`.

New to Typescript? Find comprehensive documentation on the [official website](https://www.typescriptlang.org/docs/).

## **Distribution Guidelines**

Automated tasks are set up to bundle all necessary files for your mod to function in SPT:

> Terminal -> Run Task... -> Show All Tasks... -> npm: build

The ZIP output, located in the `dist` directory, contains all required files. Ensure all files are included and modify the `.buildignore` file as needed. This ZIP file is your uploadable asset for the hub.

## **Conclusion**

With this setup, you're ready to begin modding with SPT. If you run into any trouble be sure to check out the [modding documentation on the hub](https://hub.sp-tarkov.com/doc/lexicon/66-modding/). If you really get stuck feel free to join us in the [#mods-development](https://discord.com/channels/875684761291599922/875803116409323562) official Discord channel.

Build something awesome!
