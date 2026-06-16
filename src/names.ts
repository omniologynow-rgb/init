/** Auto-generated agent display names: claude-{adjective}-{noun}-{4digits}. */

const ADJECTIVES = [
  "swift", "clever", "bold", "quiet", "lucky", "cosmic", "neon", "feral",
  "gilded", "rogue", "stoic", "witty", "lunar", "amber", "brisk", "sly",
];
const NOUNS = [
  "pelican", "otter", "comet", "raven", "fox", "lynx", "heron", "moth",
  "badger", "quokka", "ember", "vortex", "pixel", "marlin", "wombat", "finch",
];

/**
 * Generate a fun default display name. `rand` is injectable for deterministic
 * tests; defaults to Math.random.
 */
export function generateDisplayName(rand: () => number = Math.random): string {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  const digits = String(Math.floor(rand() * 10000)).padStart(4, "0");
  return `claude-${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}
