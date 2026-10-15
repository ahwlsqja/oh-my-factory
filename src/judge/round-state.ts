import type { ImplementerFeedback } from "../feedback/release.js";
import type { buildRoundImages, RoundScenario, RoundVerdict } from "./round.js";

/** The per-round SUT and harness images, whatever `buildRoundImages` returns. */
export type RoundLease = Awaited<ReturnType<typeof buildRoundImages>>;

/**
 * What S4 leaves for S5 and S6 of the same round (spec §5.5). In memory only: a restart re-enters from S1, so
 * a station that finds it missing stops with `station_error`. S5 sets `flawed_signal` (gate verdict not GREEN, prove-test
 * not PROVEN, or an audit flag); S6 then does not spend the test split.
 */
export interface RoundState {
  round: number;
  candidate_sha: string;
  lease: RoundLease;
  /** The contract's `run` argv this round was judged with; S6 judges the test split with the same one. */
  run: readonly string[];
  train: RoundVerdict;
  test: RoundVerdict | null;
  trainDigest: string;
  testDigest: string;
  /** Every active scenario of the standing set, both splits, so S6 needs no second vault read. */
  scenarios: readonly RoundScenario[];
  flawed_signal: boolean;
}

/** S6 to S3: the masked feedback of a released round, and every text released so far (the audit's `feedback` surface). */
export interface FeedbackSlot {
  put(feedback: ImplementerFeedback, text: string): void;
  take(): ImplementerFeedback | null;
  released(): readonly string[];
}

export function createFeedbackSlot(): FeedbackSlot {
  let pending: ImplementerFeedback | null = null;
  const texts: string[] = [];
  return {
    put(feedback, text) {
      pending = feedback;
      texts.push(text);
    },
    take() {
      const taken = pending;
      pending = null;
      return taken;
    },
    released: () => [...texts],
  };
}

/** The current round state and every image lease this line still owns; a lease is held the moment it exists, so a failed round still gets cleaned. */
export class RoundHolder {
  #state: RoundState | null = null;
  readonly #leases: RoundLease[] = [];

  hold(lease: RoundLease): void {
    this.#leases.push(lease);
  }

  /** Hands over every lease still held, oldest first, and forgets them. */
  drain(): RoundLease[] {
    return this.#leases.splice(0);
  }

  begin(state: RoundState): void {
    this.#state = state;
  }

  current(): RoundState | null {
    return this.#state;
  }

  clear(): void {
    this.#state = null;
  }
}
