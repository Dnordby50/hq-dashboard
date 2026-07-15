import { useEffect, useRef, useState } from 'react';
import { useOnline } from '../../lib/useOnline';
import {
  fetchAddressSuggestions,
  placesConfigured,
  resolveAddressSuggestion,
  type AddressSuggestion,
  type ResolvedAddress,
} from '../../lib/places';

// The Address 1 input with Google Places suggestions layered on top. The
// input itself is always a plain controlled input: no key, offline, or any
// Places failure just means the list never opens and the rep types the
// address by hand (the estimator's normal offline state at a job site).
// Selecting a suggestion fills street + city + state + zip via onResolve;
// every field stays hand-editable after.
export default function AddressAutocomplete({
  value,
  onChange,
  onResolve,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onResolve: (r: ResolvedAddress) => void;
  placeholder?: string;
}) {
  const online = useOnline();
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  // Only a keystroke may open the list: without this, prefilled or
  // autocomplete-filled values would pop suggestions on mount / after a pick.
  const typedRef = useRef(false);

  useEffect(() => {
    if (!typedRef.current) return;
    if (!placesConfigured || !online || value.trim().length < 4) {
      setItems([]);
      setOpen(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      const found = await fetchAddressSuggestions(value.trim());
      if (!alive) return;
      setItems(found);
      setOpen(found.length > 0);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [value, online]);

  const pick = async (s: AddressSuggestion) => {
    typedRef.current = false;
    setOpen(false);
    setItems([]);
    // Optimistic: the suggestion's main text is the street line; the resolve
    // then upgrades it (and city/state/zip) from the address components.
    onChange(s.main || value);
    const resolved = await resolveAddressSuggestion(s.prediction);
    if (resolved) onResolve(resolved);
  };

  return (
    <div className="addr-ac">
      <input
        value={value}
        onChange={(e) => {
          typedRef.current = true;
          onChange(e.target.value);
        }}
        onBlur={() => setOpen(false)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && items.length > 0 && (
        <div className="addr-ac-list" role="listbox">
          {items.map((s) => (
            <button
              type="button"
              key={s.id}
              className="addr-ac-item"
              role="option"
              // onMouseDown so the pick beats the input's blur (which closes
              // the list); preventDefault keeps focus in the field.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              <span className="addr-ac-main">{s.main}</span>
              {s.secondary && <span className="addr-ac-sec">{s.secondary}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
