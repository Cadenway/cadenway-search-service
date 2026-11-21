/** Result of one bounded generation coordinator step. */
export type RebuildSearchIndexStepOutput =
  'created' | 'abandoned' | 'progressed' | 'promoted' | 'waiting' | 'idle';
