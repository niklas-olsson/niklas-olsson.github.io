// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  loadPreferences,
  normalizePreferences,
  savePreferences,
} from "./preferences.ts";

test("corrupted, missing, and inaccessible storage use independent defaults", () => {
  for (const raw of [null, "", "{broken", "null", "[]", '"grove"']) {
    const result = loadPreferences({ getItem: () => raw });
    assert.deepEqual(result, DEFAULT_PREFERENCES);
    assert.notEqual(result, DEFAULT_PREFERENCES);
  }
  assert.deepEqual(
    loadPreferences({
      getItem: () => {
        throw new Error("Storage denied");
      },
    }),
    DEFAULT_PREFERENCES,
  );
});

test("untrusted values cannot escape allowed themes, numeric bounds, or boolean types", () => {
  assert.deepEqual(
    normalizePreferences({
      theme: "unknown",
      opacity: -2,
      blur: "true",
      fontSize: 90,
      reduceMotion: 1,
      unexpected: "ignored",
    }),
    { ...DEFAULT_PREFERENCES, opacity: 0.7, fontSize: 20 },
  );

  assert.deepEqual(
    normalizePreferences({ opacity: Infinity, fontSize: NaN }),
    DEFAULT_PREFERENCES,
  );
  assert.equal(normalizePreferences({ opacity: 3 }).opacity, 1);
  assert.equal(normalizePreferences({ fontSize: 4 }).fontSize, 12);
  assert.equal(normalizePreferences({ fontSize: 16.8 }).fontSize, 17);
});

test("inherited values and accessor properties are never read as preferences", () => {
  const value = Object.create({ theme: "daylight", opacity: 0.7, blur: false });
  Object.defineProperty(value, "fontSize", {
    get() {
      throw new Error("Must not run");
    },
  });
  Object.defineProperty(value, "reduceMotion", {
    value: true,
    enumerable: true,
  });
  assert.deepEqual(normalizePreferences(value), {
    ...DEFAULT_PREFERENCES,
    reduceMotion: true,
  });
});

test("a valid appearance survives save and reload under its versioned key", () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
  const preferences = {
    theme: "daylight",
    opacity: 0.76,
    blur: false,
    fontSize: 18,
    reduceMotion: true,
  } as const;
  assert.equal(savePreferences(preferences, storage), true);
  assert.ok(entries.has(PREFERENCES_STORAGE_KEY));
  assert.deepEqual(loadPreferences(storage), preferences);
});

test("failed persistence is reported instead of throwing or claiming success", () => {
  assert.equal(
    savePreferences(DEFAULT_PREFERENCES, {
      setItem: () => {
        throw new Error("Quota exceeded");
      },
    }),
    false,
  );
});
