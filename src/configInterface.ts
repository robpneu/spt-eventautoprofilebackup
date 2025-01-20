export interface ModConfig {
    Enabled: boolean;
    BackupSavedLog: boolean;
    MaximumBackupDeleteLog: boolean;
    MaximumBackupPerProfile: number;
    MaximumRestoredBackupFiles: number;
    AutoBackupEvents: AutoBackupEvent[];
}

export interface AutoBackupEvent {
    Enabled: boolean;
    Name: string;
    Route: string;
}
