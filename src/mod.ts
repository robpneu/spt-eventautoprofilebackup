import fs from "node:fs";
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
import type { JsonUtil } from "@spt/utils/JsonUtil";
import type { FileSystemSync } from "@spt/utils/FileSystemSync";
import type { DependencyContainer } from "tsyringe";
import type { ModConfig } from "./configInterface";

import { jsonc } from "jsonc";

import path from "node:path";

import pkg from "../package.json";

export class Mod implements IPreSptLoadMod, IPostSptLoadMod {
    readonly modName = `${pkg.name}`;
    private backupPath;
    private modConfig: ModConfig;
    private logger: ILogger;
    private fileSystem: FileSystemSync;;
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

        this.backupPath = `${(this.saveServer as any).profileFilepath}EventAutoBackup/`;

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

        const sessionPath = `${this.backupPath}Backups/${sessionUsername}-${sessionID}/`;

        // Create the specific profile's backup folder if it doesn't exist
        if (!this.fileSystem.exists(sessionPath)) {
            this.logger.success(`[${this.modName}] "${sessionPath}" has been created`);
            this.fileSystem.ensureDir(sessionPath);
        }

        const backupFileName = `${(this.backupService as any).generateBackupDate()}_${event}.json`;

        // Get the profile from the SaveServer and write it to the backup folder
        const jsonProfile = this.jsonUtil.serialize(
            this.saveServer.getProfile(sessionID),
            !this.configServer.getConfig<ICoreConfig>(ConfigTypes.CORE).features.compressProfile,
        );

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

        // Create the ToRestore and Restored folders if they don't exist
        if (!this.fileSystem.exists(profileFilesToRestorePath)) {
            this.logger.success(`[${this.modName}] "${profileFilesToRestorePath}" has been created`);
            this.fileSystem.ensureDir(profileFilesToRestorePath);
        }

        if (!this.fileSystem.exists(restoredProfilePath)) {
            this.logger.success(`[${this.modName}] "${restoredProfilePath}" has been created`);
            this.fileSystem.ensureDir(restoredProfilePath);
        }

        // Get all the json files in the "ProfilesToRestore" folder and iterate over them
        const profileFilesToRestore = this.fileSystem
            .getFiles(profileFilesToRestorePath, true, ["json"], true);

        for (const profileFile of profileFilesToRestore) {
            const profileFilepath = `${profileFilesToRestorePath}${profileFile}`;
            this.logger.debug(`[${this.modName}] Restoring ${profileFile}`);

            // Manually read the profile json to pull the info out
            const profile: ISptProfile = this.jsonUtil.deserialize(this.fileSystem.read(profileFilepath));
            const profileId = profile.info.id;
            const profileUsername = profile.info.username;

            // If a profile with the same id exists in the SaveServer
            if (this.saveServer.profileExists(profileId)) {
                // Delete the profile from the SaveServer memory and from the file system
                this.saveServer.deleteProfileById(profileId);
                this.saveServer.removeProfile(profileId);
            }

            // Add the profile to the SaveServer memory and then have the save server save it to the user/profiles json
            this.saveServer.addProfile(profile);
            this.saveServer.saveProfile(profileId);
            this.logger.info(`[${this.modName}] Restored ${profileFile} to ${profileId} (${profileUsername})`);

            // Move the restored file to the "RestoredProfiles" folder
            this.fileSystem.copy(profileFilepath, `${restoredProfilePath}${profileFile}`);
            this.fileSystem.remove(profileFilepath);
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

        // Get all the json files in the folder and sort them by creation time
        const fileList = this.fileSystem
            .getFiles(folderPath, true, ["json"], true)
            .sort((a, b) => fs.statSync(a).ctimeMs - fs.statSync(b).ctimeMs);
        let delCount = 0;

        this.logger.debug(`[${this.modName}] Found ${fileList.length} files in the folder`);

        // If the number of files in the folder is greater than the maxFiles, delete the oldest files until the count is less than maxFiles
        while (fileList.length && fileList.length > maxFiles) {
            this.logger.debug(`[${this.modName}] Deleting ${fileList[0]}`);
            const lastFile = fileList[0];
            this.fileSystem.remove(lastFile);
            fileList.splice(0, 1);
            delCount++;
        }

        return delCount;
    }
}

module.exports = { mod: new Mod() };
