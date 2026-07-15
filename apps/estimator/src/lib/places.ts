// Google Places address autocomplete (build 23, phase 1), via the CURRENT
// Places JS surface (AutocompleteSuggestion / Place.fetchFields), not the
// deprecated Autocomplete widget. Data-API-over-widget so the Address 1 field
// stays OUR plain input: the estimator's normal habitat is offline at a job
// site, where autocomplete cannot work, so the input must be fully usable
// typed by hand and the suggestions are strictly an online enhancement.
//
// The key is a build-time env var (VITE_GOOGLE_MAPS_KEY). No key baked in:
// per CLAUDE.md rule 7 a client Maps key may only ship HTTP-referrer- and
// API-restricted and listed in netlify.toml's secret-scan omit values, none
// of which exist yet. Absent key = everything below degrades to "no
// suggestions" and the form works exactly as before.

const KEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) ?? '';

export const placesConfigured = KEY !== '';

export type AddressSuggestion = {
  id: string;
  main: string;
  secondary: string;
  prediction: unknown;
};

export type ResolvedAddress = {
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
};

// Loose typing on purpose: the Maps JS API is loaded at runtime from Google
// and we use four symbols of it; pulling in @types/google.maps for that would
// pin us to their release cadence.
/* eslint-disable @typescript-eslint/no-explicit-any */
type MapsWindow = Window & { google?: any; __pecMapsReady?: () => void };

let loadPromise: Promise<boolean> | null = null;

// Inject the Maps JS script once (loading=async per Google's guidance), then
// import the places library. Resolves false instead of throwing so callers
// can silently degrade; a failed load (offline, bad key, blocked) resets the
// promise so a later attempt, e.g. after signal returns, retries.
function loadPlaces(): Promise<boolean> {
  if (!KEY || typeof document === 'undefined') return Promise.resolve(false);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<boolean>((resolve) => {
    const w = window as MapsWindow;
    if (w.google?.maps?.importLibrary) {
      resolve(true);
      return;
    }
    w.__pecMapsReady = () => resolve(true);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&v=weekly&loading=async&callback=__pecMapsReady`;
    s.async = true;
    s.onerror = () => {
      s.remove();
      resolve(false);
    };
    document.head.appendChild(s);
  })
    .then(async (ok) => {
      if (!ok) return false;
      try {
        await (window as MapsWindow).google.maps.importLibrary('places');
        return true;
      } catch {
        return false;
      }
    })
    .then((ok) => {
      if (!ok) loadPromise = null;
      return ok;
    });
  return loadPromise;
}

// One session token per typing burst, cleared when a pick resolves: Google
// bills a session (N keystrokes + 1 details fetch) as a unit, and a stale
// token after a selection would bill every later keystroke individually.
let sessionToken: unknown = null;

export async function fetchAddressSuggestions(input: string): Promise<AddressSuggestion[]> {
  if (!(await loadPlaces())) return [];
  try {
    const places = await (window as MapsWindow).google.maps.importLibrary('places');
    if (!sessionToken) sessionToken = new places.AutocompleteSessionToken();
    const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input,
      sessionToken,
      includedRegionCodes: ['us'],
    });
    return ((suggestions ?? []) as any[])
      .filter((s) => s.placePrediction)
      .map((s, i) => ({
        id: String(s.placePrediction.placeId ?? i),
        main: String(s.placePrediction.mainText ?? s.placePrediction.text ?? ''),
        secondary: String(s.placePrediction.secondaryText ?? ''),
        prediction: s.placePrediction,
      }));
  } catch {
    return [];
  }
}

// Selecting a suggestion fetches the place's address components and maps them
// onto the form's split fields. street_number + route -> Address 1 (a unit in
// the pick itself, subpremise, lands in Address 2); state uses the short code
// (AZ). Null on any failure so the caller falls back to the typed text.
export async function resolveAddressSuggestion(prediction: unknown): Promise<ResolvedAddress | null> {
  try {
    const place = (prediction as any).toPlace();
    await place.fetchFields({ fields: ['addressComponents'] });
    sessionToken = null;
    const comps: any[] = place.addressComponents ?? [];
    const get = (type: string, short = false): string => {
      const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(type));
      return c ? String((short ? c.shortText : c.longText) ?? '') : '';
    };
    return {
      address1: [get('street_number'), get('route')].filter(Boolean).join(' '),
      address2: get('subpremise'),
      city: get('locality') || get('postal_town') || get('sublocality') || get('administrative_area_level_3'),
      state: get('administrative_area_level_1', true),
      zip: get('postal_code'),
    };
  } catch {
    return null;
  }
}
