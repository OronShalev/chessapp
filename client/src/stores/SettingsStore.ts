import { create } from "zustand";
import { produce } from "immer";
import { cloneDeep, merge } from "lodash-es";
import z from "zod";

import EngineVersion from "shared/constants/EngineVersion";
import EngineArrowType from "@analysis/constants/EngineArrowType";
import LocalStorageKey from "@/constants/LocalStorageKey";

const settingsSchema = z.object({
    analysis: z.object({
        engine: z.object({
            enabled: z.boolean(),
            version: z.enum(EngineVersion),
            depth: z.number().min(10).max(99),
            timeLimitEnabled: z.boolean(),
            timeLimit: z.number().min(0.01),
            lines: z.number().min(1).max(5),
            threads: z.number().min(1).max(64),
            engineCount: z.union([
                z.literal(1),
                z.literal(2),
                z.literal(4),
                z.literal(8),
                z.literal(16)
            ]),
            suggestionArrows: z.enum(EngineArrowType)
        }),
        classifications: z.object({
            hide: z.boolean(),
            included: z.object({
                brilliant: z.boolean(),
                critical: z.boolean(),
                theory: z.boolean()
            })
        }),
        simpleNotation: z.boolean()
    }),
    themes: z.object({
        board: z.object({
            darkSquareColour: z.string().regex(/^#.{6}$/),
            lightSquareColour: z.string().regex(/^#.{6}$/)
        }),
        piece: z.string()
    }),
    bugReportingMode: z.boolean()
});

type Settings = z.infer<typeof settingsSchema>;
type SettingsReducer = (settings: Settings) => Settings;

export const defaultSettings: Settings = {
    analysis: {
        engine: {
            enabled: true,
            version: EngineVersion.STOCKFISH_19_LITE,
            depth: 16,
            lines: 2,
            timeLimitEnabled: false,
            timeLimit: 1,
            threads: 4,
            engineCount: 4,
            suggestionArrows: EngineArrowType.DISABLED
        },
        classifications: {
            hide: false,
            included: {
                brilliant: true,
                critical: true,
                theory: true
            }
        },
        simpleNotation: false
    },
    themes: {
        board: {
            darkSquareColour: "#b58863",
            lightSquareColour: "#f0d9b5"
        },
        piece: ""
    },
    bugReportingMode: false
};

const ENGINE_COUNTS = [1, 2, 4, 8, 16] as const;

function fetchSettings() {
    const value = localStorage.getItem(LocalStorageKey.SETTINGS);

    const defaultSettingsCopy = cloneDeep(defaultSettings);

    if (value == null) return defaultSettingsCopy;

    try {
        const settings = merge(defaultSettingsCopy, JSON.parse(value));

        // Migrate engine counts saved before the 1/2/4/8/16 options existed
        // to the nearest valid value, so the dropdown always has a match.
        if (!ENGINE_COUNTS.includes(settings.analysis.engine.engineCount)) {
            settings.analysis.engine.engineCount = ENGINE_COUNTS.reduce(
                (closest, count) => (
                    Math.abs(count - settings.analysis.engine.engineCount)
                    < Math.abs(closest - settings.analysis.engine.engineCount)
                        ? count : closest
                ),
                ENGINE_COUNTS[0]
            );
        }

        return settings;
    } catch {
        return defaultSettingsCopy;
    }
}

interface SettingsStore {
    settings: Settings;
    setSettings: (updater: SettingsReducer) => void;
}

const useSettingsStore = create<SettingsStore>((set, get) => ({
    settings: fetchSettings(),

    setSettings(updater) {
        const newSettings = produce(get().settings, updater);

        set({ settings: newSettings });

        localStorage.setItem(
            LocalStorageKey.SETTINGS,
            JSON.stringify(newSettings)
        );
    }
}));

export default useSettingsStore;