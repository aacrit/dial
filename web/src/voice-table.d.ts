// The projected voice table (scripts/lib/voice-table.mjs), served at build time.
declare module "virtual:dial-voice-table" {
  export const voices: readonly {
    id: string;
    sex: string;
    accent: string;
    grade: string;
    wpm_as_played: number;
    median_f0_hz: number;
    spectral_centroid_hz: number;
  }[];
}
