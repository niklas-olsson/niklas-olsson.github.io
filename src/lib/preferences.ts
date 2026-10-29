// SPDX-License-Identifier: Apache-2.0

export type ThemeId = "obsidian" | "grove" | "daylight";

export interface Preferences {
  theme: ThemeId;
  /** Background opacity only. Text and controls remain fully opaque. */
  opacity: number;
  blur: boolean;
  fontSize: number;
  reduceMotion: boolean;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  swatches: string[];
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Charcoal surfaces with a soft mint accent.",
    swatches: ["#101816", "#1B2924", "#A7D9BD", "#EAF3ED"],
  },
  {
    id: "grove",
    name: "Grove",
    description: "Deep moss, leaf green, and warm natural light.",
    swatches: ["#172015", "#273522", "#C6DB8A", "#F0F2DE"],
  },
  {
    id: "daylight",
    name: "Daylight",
    description: "Warm ivory with clear forest green details.",
    swatches: ["#F0F0E6", "#FAFBF3", "#356146", "#25392D"],
  },
];

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: "obsidian",
  opacity: 0.88,
  blur: true,
  fontSize: 14,
  reduceMotion: false,
});

export const PREFERENCES_STORAGE_KEY = "terrarium.preferences.v1";

interface ReadableStorage {
  getItem(key: string): string | null;
}

interface WritableStorage {
  setItem(key: string, value: string): void;
}

function ownValue(value: object, key: keyof Preferences): unknown {
  // Only accept data owned by this object. Accessors and inherited values do
  // not become preferences, even when called with something other than JSON.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Validate stored or imported preferences without accepting extra properties. */
export function normalizePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_PREFERENCES };
  }

  const theme = ownValue(value, "theme");
  const blur = ownValue(value, "blur");
  const reduceMotion = ownValue(value, "reduceMotion");

  return {
    theme:
      theme === "obsidian" || theme === "grove" || theme === "daylight"
        ? theme
        : DEFAULT_PREFERENCES.theme,
    opacity: boundedNumber(
      ownValue(value, "opacity"),
      DEFAULT_PREFERENCES.opacity,
      0.7,
      1,
    ),
    blur: typeof blur === "boolean" ? blur : DEFAULT_PREFERENCES.blur,
    fontSize: Math.round(
      boundedNumber(
        ownValue(value, "fontSize"),
        DEFAULT_PREFERENCES.fontSize,
        12,
        20,
      ),
    ),
    reduceMotion:
      typeof reduceMotion === "boolean"
        ? reduceMotion
        : DEFAULT_PREFERENCES.reduceMotion,
  };
}

/** Storage can be injected for tests; browser storage is always optional. */
export function loadPreferences(storage?: ReadableStorage): Preferences {
  try {
    const target =
      storage ??
      (typeof window !== "undefined" ? window.localStorage : undefined);
    const raw = target?.getItem(PREFERENCES_STORAGE_KEY);
    return raw
      ? normalizePreferences(JSON.parse(raw))
      : { ...DEFAULT_PREFERENCES };
  } catch {
    // Private browsing, denied storage, invalid JSON, and quota policies must
    // never prevent the playground from opening.
    return { ...DEFAULT_PREFERENCES };
  }
}

/** False means the current appearance can be used but was not persisted. */
export function savePreferences(
  preferences: unknown,
  storage?: WritableStorage,
): boolean {
  try {
    const target =
      storage ??
      (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!target) return false;
    target.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalizePreferences(preferences)),
    );
    return true;
  } catch {
    return false;
  }
}
