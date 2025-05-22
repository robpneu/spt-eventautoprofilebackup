import path from "node:path";
import { ISptProfile } from "@spt/models/eft/profile/ISptProfile";
import { ConfigTypes } from "@spt/models/enums/ConfigTypes";
import type { IPostSptLoadMod } from "@spt/models/external/IPostSptLoadMod";
import type { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { ICoreConfig } from "@spt/models/spt/config/ICoreConfig";
import type { ILogger } from "@spt/models/spt/utils/ILogger";
import type { ConfigServer } from "@spt/servers/ConfigServer";
import type { SaveServer } from "@spt/servers/SaveServer";
import { BackupService } from "@spt/services/BackupService";
import type { StaticRouterModService } from "@spt/services/mod/staticRouter/StaticRouterModService";
import { FileSystemSync } from "@spt/utils/FileSystemSync";
import type { JsonUtil } from "@spt/utils/JsonUtil";
import type { DependencyContainer } from "tsyringe";
import type { ModConfig } from "./configInterface";

import { jsonc } from "jsonc";

import pkg from "../package.json";

export class Mod implements IPreSptLoadMod, IPostSptLoadMod {
    readonly modName = `${pkg.name}`;
    private backupPath: string;
    private modConfig: ModConfig;
    private logger: ILogger;
    private fileSystem: FileSystemSync;
    protected configServer: ConfigServer;
    protected jsonUtil: JsonUtil;
    protected saveServer: SaveServer;
    protected backupService: BackupService;

    public preSptLoad(container: DependencyContainer): void {
        const staticRouterModService: StaticRouterModService =
            container.resolve<StaticRouterModService>("StaticRouterModService");

        // get logger
        this.logger = container.resolve<ILogger>("WinstonLogger");

        // Get the file system instance
        this.fileSystem = container.resolve<FileSystemSync>("FileSystemSync");

        // Read in the json c config content and parse it into json
        this.modConfig = jsonc.parse(this.fileSystem.read(path.resolve(__dirname, "../config/config.jsonc")));

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

        // If the profile username is of a headless client, don't create a backup
        if (sessionUsername.startsWith("headless_")) {
            this.logger.debug(
                `[${this.modName}] ${sessionID} (${sessionUsername}) is a dedicated client. No backup created`,
            );
            return;
        }

        const sessionPath = `${this.backupPath}backups/${sessionUsername}-${sessionID}/`;
        const backupFileName = `${this.backupService.generateBackupDate()}_${event}.json`;

        // Get the profile from the SaveServer and serialize it. Roughly copied from the SPT SaveServer.saveProfile method
        const jsonProfile = this.jsonUtil.serialize(
            this.saveServer.getProfile(sessionID),
            !this.configServer.getConfig<ICoreConfig>(ConfigTypes.CORE).features.compressProfile,
        );

        // Write the profile to the backup folder. Creates the parent directory if it doesn't exist
        this.fileSystem.write(`${sessionPath}${backupFileName}`, jsonProfile);

        if (this.modConfig?.BackupSavedLog) {
            this.logger.success(
                `[${this.modName}] ${sessionID} (${sessionUsername}): New backup file "${backupFileName}" saved`,
            );
        }

        // Clean up the backup folder to have a maximum number of files
        if (this.modConfig?.MaximumBackupPerProfile >= 0) {
            const delCount = this.cleanUpFolder(sessionPath, this.modConfig.MaximumBackupPerProfile);

            if (this.modConfig?.MaximumBackupDeleteLog && delCount > 0) {
                this.logger.success(
                    `[${this.modName}] ${sessionID} (${sessionUsername}): Maximum backup reached (${this.modConfig.MaximumBackupPerProfile}). ${delCount} backup file(s) deleted`,
                );
            }
        } else {
            this.logger.warning(
                `[${this.modName}] "MaximumBackupPerProfile" is set to 0. This may cause the folder to grow indefinitely and is not recommended.`,
            );
        }
    }

    private restoreRequestedProfiles(): void {
        const profileFilesToRestorePath = `${this.backupPath}ProfilesToRestore/`;
        const restoredProfilePath = `${this.backupPath}RestoredProfiles/`;

        // Roughly copied from the SPT SaveServer load and loadProfiles methods

        // Ensure the ToRestore and Restored folders exist. (ensureDir creates the folder if it doesn't exist)
        this.fileSystem.ensureDir(profileFilesToRestorePath);
        this.fileSystem.ensureDir(restoredProfilePath);

        // Get all the json files in the "ProfilesToRestore" folder
        const profileFilesToRestore = this.fileSystem.getFiles(profileFilesToRestorePath, false, ["json"]);

        // Iterate over the profile files to restore
        for (const profileFile of profileFilesToRestore) {
            const profileFilepath = `${profileFilesToRestorePath}${profileFile}`;
            this.logger.debug(`[${this.modName}] Restoring ${profileFile}`);

            // Manually read the profile json and pull some profile info out
            const profile: ISptProfile = this.fileSystem.readJson(profileFilepath);
            const profileId = profile.info.id;
            const profileUsername = profile.info.username;

            // If a profile with the same id exists in the SaveServer, we need to delete it first
            if (this.saveServer.profileExists(profileId)) {
                // Delete the profile from the SaveServer memory and from the file system
                this.saveServer.deleteProfileById(profileId);
                this.saveServer.removeProfile(profileId);
            }

            // Add the profile to restore to the SaveServer memory
            this.saveServer.addProfile(profile);
            // Tell the SaveServer to save the profile to the user/profiles folder
            this.saveServer.saveProfile(profileId);
            this.logger.info(`[${this.modName}] Restored ${profileFile} to ${profileId} (${profileUsername})`);

            // Move the restored file to the "RestoredProfiles" folder
            this.fileSystem.move(profileFilepath, `${restoredProfilePath}${profileFile}`);
        }

        // Clean up the "RestoredProfiles" folder to have a maximum number of files
        if (this.modConfig?.MaximumRestoredFiles >= 0) {
            const delCount = this.cleanUpFolder(restoredProfilePath, this.modConfig.MaximumRestoredFiles);

            if (this.modConfig?.MaximumRestoredDeleteLog && delCount > 0) {
                this.logger.success(
                    `[${this.modName}] Maximum restored backups reached (${this.modConfig.MaximumRestoredFiles}). ${delCount} backup file(s) deleted`,
                );
            }
        } else {
            this.logger.warning(
                `[${this.modName}] "MaximumRestoredFiles" is set to 0. This may cause the folder to grow indefinitely and is not recommended.`,
            );
        }
    }

    private cleanUpFolder(folderPath: string, maxFiles: number): number {
        this.logger.debug(`[${this.modName}] Cleaning up folder ${folderPath} to have a maximum of ${maxFiles} files`);

        // Get all the json files in the folder and sort them by name, which begins with the datetime
        const fileList = this.fileSystem.getFiles(folderPath, false, ["json"]).sort((a, b) => a.localeCompare(b));

        let delCount = 0;

        this.logger.debug(`[${this.modName}] Found ${fileList.length} files in the folder`);

        // If the number of files in the folder is greater than the maxFiles, delete the oldest files until the count is less than maxFiles
        while (fileList.length && fileList.length > maxFiles) {
            const lastFile = fileList[0];
            this.logger.debug(`[${this.modName}] Deleting ${folderPath}${lastFile}`);
            this.fileSystem.remove(`${folderPath}${lastFile}`);
            fileList.splice(0, 1);
            delCount++;
        }

        return delCount;
    }
}

module.exports = { mod: new Mod() };
