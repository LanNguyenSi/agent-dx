/** Value sets shared by more than one format. */

/** Where an answer to a question came from. */
export const ANSWER_CHANNELS = ["file", "chat", "comment"] as const;
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number];

/**
 * Classes of an open point that needs a person: a wrong guess changes the
 * result (`divergence`), the project has no prior (`blind-spot`), or the
 * line cannot be turned into any kind of check (`untestable`). A point
 * with a right answer is a default, not an open point.
 */
export const OPEN_POINT_CLASSES = [
  "divergence",
  "blind-spot",
  "untestable",
] as const;
export type OpenPointClass = (typeof OPEN_POINT_CLASSES)[number];
