// Shared types for the reporting scheduler — a TypeScript rewrite of the
// "ProduuzitAPI" Power Automate solution (see ProduuzitAPI_1_0_0_6/ for the original).

export type Frequency = "Dagelijks" | "Wekelijks" | "Maandelijks";

// One row of the "Produuzit_API_frequentie" SharePoint list (CSV export).
export interface ScheduleEntry {
  endpoint: string;        // Produuzit API path, e.g. "overview/production/"
  active: boolean;         // "In werking"
  frequency: Frequency;    // "Type frequentie"
  weekdays: string[];      // "Dag van de week" — Dutch day names, e.g. ["Maandag"]
  dayOfMonth: number | null; // "Dag van de maand"
  conditions: string;      // "Voorwaarden" — reserved; the original flows never evaluate it
  lastRun: string;         // "Laatste run" — informational, from the config source
  storagePath: string;     // "Opslaglocatie" — relative output folder
  overwrite: boolean;      // "Overschrijven" — replace instead of timestamping
}

export interface EndpointRunResult {
  endpoint: string;
  matched: boolean;        // false when the schedule did not fire today
  status: "skipped" | "ok" | "error";
  reason?: string;
  file?: string;           // relative path of the written file
  itemCount?: number;
}

export interface CycleResult {
  startedAt: string;
  finishedAt: string;
  entriesMatched: number;
  entriesSucceeded: number;
  entriesFailed: number;
  runs: EndpointRunResult[];
}
