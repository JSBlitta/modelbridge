import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

export interface AppConfig {
  defaults: {
    client_name: string;
    batch_name_pattern: string;
    batch_name_pattern_phase_vbw: string;
    batch_state: string;
  };
  synonyms: Record<string, string[]>;
  description_to_suffix: Record<string, string>;
  client_meta_defaults: Record<string, string[]>;
}

const CONFIG_PATH = resolve(process.cwd(), "config.yaml");

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = YAML.parse(raw);
  _config = {
    defaults: {
      client_name: parsed?.defaults?.client_name ?? "BLITTA",
      batch_name_pattern: parsed?.defaults?.batch_name_pattern ?? "3 digits",
      batch_name_pattern_phase_vbw: parsed?.defaults?.batch_name_pattern_phase_vbw ?? "{number}{suffix}-{phase}",
      batch_state: parsed?.defaults?.batch_state ?? "provisional",
    },
    synonyms: {
      stdlib: ["stdlib", "standard_library", "std_lib", "stdlibs"],
      ...(parsed?.synonyms ?? {}),
    },
    description_to_suffix: parsed?.description_to_suffix ?? {},
    client_meta_defaults: parsed?.client_meta_defaults ?? {},
  };
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) return loadConfig();
  return _config;
}
