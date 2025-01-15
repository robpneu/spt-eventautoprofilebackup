import fs from "node:fs";
import { ConfigTypes } from "@spt/models/enums/ConfigTypes";
import type { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import type { IPostSptLoadMod } from "@spt/models/external/IPostSptLoadMod";
import type { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { ICoreConfig } from "@spt/models/spt/config/ICoreConfig";
import type { ILogger } from "@spt/models/spt/utils/ILogger";
import type { ConfigServer } from "@spt/servers/ConfigServer";
import type { SaveServer } from "@spt/servers/SaveServer";
import { BackupService } from "@spt/services/BackupService";
import type { StaticRouterModService } from "@spt/services/mod/staticRouter/StaticRouterModService";
import type { JsonUtil } from "@spt/utils/JsonUtil";
import type { VFS } from "@spt/utils/VFS";
import type { DependencyContainer } from "tsyringe";
import type { ModConfig } from "./configInterface";

import { jsonc } from "jsonc";

import path from "node:path";

import pkg from "../package.json";

export class Mod implements IPreSptLoadMod, IPostDBLoadMod, IPostSptLoadMod {
    readonly modName = `${pkg.name}`;
    private modConfig: ModConfig;
    private logger: ILogger;
    private vfs: VFS;
    protected configServer: ConfigServer;
    protected jsonUtil: JsonUtil;
    protected saveServer: SaveServer;
    protected backupService: BackupService;

    public preSptLoad(container: DependencyContainer): void {
        const staticRouterModService: StaticRouterModService =
            container.resolve<StaticRouterModService>("StaticRouterModService");

        // get logger
        this.logger = container.resolve<ILogger>("WinstonLogger");

        // Get VFS to interact with the file system to read in configs and manage profile backup directories and files
        this.vfs = container.resolve<VFS>("VFS");

        // Read in the json c config content and parse it into json
        this.modConfig = jsonc.parse(this.vfs.readFile(path.resolve(__dirname, "../config/config.jsonc")));

        if (!this.modConfig.Enabled) {
            this.logger.warning(`[${this.modName}] Mod is disabled. Backups will not be made.`);
            return;
        }

        this.logger.info(`[${this.modName}] Mod is enabled. Loading...`);

        // Iterate over the AutoBackupEvents from the config. If the event is enabled, get the route for each event and register the listener
        for (const autoBackupEvent of this.modConfig.AutoBackupEvents) {
            const event = autoBackupEvent.Name;
            const route = autoBackupEvent.Route;

            if (autoBackupEvent.Enabled) {
                staticRouterModService.registerStaticRouter(
                    `${this.modName}-${route}`,
                    [
                        {
                            url: route,
                            action: async (url, info, sessionId, output): Promise<string> => {
                                this.onEvent(event, sessionId);
                                return output;
                            },
                        },
                    ],
                    "spt",
                );
                this.logger.success(`[${this.modName}] Registered ${event} event with route ${route}`);
            } else {
                this.logger.warning(`[${this.modName}] Found ${event} event with route ${route} but it is disabled`);
            }
        }

        this.logger.success(`[${this.modName}] Finished registering events`);
    }

    public postSptLoad(container: DependencyContainer): void {
        if (!this.modConfig.Enabled) {
            return;
        }

        this.configServer = container.resolve<ConfigServer>("ConfigServer");
        this.jsonUtil = container.resolve<JsonUtil>("JsonUtil");
        this.saveServer = container.resolve<SaveServer>("SaveServer");
        this.backupService = container.resolve<BackupService>("BackupService");

        // Check all off the loaded profiles for any mismatches, which indicates an attempt to restore from backup
        for (const profileKey in this.saveServer.getProfiles()) {
            const sessionID = this.saveServer.getProfile(profileKey).info.id;
            if (sessionID !== profileKey) {
                this.saveServer.deleteProfileById(profileKey);
                fs.rename(
                    `${this.saveServer.profileFilepath}/${profileKey}.json`,
                    `${this.saveServer.profileFilepath}/${sessionID}.json`,
                    () => {
                        this.saveServer.loadProfile(sessionID);
                    },
                );
                this.logger.info(`[${this.modName}] Profile "${profileKey}.json" => "${sessionID}.json" name fixed`);
            }
        }
    }

    public onEvent(event: string, sessionID: string): void {
        const sessionUsername = this.saveServer.getProfile(sessionID).info.username;
        const sessionPath = `${this.saveServer.profileFilepath}/AutoBackup/${sessionUsername}-${sessionID}/`;

        if (!this.vfs.exists(sessionPath)) {
            this.logger.success(`[${this.modName}] "${sessionPath}" has been created`);
            this.vfs.createDir(sessionPath);
        }

        if (this.modConfig?.MaximumBackupPerProfile >= 0) {
            const profileList = this.vfs
                .getFilesOfType(sessionPath, "json")
                .sort((a, b) => fs.statSync(a).ctimeMs - fs.statSync(b).ctimeMs);
            let delCount = 0;
            let fileName = "";

            while (profileList.length && profileList.length >= this.modConfig.MaximumBackupPerProfile) {
                const lastProfile = profileList[0];
                fileName = lastProfile.split("\\").pop();
                this.vfs.removeFile(lastProfile);
                profileList.splice(0, 1);
                delCount++;
            }

            if (this.modConfig?.MaximumBackupDeleteLog) {
                if (delCount === 1) {
                    this.logger.warning(
                        `[${this.modName}] ${sessionUsername}-${sessionID}: Maximum backup reached (${this.modConfig.MaximumBackupPerProfile}), Backup file "${fileName}" deleted`,
                    );
                } else if (delCount > 1) {
                    this.logger.warning(
                        `[${this.modName}] @ ${sessionID}: Maximum backup reached (${this.modConfig.MaximumBackupPerProfile}), Total "${delCount}" backup files deleted`,
                    );
                }
            }
        }

        const backupFileName = `${this.backupService.generateBackupDate()}_${event}.json`;

        const jsonProfile = this.jsonUtil.serialize(
            this.saveServer.getProfile(sessionID),
            !this.configServer.getConfig<ICoreConfig>(ConfigTypes.CORE).features.compressProfile,
        );

        this.vfs.writeFile(`${sessionPath}${backupFileName}`, jsonProfile);

        if (this.modConfig?.BackupSavedLog) {
            this.logger.success(
                `[${this.modName}] ${sessionUsername}-${sessionID}: New backup file "${backupFileName}" saved`,
            );
        }
    }
}

module.exports = { mod: new Mod() };
