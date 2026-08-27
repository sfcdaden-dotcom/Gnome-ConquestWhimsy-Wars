/**
 * The layer categories, and where their art lives.
 *
 * Adding a part is dropping a PNG into one of these folders and running
 * `npm run art`. Nothing else — the id, the label, the engine's catalogue and
 * the picker's buttons are all derived from the file.
 */

export const PARTS_DIR = 'src/assets/art/parts';

/**
 * Draw order, bottom to top. The weapon goes UNDER the body on purpose: the
 * beard then overlaps the shaft, which reads as the gnome holding it rather
 * than standing next to it.
 */
export const LAYERS = [
  {
    id: 'weapon',
    dir: 'weapon',
    label: 'Weapon',
    /** Rendered beneath the body. */
    order: 0,
    optional: false,
  },
  { id: 'base', dir: 'base', label: 'Body', order: 1, optional: false, fixed: true },
  { id: 'beard', dir: 'beard', label: 'Beard', order: 2, optional: false },
  { id: 'cap', dir: 'cap', label: 'Cap', order: 3, optional: false },
  /** The one slot a gnome may leave empty — hence the synthetic 'none' id. */
  { id: 'accessory', dir: 'accessory', label: 'Extra', order: 4, optional: true },
];

/** The id every optional layer offers for "wearing nothing". Never a file. */
export const NONE_ID = 'none';

/**
 * Layers a player chooses from, in the order the picker shows them. `base` is
 * excluded: every gnome has the same body, so offering it as a choice would be
 * a menu with one item.
 */
export const CHOOSABLE = LAYERS.filter((l) => !l.fixed);
