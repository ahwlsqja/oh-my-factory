// The change that closes the gap: look at the middle first and keep halving the range.
// The answers are exactly the same as the linear version; only the number of comparisons drops.
export function search(list, key, probe = () => {}) {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    probe();
    if (list[middle] === key) return middle;
    if (list[middle] < key) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}
