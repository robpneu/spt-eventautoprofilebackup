export interface ModConfig {
    Enabled: boolean;
    BackupSavedLog: boolean;
    MaximumBackupDeleteLog: boolean;
    MaximumBackupPerProfile: number;
    MaximumRestoredDeleteLog: boolean;
    MaximumRestoredFiles: number;
    AutoBackupEvents: AutoBackupEvent[];
}

export interface AutoBackupEvent {
    Enabled: boolean;
    Name: string;
    Route: string;
}
