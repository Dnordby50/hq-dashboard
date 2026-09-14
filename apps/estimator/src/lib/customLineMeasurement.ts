import type { RecipeSlot, SystemType } from './calculator';

// The catalog's manually priced Custom System keeps its percentage labor
// model. It needs no area measurement while its recipe contains no products;
// a future product recipe or an added moisture barrier must still be costed
// from real square footage.
export function customSystemMeasurementOptional(
  system: Pick<SystemType, 'name'> | undefined,
  slots: Pick<RecipeSlot, 'slot_kind'>[],
  mvb: boolean,
): boolean {
  return !mvb && system?.name.trim().toLowerCase() === 'custom system'
    && slots.every(slot => slot.slot_kind === 'text' || slot.slot_kind === 'choice');
}
