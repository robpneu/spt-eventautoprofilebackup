import fs from "node:fs";
import { ISptProfile } from "@spt/models/eft/profile/ISptProfile";
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
    private backupPath;
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

        this.backupPath = `${this.saveServer.profileFilepath}EventAutoBackup/`;

        this.restoreRequestedProfiles();
    }

    public onEvent(event: string, sessionID: string): void {
        const sessionUsername = this.saveServer.getProfile(sessionID).info.username;

        // If the profile username is of a dedicated client, don't create a backup
        if (sessionUsername.startsWith("dedicated_")) {
            this.logger.debug(
                `[${this.modName}] ${sessionID} (${sessionUsername}) is a dedicated client. No backup created`,
            );
            return;
        }

        const sessionPath = `${this.backupPath}backups/${sessionUsername}-${sessionID}/`;

        if (!this.vfs.exists(sessionPath)) {
            this.logger.success(`[${this.modName}] "${sessionPath}" has been created`);
            this.vfs.createDir(sessionPath);
        }

        if (this.modConfig?.MaximumBackupPerProfile >= 0) {
            const delCount = this.cleanUpFolder(sessionPath, this.modConfig.MaximumBackupPerProfile);

            if (this.modConfig?.MaximumBackupDeleteLog && delCount > 0) {
                this.logger.warning(
                    `[${this.modName}] ${sessionID} (${sessionUsername}): Maximum backup reached (${this.modConfig.MaximumBackupPerProfile}). ${delCount} backup file(s) deleted`,
                );
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
                `[${this.modName}] ${sessionID} (${sessionUsername}): New backup file "${backupFileName}" saved`,
            );
        }
    }

    private restoreRequestedProfiles(): void {
        const profileFilesToRestorePath = `${this.backupPath}ProfilesToRestore/`;
        const restoredProfilePath = `${this.backupPath}RestoredProfiles/`;

        // Create the ToRestore and Restored folders if they don't exist
        if (!this.vfs.exists(profileFilesToRestorePath)) {
            this.logger.success(`[${this.modName}] "${profileFilesToRestorePath}" has been created`);
            this.vfs.createDir(profileFilesToRestorePath);
        }

        if (!this.vfs.exists(restoredProfilePath)) {
            this.logger.success(`[${this.modName}] "${restoredProfilePath}" has been created`);
            this.vfs.createDir(restoredProfilePath);
        }

        // Get all the json files in the "ProfilesToRestore" folder and iterate over them
        const profileFilesToRestore = this.vfs
            .getFiles(profileFilesToRestorePath)
            .filter((item) => this.vfs.getFileExtension(item) === "json");

        for (const profileFile of profileFilesToRestore) {
            const profileFilepath = `${profileFilesToRestorePath}${profileFile}`;
            // Manually read the profile json to pull the info out
            this.logger.info(`[${this.modName}] Restoring ${profileFile}`);
            const profile: ISptProfile = this.jsonUtil.deserialize(this.vfs.readFile(profileFilepath));
            const profileId = profile.info.id;
            const profileUsername = profile.info.username;

            // If a profile with the same id exists in the SaveServer
            if (this.saveServer.profileExists(profileId)) {
                // Delete the profile from the SaveServer memory and from the file system
                this.saveServer.deleteProfileById(profileId);
                this.saveServer.removeProfile(profileId);
            }

            // Add full profile in memory by key (info.id) and have the save server save it to the user/profiles json
            this.saveServer.addProfile(profile);
            this.saveServer.saveProfile(profileId);
            this.logger.info(`[${this.modName}] Restored ${profileFile} to ${profileId} (${profileUsername})`);

            // Move restored file to the "RestoredProfiles" folder
            this.vfs.copyFile(profileFilepath, `${restoredProfilePath}${profileFile}`);
            this.vfs.removeFile(profileFilepath);
        }

        if (this.modConfig?.MaximumRestoredFiles >= 0) {
            const delCount = this.cleanUpFolder(profileFilesToRestorePath, this.modConfig?.MaximumRestoredFiles);

            if (this.modConfig?.MaximumBackupDeleteLog && delCount > 0) {
                this.logger.warning(
                    `[${this.modName}] Maximum restored backups reached (${this.modConfig.MaximumRestoredFiles}). ${delCount} backup file(s) deleted`,
                );
            }
        }
    }

    private cleanUpFolder(folderPath: string, maxFiles: number): number {
        // Get all the json files in the folder and sort them by creation time
        const fileList = this.vfs
            .getFilesOfType(folderPath, "json")
            .sort((a, b) => fs.statSync(a).ctimeMs - fs.statSync(b).ctimeMs);
        let delCount = 0;

        // If the number of files in the folder is greater than the maxFiles, delete the oldest files until the count is less than maxFiles
        while (fileList.length && fileList.length >= maxFiles) {
            const lastFile = fileList[0];
            this.vfs.removeFile(lastFile);
            fileList.splice(0, 1);
            delCount++;
        }

        return delCount;
    }
}

module.exports = { mod: new Mod() };
