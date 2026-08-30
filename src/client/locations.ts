import type { CameraIndex } from "#/client/detection";

/**
 * Turn a place name into camera ids.
 *
 * The console has no idea where anything is. It knows `Portail` and `Jardin`
 * are cameras; it does not know both are outdoors, that only one faces the
 * street, or that "the front of the house" means three of them and not the
 * fourth. That is local knowledge, so it lives in configuration
 * (UNIFI_PROTECT_LOCATIONS) rather than being guessed from names — a guess here
 * silently searches the wrong cameras and reports a confident empty result.
 */
export type LocationResolution = {
  ids: string[];
  /** Configured entries that matched no camera, so a typo is visible. */
  unmatched: string[];
};

export const availableLocations = (locations: Record<string, string[]>): string[] =>
  Object.keys(locations).toSorted();

export const resolveLocation = (
  location: string,
  locations: Record<string, string[]>,
  cameras: CameraIndex,
): LocationResolution => {
  const key = Object.keys(locations).find((k) => k.toLowerCase() === location.toLowerCase());
  if (key === undefined) {
    const known = availableLocations(locations);
    throw new Error(
      `Unknown location "${location}". ` +
        (known.length > 0
          ? `Configured locations: ${known.join(", ")}.`
          : "No locations are configured. Set UNIFI_PROTECT_LOCATIONS, e.g. " +
            '{"front":["Carillon","Portail"]}, or pass cameraIds directly.'),
    );
  }

  const byName = new Map<string, string>();
  for (const [id, facts] of cameras) byName.set(facts.name.toLowerCase(), id);

  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const entry of locations[key] ?? []) {
    // An entry may be an id or a name; ids win, so a camera literally named
    // like an id still resolves predictably.
    if (cameras.has(entry)) {
      ids.push(entry);
      continue;
    }
    const id = byName.get(entry.trim().toLowerCase());
    if (id) ids.push(id);
    else unmatched.push(entry);
  }

  return { ids: [...new Set(ids)], unmatched };
};
