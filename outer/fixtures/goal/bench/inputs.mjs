// The fixed input set both metrics run over. Editing it changes what is measured, so bench/ is watched.
export const LIST = Array.from({ length: 256 }, (_, i) => i * 3);
// Every fifth entry, plus three keys that are not in the list.
export const KEYS = [...LIST.filter((_, i) => i % 5 === 0), 1, 2, 4];
