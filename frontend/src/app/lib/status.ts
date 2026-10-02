import { MinerStatus } from '../models';

/**
 * The three modes a miner can be in. The backend decides the mode; these are
 * only the words and colours the page uses for it.
 */
export const STATUS_LABEL: Record<MinerStatus, string> = {
  hashing: 'Connected and hashing',
  'not-submitting': 'Hashing, not submitting shares',
  'not-hashing': 'Not hashing, go to miner settings',
};

/** Shorter label for the settings page, where the settings are already open. */
export const STATUS_SHORT: Record<MinerStatus, string> = {
  hashing: 'Connected and hashing',
  'not-submitting': 'Hashing, not submitting shares',
  'not-hashing': 'Not hashing',
};
